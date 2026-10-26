import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InvoiceStatus, SubscriptionStatus } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import {
  platformScope,
  runForTenant,
  tenantContext,
} from '../../common/tenant/tenant-context';
import { BILLING_QUEUE } from '../../common/queue/queue.constants';
import { QueueService } from '../queue/queue.service';
import { InvoiceService } from '../billing/invoice.service';
import { hasService } from '../billing/subscription-state';
import { PaymentService } from './payment.service';

/** 提前几天生成账单 */
export const INVOICE_LEAD_DAYS = 3;

/** 扫描的间隔（一天） */
const SCAN_INTERVAL_MS = 24 * 3600 * 1000;

/**
 * 续费的每日扫描：生成账单 + 尝试自动扣款。
 *
 * ⚠️ **这个服务在 `payment` 模块里**，不在 `billing` 里 ——
 * 它要调渠道（`chargeAuthorized`），而 `billing` 一旦依赖 `payment`
 * 就会与 `order → billing` 构成**模块依赖的环**
 * （`order → billing → payment → order`），NestJS 启动直接报错。
 *
 * ⚠️ **扫描在平台作用域下做**（要扫所有租户的订阅），
 * **写操作在租户作用域下做**（账与支付单都是租户的数据）。
 * 两者的切换用 `runForTenant`。
 */
@Injectable()
export class RenewalService implements OnModuleInit {
  private readonly logger = new Logger(RenewalService.name);

  constructor(
    private readonly prisma: TenantPrismaService,
    // ⚠️ **`billing → payment` 是被禁止的方向**，所以这里是
    // `payment → billing`（单向）—— 账目的事问 billing 要。
    private readonly invoices: InvoiceService,
    private readonly payments: PaymentService,
    private readonly queue: QueueService,
  ) {}

  /**
   * 注册每日扫描的周期性任务。
   *
   * ⚠️ **固定 jobSchedulerId**：`billing-scan`。BullMQ 的作业调度器按它去重，
   * 重复注册是覆盖而不是叠加 —— 否则每次重启应用都会多一个扫描任务。
   */
  async onModuleInit(): Promise<void> {
    await this.queue.addRepeating(
      BILLING_QUEUE,
      'scan',
      {},
      SCAN_INTERVAL_MS,
      'billing-scan',
    );
  }

  /**
   * 扫一遍：找出「周期开始前 3 天内到期」的订阅，逐个处理。
   */
  async scan(): Promise<void> {
    const now = await this.prisma.databaseNow();
    const lead = new Date(now.getTime() + INVOICE_LEAD_DAYS * 24 * 3600 * 1000);

    // ⚠️ **平台作用域下扫** —— 要找所有租户的订阅
    //
    // ⚠️ **回调必须是 async 函数**：Prisma 6 的 query 返回 PrismaPromise
    // （thenable 而非原生 Promise），同步回调会让上下文在 SQL 执行时丢失，
    // 租户作用域整个失效（见 `common/tenant/tenant-context.ts` 的注释）。
    const due = await tenantContext.run(platformScope(), async () =>
      this.prisma.subscription.findMany({
        where: {
          status: { in: [SubscriptionStatus.TRIAL, SubscriptionStatus.ACTIVE] },
          currentPeriodEnd: { lte: lead },
          cancelAtPeriodEnd: false,
        },
      }),
    );

    for (const subscription of due) {
      // ⚠️ **写操作回到租户作用域** —— 租户 id 来自库里（可信源），
      // 不是客户端提交的
      await runForTenant(subscription.tenantId, async () => {
        await this.renewOne(subscription.id);
      });
    }
  }

  /** 给一个订阅生成下一期的账单并尝试自动扣款 */
  private async renewOne(subscriptionId: string): Promise<void> {
    const subscription = await this.prisma.subscription.findFirst({
      where: { id: subscriptionId },
    });
    if (!subscription) return;

    // ⚠️ **账单按「待生效的套餐」出**：这张账单覆盖的是**下一个周期**，
    // 而下一个周期跑的是 pendingPlanId 那个套餐（markInvoicePaid 会把
    // planId 切成它）。按当前套餐出账的话，商家从 ¥99 的套餐换到 ¥299 的套餐，
    // 下一期只收 ¥99 —— 平台少收钱；反向换则是多收。
    const nextPlanId = subscription.pendingPlanId ?? subscription.planId;
    const plan = await this.prisma.plan.findFirst({
      where: { id: nextPlanId },
    });
    if (!plan) return;

    const now = await this.prisma.databaseNow();
    const dayMs = 24 * 3600 * 1000;

    // ⚠️ **下一个周期的边界**：从当前周期结束日开始
    const periodStart = subscription.currentPeriodEnd;
    const periodEnd = new Date(periodStart.getTime() + plan.periodDays * dayMs);

    const invoice = await this.invoices.generateInvoice({
      subscriptionId: subscription.id,
      tenantId: subscription.tenantId,
      planId: plan.id,
      periodStart,
      periodEnd,
      dueAt: periodStart,
    });

    if (!invoice) {
      // ⚠️ **`generateInvoice` 返回 null 有两种原因，处理方式完全不同**：
      //
      // 1. **免费周期不出账单**（套餐价格是 0）—— 试用到期要把状态转 EXPIRED
      // 2. **这个周期已经有账单了** —— 上一轮扣款失败了，这一轮是来**重试**的
      //
      // ⚠️ **不区分的话，自动续费就只会尝试一次**：上一轮扣款失败后
      // 账单留在 FAILED、周期没延长，下一轮扫描算出来的 `periodStart` 还是
      // 同一个 → `generateInvoice` 返回 null → **永远不再重试扣款**。
      const existing = await this.invoices.findInvoiceForPeriod(
        subscription.id,
        periodStart,
      );
      if (!existing) {
        // 免费周期（试用期）不出账单 —— 但**试用到期**要把状态转成 EXPIRED
        await this.expireIfNeeded(subscriptionId, now);
        return;
      }
      await this.chargeAndSettle(subscription, existing, now);
      return;
    }

    await this.chargeAndSettle(subscription, invoice, now);
  }

