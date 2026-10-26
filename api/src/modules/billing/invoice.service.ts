import { Injectable, NotFoundException } from '@nestjs/common';
import {
  InvoiceStatus,
  SubscriptionStatus,
  type Invoice,
} from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { isUniqueViolation } from '../../common/errors/unique-constraint';
import type { PrismaTransaction } from '../../common/prisma/prisma-transaction';

/**
 * 账单与订阅周期。
 *
 * ⚠️ **同一周期只能有一张账单**（护栏 M5）：
 * `@@unique([subscriptionId, periodStart])` 兜底 —— 重复的续费回调
 * 撞唯一索引 → 不会让订阅期翻倍。
 *
 * ⚠️ **本模块不 import `payment`** —— 它一旦 import，
 * `order → billing → payment → order` 就成了环（NestJS 启动报错）。
 * 要碰支付渠道的事都在 `payment` 模块里。
 */
@Injectable()
export class InvoiceService {
  constructor(private readonly prisma: TenantPrismaService) {}

  /**
   * 生成某个周期的账单。
   *
   * ⚠️ **金额只从套餐价格读**（护栏 M9）：请求体不接受任何金额字段。
   * ⚠️ **免费周期不出账单**（试用期）：`price = 0` 的套餐不出账单。
   */
  async generateInvoice(input: {
    subscriptionId: string;
    tenantId: string;
    planId: string;
    periodStart: Date;
    periodEnd: Date;
    dueAt: Date;
  }): Promise<Invoice | null> {
    const plan = await this.prisma.plan.findFirst({
      where: { id: input.planId },
    });
    if (!plan) {
      throw new NotFoundException('套餐不存在');
    }
    // ⚠️ **免费周期不出账单** —— 出了也是 0 元，还会污染「待付账单」的列表
    if (plan.price === 0) {
      return null;
    }

    const now = await this.prisma.databaseNow();
    // ⚠️ **账单号撞了就换一个号重试**（不是放弃）。
    //
    // 账单号是秒级时间戳 + 4 位随机数 —— 同一秒内生成 10000 张才会撞一次，
    // 但撞了就撞了。撞 `(tenantId, number)` 与撞 `(subscriptionId, periodStart)`
    // 是**两回事**：
    //
    // - 撞 `(subscriptionId, periodStart)` → 这个周期已经有账单了 → 返回 null（幂等）
    // - 撞 `(tenantId, number)` → **只是号撞了** → 换一个号继续建
    //
    // ⚠️ 不区分的话，撞号会被**静默当成「这个周期已经有账单了」**返回 null，
    // 结果是**这个周期永远不出账单** —— 商家压根不知道自己该付这笔钱。
    const MAX_NUMBER_ATTEMPTS = 5;
    for (let attempt = 0; attempt < MAX_NUMBER_ATTEMPTS; attempt++) {
      try {
        return await this.prisma.invoice.create({
          data: {
            tenantId: input.tenantId,
            subscriptionId: input.subscriptionId,
            planId: plan.id,
            number: generateInvoiceNumber(now),
            amount: plan.price,
            status: InvoiceStatus.OPEN,
            periodStart: input.periodStart,
            periodEnd: input.periodEnd,
            dueAt: input.dueAt,
          },
        });
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
        // ⚠️ **P2002 在事务外处理**。这里撞的是 (subscriptionId, periodStart) ——
        // 说明这个周期已经有账单了，返回 null（幂等）而不是报错。
        if (!isInvoiceNumberViolation(error)) {
          return null;
        }
        // 账单号撞了 → 换个号再来一次（下次循环会生成新的随机数）
      }
    }
    // ⚠️ 连撞 5 次说明随机数有问题（或有别的进程在批量生成），
    // 此时抛错比「静默不出账单」好 —— 后者会让商家永远付不了款。
    throw new Error('生成账单号失败：连续多次撞上唯一索引');
  }

  /**
   * 找某个订阅在某个周期上的账单（没有就返回 null）。
   *
   * ⚠️ **用来区分 `generateInvoice` 返回 null 的两种原因**：
   * - 「这个周期已经有账单了」（上一轮扣款失败，要重试）
   * - 「免费周期不出账单」（套餐价格是 0）
   *
   * 两者都让 `generateInvoice` 返回 null，但**处理方式完全不同**。
   */
  async findInvoiceForPeriod(
    subscriptionId: string,
    periodStart: Date,
  ): Promise<Invoice | null> {
    const rows = await this.prisma.invoice.findMany({
      where: { subscriptionId, periodStart },
    });
    return rows[0] ?? null;
  }

  /**
   * 这个租户的账单列表（新的在前）。
   *
   * ⚠️ **租户作用域的 `findMany`** —— 扩展自动附加 tenantId 条件，
   * 不需要自己写 `where: { tenantId }`（写了也一样，但容易漏）。
   */
  async list(tenantId: string): Promise<{ items: Invoice[]; total: number }> {
    const items = await this.prisma.invoice.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { items, total: items.length };
  }

