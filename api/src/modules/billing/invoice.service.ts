import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  InvoiceStatus,
  PaymentStatus,
  SubscriptionStatus,
  type Invoice,
} from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { isUniqueViolation } from '../../common/errors/unique-constraint';
import type { PrismaTransaction } from '../../common/prisma/prisma-transaction';
import { transactionOptions } from '../../common/db/transaction-options';

/**
 * 对外的账单视图：账单行 + 作废人显示名。
 *
 * ⚠️ 库里只存 `voidedBy`（userId）；`voidedByName` 是**查询时解析**出来的，
 * 不落库（账号改名后展示要跟着变）。没作废的账单该字段恒为 null。
 */
export interface InvoiceView extends Invoice {
  voidedByName: string | null;
}

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
  private readonly logger = new Logger(InvoiceService.name);

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
   *
   * ⚠️ **`status` 是可选的筛选条件**（沿用对账列表的做法）：
   * 不传就维持原来的「全量最近 50 张」，传了才加条件 ——
   * 前端不传时行为一个字节都不变。
   */
  async list(
    tenantId: string,
    status?: InvoiceStatus,
  ): Promise<{ items: InvoiceView[]; total: number }> {
    const items = await this.prisma.invoice.findMany({
      where: status ? { tenantId, status } : { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { items: await this.withOperatorNames(items), total: items.length };
  }

  /**
   * 作废一张账单（**保留记录，不删行**）。
   *
   * 语义：`OPEN` / `FAILED` → `VOID`，写 `voidedAt` / `voidedBy` / `voidReason`。
   *
   * ⚠️ **允许作废的状态只有「还没产生会计影响」的两种**：
   * - `OPEN`：还没付过钱；
   * - `FAILED`：上一次支付尝试失败了，钱没到账。这也是商家最常想作废的一种
   *   （换套餐 / 不再续费 / 测试数据），不允许就没法收拾。
   *
   * ⚠️ **`PAID` 一律禁止**：钱已经收了、订阅期已经延长，作废会让账实不符；
   * 真实场景要退钱，那是退款流程，不是作废。
   * 另外**再查一遍有没有 SUCCESS 支付单**：账单状态与支付单理论上同步，
   * 但状态是第二层防御 —— 支付成功而账单没转 `PAID` 的异常数据不能被作废掉。
   *
   * ⚠️ **重复作废报 409，不静默成功**：商家连点两次要能看出第一次已经生效。
   *
   * ⚠️ **作废后本期不再续费**：自动续费的 `chargeAndSettle` 只放行
   * `OPEN` / `FAILED`，`VOID` 账单会被跳过，到期后订阅自然 `EXPIRED`。
   *
   * 已知边界（PR 正文也写了）：作废时如果商家手上还开着支付页
   * （已建 `PENDING` 支付单、尚未回调），渠道侧仍可能把这笔钱收走；
   * 回调里 `markInvoicePaidInTx` 只认 `OPEN` / `FAILED`，所以**订阅不会延长**，
   * 钱需要线下退款。不在作废里封死这条路径：`FAILED` 账单的支付单就是
   * 长期 `PENDING` 的（复用重试），封死等于 `FAILED` 账单永远作废不了。
   */
  async voidInvoice(input: {
    tenantId: string;
    number: string;
    voidedBy: string;
    reason?: string;
  }): Promise<InvoiceView> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { tenantId: input.tenantId, number: input.number },
    });
    if (!invoice) {
      throw new NotFoundException('账单不存在');
    }
    if (invoice.status === InvoiceStatus.VOID) {
      throw new ConflictException('账单已作废，不能重复作废');
    }
    if (invoice.status === InvoiceStatus.PAID) {
      throw new ConflictException('账单已支付，不能作废');
    }
    if (
      invoice.status !== InvoiceStatus.OPEN &&
      invoice.status !== InvoiceStatus.FAILED
    ) {
      throw new ConflictException('账单当前状态不允许作废');
    }

    const settled = await this.prisma.payment.findFirst({
      where: { invoiceId: invoice.id, status: PaymentStatus.SUCCESS },
      select: { id: true },
    });
    if (settled) {
      throw new ConflictException('账单存在成功的支付记录，不能作废');
    }

    const now = await this.prisma.databaseNow();
    const reason = input.reason?.trim() ? input.reason.trim() : null;
    // ⚠️ **条件更新**（把可作废状态放进 where）：并发作废时只有一方命中，
    // 另一方拿到 count = 0 —— 报冲突而不是覆盖前一次的作废人与时间。
    const affected = await this.prisma.invoice.updateMany({
      where: {
        id: invoice.id,
        status: { in: [InvoiceStatus.OPEN, InvoiceStatus.FAILED] },
      },
      data: {
        status: InvoiceStatus.VOID,
        voidedAt: now,
        voidedBy: input.voidedBy,
        voidReason: reason,
      },
    });
    if (affected.count === 0) {
      throw new ConflictException('账单状态已变化，请刷新后重试');
    }

    const updated = await this.prisma.invoice.findFirst({
      where: { id: invoice.id },
    });
    if (!updated) {
      // 刚更新过的行不该消失（作废不删行）；走到这里说明有别的进程在删数据。
      throw new ConflictException('账单状态已变化，请刷新后重试');
    }
    const [view] = await this.withOperatorNames([updated]);
    return view;
  }

  /**
   * 给账单补上「作废人显示名」。
   *
   * ⚠️ **存的是 userId、解析成显示名是展示层的事**：与出款单的操作人
   * （`payouts.approvedBy` → `operatorName`）同一套口径。
   * 账号查不到（被删 / 跨租户）就回落到 id —— 宁可显示一串 id，
   * 也不能把「谁作废的」显示成空白。
   */
  private async withOperatorNames(invoices: Invoice[]): Promise<InvoiceView[]> {
    const voidedByIds = [
      ...new Set(
        invoices
          .map((invoice) => invoice.voidedBy)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    if (voidedByIds.length === 0) {
      return invoices.map((invoice) => ({ ...invoice, voidedByName: null }));
    }

    const users = await this.prisma.user.findMany({
      where: { id: { in: voidedByIds } },
      select: { id: true, displayName: true },
    });
    const nameById = new Map(users.map((user) => [user.id, user.displayName]));
    return invoices.map((invoice) => ({
      ...invoice,
      voidedByName: invoice.voidedBy
        ? (nameById.get(invoice.voidedBy) ?? invoice.voidedBy)
        : null,
    }));
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
      transactionOptions(),
    );
  }

  /**
   * 账单付清 → 订阅期延长一个周期（**在一个已开启的事务里**）。
   *
   * ⚠️ 供 `markInvoicePaid` 调用，也供将来「与别的写同生共死」的场景复用。
   *
   * ⚠️ **只有这张账单把周期往后推时，才更新订阅周期**：
   * `invoice.periodEnd > subscription.currentPeriodEnd` 成立才延长；
   * 不成立（旧周期账单 / 重复账单 / 区间已被新周期覆盖）→ 账单照常标
   * `PAID`，但订阅的 `planId` / 周期 / `pendingPlanId` / `status` /
   * `trialEndsAt` **一行都不改**，只记一条 `warn`。
   */
  async markInvoicePaidInTx(
    tx: PrismaTransaction,
    invoiceId: string,
  ): Promise<boolean> {
    // ⚠️ **时钟走 tx**：交互事务会独占一条连接，
    //    用 `this.prisma.databaseNow()` 会再借一条 → 小连接池上死等（P2024）。
    //
    // ⚠️ **tx 上的 `now()` 是「事务开始时刻」**，与事务外取有 ≤30s 偏差。
    //    `paidAt` 是财务口径字段，这个偏差在容差内，但**必须在此写明**。
    const rows = await tx.$queryRaw<Array<{ now: Date }>>`
      SELECT now() as now
    `;
    const now = rows[0].now;
    // ⚠️ **`status` 条件是第二层防御，当前实现下测不到** ——
    // 订阅期延长写的是**绝对值**（`currentPeriodStart: invoice.periodStart`、
    // `currentPeriodEnd: invoice.periodEnd`），所以**同一个账单被重复处理也只会延长一次**。
    // 那层 `status` 条件防的是「账单被重复处理」这个假设不成立时的意外，
    // 当前实现下**无法从外部观测到它是否起作用**。
    //
    // ⚠️ **护栏 M11 的用例不能靠「同一个 eventId 重复投递」** ——
    // 那会被事件表的唯一索引挡在 `markInvoicePaid` **之前**，
    // 断言「订阅期只延长一次」**恒真**，测的不是这层防御。
    // 真正的 M11 用例要投递**两个不同 eventId、但 providerTxnId 相同**的事件。
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
    // ⚠️ **只有这张账单把周期往后推时，才更新订阅周期**（业主裁定 2026-11-27）。
    //
    // 换套餐即刻重开新周期、剩余天数作废 —— 此后一张**属于旧周期**的未付账单
    // （手动支付、后台补偿、上一轮扣款重试）再被付清时，如果无条件把周期
    // 写回 `invoice.periodStart ~ invoice.periodEnd`，就会把刚开的新周期整个抢走：
    // 旧区间可能整段在过去，下一轮 `expireIfNeeded` 立刻把订阅打成 `EXPIRED`
    // —— 商家刚付的钱换来的新周期凭空消失。钱照收，周期不能回滚。
    //
    // 正常续费的账单由 `renewOne()` 从 `currentPeriodEnd` 起算，
    // `invoice.periodEnd > subscription.currentPeriodEnd` 恒成立，行为不变。
    const extendsPeriod =
      invoice.periodEnd.getTime() > subscription.currentPeriodEnd.getTime();
    if (!extendsPeriod) {
      this.logger.warn(
        `账单 ${invoice.number} 已收，但不延长周期：` +
          `账单区间 ${invoice.periodStart.toISOString()} ~ ${invoice.periodEnd.toISOString()}，` +
          `订阅当前区间 ${subscription.currentPeriodStart.toISOString()} ~ ${subscription.currentPeriodEnd.toISOString()}` +
          `（区间已被新周期覆盖）`,
      );
      return true;
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