  /**
   * 扣款（能扣才扣）并把结果落到账单上。
   *
   * @param subscription 订阅行（用来找默认支付方式）
   * @param invoice 这一期的账单
   * @param now 数据库的当前时间
   */
  private async chargeAndSettle(
    subscription: { id: string; tenantId: string },
    invoice: { id: string; number: string; status: InvoiceStatus },
    now: Date,
  ): Promise<void> {
    // ⚠️ **已经付过的账单不重复扣**（护栏 M11）。
    // 它能出现在这里，是因为上一轮的扣款成功了、但订阅周期没延长
    // （或者扫描重入）。
    if (
      invoice.status !== InvoiceStatus.OPEN &&
      invoice.status !== InvoiceStatus.FAILED
    ) {
      await this.expireIfNeeded(subscription.id, now);
      return;
    }

    // ⚠️ **自动扣款**：有绑定的支付方式才扣
    const method = await this.prisma.paymentMethod.findFirst({
      where: { tenantId: subscription.tenantId, isDefault: true },
    });
    if (!method) {
      // 没有支付方式 → 账单挂着，等商家手动付
      this.logger.warn(
        `订阅 ${subscription.id} 没有绑定的支付方式，账单 ${invoice.number} 等待商家手动支付`,
      );
      // ⚠️ **周期过了又没付 → 订阅该过期**（与 `hasService` 同一口径）
      await this.expireIfNeeded(subscription.id, now);
      return;
    }

    // ⚠️ **自动扣款**：走的是「已授权的支付方式直接扣」那条路
    // （`chargeAuthorized` 同步返回结果，不跳页面）
    const result = await this.payments.chargeInvoice(
      invoice.number,
      method.channel,
      method.token,
    );
    if (result.status !== 'SUCCESS') {
      // ⚠️ **扣款失败 → 账单标 FAILED**，商家可以手动重试
      await this.prisma.invoice.updateMany({
        where: { id: invoice.id, status: InvoiceStatus.OPEN },
        data: { status: InvoiceStatus.FAILED },
      });
      // ⚠️ **周期过了又没付 → 订阅该过期**
      await this.expireIfNeeded(subscription.id, now);
      return;
    }
    // ⚠️ **付清 → 延长一个周期**（条件更新，重复处理不会延长两次）
    await this.invoices.markInvoicePaid(invoice.id);

    // ⚠️ **付清了也要判一次过期** —— 但用的是**重新查到的**订阅：
    // `markInvoicePaid` 刚刚把周期往后延了，用调用方手里那份旧数据
    // 会误判成「已经过期了」，把刚付清的订阅打成 EXPIRED。
    await this.expireIfNeeded(subscription.id, now);
  }

  /**
   * 试用到期（或周期结束且没付）时把订阅置 `EXPIRED`。
   *
   * ⚠️ **判定用数据库时钟**（护栏 M15）：多副本部署时各机器的时钟有偏差，
   * 边界时刻会摇摆。数据库的 `now()` 是单一事实来源。
   *
   * ⚠️ **判定口径与 `hasService` 一致**（复用 `subscription-state.ts` 的纯函数）：
   * 试用期看 `trialEndsAt`、正式期看 `currentPeriodEnd`，
   * 状态是 EXPIRED / CANCELLED 就不管。
   *
   * ⚠️ **必须重新查一次订阅**：调用方手里那份是**旧数据**——
   * 账单付清时 `markInvoicePaid` 已经把周期延长了，
   * 用旧数据会误判成「过期了」。
   *
   * ⚠️ **条件更新**：where 带原状态 —— 已经被人改过（比如手动续费成功了）
   * 的订阅不会被这里改回去。
   */
  private async expireIfNeeded(
    subscriptionId: string,
    now: Date,
  ): Promise<void> {
    const subscription = await this.prisma.subscription.findFirst({
      where: { id: subscriptionId },
    });
    if (!subscription) return;

    // ⚠️ **EXPIRED / CANCELLED 不管**：终态不该被这里改回去
    if (
      subscription.status === SubscriptionStatus.EXPIRED ||
      subscription.status === SubscriptionStatus.CANCELLED
    ) {
      return;
    }

    // ⚠️ **与 `hasService` 同一口径**：状态 + 时间双判。
    // `hasService` 为 true 说明还有服务 → 不用过期。
    const stillHasService = hasService(
      {
        status: subscription.status,
        trialEndsAt: subscription.trialEndsAt,
        currentPeriodEnd: subscription.currentPeriodEnd,
      },
      now,
    );
    if (stillHasService) {
      return;
    }

    await this.prisma.subscription.updateMany({
      where: { id: subscription.id, status: subscription.status },
      data: { status: SubscriptionStatus.EXPIRED },
    });
  }
}