  /**
   * 账单付清 → 订阅期延长一个周期。
   *
   * ⚠️ **条件更新**：`updateMany` where 带 `status: OPEN`，
   * 受影响行数为 0 说明这张账单已经处理过了 —— **不重复延长**（护栏 M11）。
   *
   * ⚠️ **`FAILED` 也要放行**：`FAILED` 的语义是「上一次支付尝试失败了」，
   * 商家重试成功时账单就是从 `FAILED` 变成 `PAID`。不放行的话，
   * 商家手动付了钱、订阅却永远不过期（钱收了服务没开）。
   *
   * ⚠️ **幂等不受影响**：重复回调时账单已经是 `PAID` 了，
   * 条件更新仍然不命中 → 不会延长两次。
   */
  async markInvoicePaid(invoiceId: string): Promise<boolean> {
    // ⚠️ **两步写在同一个事务里**（账单转 PAID + 延长订阅期）。
    //
    // 分成两个事务的话，第二步失败（进程崩溃、连接断了）→
    // **钱收了、服务没开**。而且因为账单已经不是 `OPEN` 了，
    // 重试也修不回来（条件更新不命中）。
    //
    // ⚠️ `invoices` 与 `subscriptions` **都在租户作用域里**，
    // 所以事务客户端上的租户过滤照样生效（见阶段 5a 的 `reserveInTx`）。
    return this.prisma.$transaction(
      async (tx) => this.markInvoicePaidInTx(tx, invoiceId),
      { maxWait: 10_000, timeout: 10_000 },
    );
  }

  /**
   * 账单付清 → 订阅期延长一个周期（**在一个已开启的事务里**）。
   *
   * ⚠️ 供 `markInvoicePaid` 调用，也供将来「与别的写同生共死」的场景复用。
   */
  async markInvoicePaidInTx(
    tx: PrismaTransaction,
    invoiceId: string,
  ): Promise<boolean> {
    const now = await this.prisma.databaseNow();
    const affected = await tx.invoice.updateMany({
      where: {
        id: invoiceId,
        status: { in: [InvoiceStatus.OPEN, InvoiceStatus.FAILED] },
      },
      data: { status: InvoiceStatus.PAID, paidAt: now },
    });
    if (affected.count === 0) {
      return false;
    }

    const invoice = await tx.invoice.findFirst({
      where: { id: invoiceId },
    });
    if (!invoice) {
      return false;
    }

    const subscription = await tx.subscription.findFirst({
      where: { id: invoice.subscriptionId },
    });
    if (!subscription) {
      return false;
    }
    // ⚠️ **延长周期 + 让待生效的套餐在这里生效**
    const nextPlanId = subscription.pendingPlanId ?? subscription.planId;

    await tx.subscription.updateMany({
      where: { id: invoice.subscriptionId },
      data: {
        status: SubscriptionStatus.ACTIVE,
        planId: nextPlanId,
        pendingPlanId: null,
        currentPeriodStart: invoice.periodStart,
        currentPeriodEnd: invoice.periodEnd,
        trialEndsAt: null,
      },
    });
    return true;
  }
}

/**
 * 这次 P2002 撞的是**账单号**那个唯一索引吗？
 *
 * ⚠️ `Invoice` 有两个唯一索引：
 * - `@@unique([subscriptionId, periodStart])` —— 同一个周期只能有一张账单
 * - `@@unique([tenantId, number])` —— 同一个租户内账单号唯一
 *
 * 撞前者 = 幂等（这个周期已经有账单了）；撞后者 = 只是号撞了，换个号就行。
 * 不区分就会把「号撞了」误判成「周期已经有账单」→ 该周期永远不出账单。
 *
 * ⚠️ `error.meta.target` 的形状在不同驱动版本下不一致：
 * Prisma 5+ 是字段名字符串数组（`['tenantId', 'number']`），
 * 但也可能是单个字符串或索引名。**全部认**，认不出就保守地
 * 当成「撞了周期那个索引」（返回 null，幂等语义更安全）。
 */
function isInvoiceNumberViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const meta = (error as { meta?: unknown }).meta;
  if (typeof meta !== 'object' || meta === null) {
    return false;
  }
  const target = (meta as { target?: unknown }).target;
  if (typeof target === 'string') {
    return target.includes('number');
  }
  if (Array.isArray(target)) {
    return target.some(
      (field) => typeof field === 'string' && field.includes('number'),
    );
  }
  return false;
}

/**
 * 生成账单号。
 *
 * ⚠️ **服务端生成**：账单号不是秘密（它出现在渠道页面与对账单里），
 * 但**不能由客户端指定** —— 否则「付了 A 账单的钱、开通了 B 账单」就可能发生。
 */
function generateInvoiceNumber(now: Date): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const random = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, '0');
  return `INV${stamp}${random}`;
}
