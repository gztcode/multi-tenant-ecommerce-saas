import { BadRequestException, Injectable } from '@nestjs/common';
import { CommissionEntryType, InvoiceStatus } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import {
  platformScope,
  tenantContext,
} from '../../common/tenant/tenant-context';
import { toReportAmounts } from './ledger';

/** 一天的毫秒数 */
const DAY_MS = 24 * 3600 * 1000;

/** 缺省报表区间：最近 30 天 */
const DEFAULT_WINDOW_DAYS = 30;

/** 订阅列表一次最多取多少行 */
const SUBSCRIPTION_PAGE_SIZE = 200;

/** 平台收入报表的四个数（金额一律整数分） */
export interface ReportSummary {
  /** 区间起点 */
  from: Date;
  /** 区间终点（不含） */
  to: Date;
  /** 订阅收入：区间内已付账单的金额之和 */
  subscriptionRevenue: number;
  /**
   * 抽佣收入：**毛额** —— 区间内抽佣流水（`COMMISSION`）的合计。
   *
   * ⚠️ **包含后来退款的那些**：抽佣是支付时定下的快照，
   * 与后来退没退款无关。退款的部分由 `reversal` 抵掉。
   */
  commissionRevenue: number;
  /** 退款冲回：区间内冲回流水（`REVERSAL`）的绝对值 */
  reversal: number;
  /** 净收入 = 订阅收入 + 抽佣收入 − 冲回 */
  netRevenue: number;
}

/** 平台订阅列表的一行 */
export interface PlatformSubscriptionItem {
  id: string;
  tenantId: string;
  tenantName: string;
  tenantSubdomain: string;
  planId: string;
  planName: string;
  pendingPlanId: string | null;
  pendingPlanName: string | null;
  status: string;
  commissionBps: number;
  startedAt: Date;
  trialEndsAt: Date | null;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
}

/**
 * 平台收入报表与跨租户订阅列表。
 *
 * ⚠️ **抽佣的两个数从抽佣流水表（`commission_entries`）聚合**（阶段 5i）：
 * 报表、结算单、出款单、对账单都读这一张事实源 —— 口径统一，
 * 平台看到的收入就是商家账上真正被扣走的钱。
 *
 * ⚠️ **金额一律整数分**：不在这里换算成元 —— 换算散落在前端各处，
 * 各处的舍入规则迟早会漂移，账就对不上了。
 */
@Injectable()
export class ReportService {
  constructor(private readonly prisma: TenantPrismaService) {}

  /**
   * 按时间区间出报表。
   *
   * ⚠️ **必须显式走平台作用域**（跨租户聚合）：
   * 控制器虽然挂了 `@Roles(PLATFORM_ADMIN)`，但控制器上的注解管的是
   * 「谁能调」，管不了「service 在什么作用域里查库」。不显式声明的话，
   * 这个方法被商家上下文调用时会**静默只统计一个租户的数据**——
   * 报表看起来正常，数字全是错的。
   *
   * ⚠️ **`run()` 的回调必须是 async 函数**：Prisma 6 的 PrismaPromise
   * 是 thenable 而非原生 Promise，同步回调会让 AsyncLocalStorage 上下文
   * 在查询真正执行的那一刻丢失，租户隔离会**静默失效**（见
   * `common/tenant/tenant-context.ts` 的注释）。
   */
  async summary(input: { from?: Date; to?: Date }): Promise<ReportSummary> {
    const { from, to } = await this.resolveWindow(input);

    // ⚠️ **区间必须非空**：`from >= to` 的区间算不出任何东西，
    // 与其返回一串 0 让调用方以为「这段时间没收入」，不如响亮地报错。
    if (from.getTime() >= to.getTime()) {
      throw new BadRequestException('区间非法：from 必须早于 to');
    }

    return tenantContext.run(platformScope(), async () => {
      // ⚠️ **订阅收入** = 区间内**已付**账单的金额之和。
      // 只算 PAID —— 未付（OPEN）与失败（FAILED）的账单钱还没到手。
      const subscriptionAggregate = await this.prisma.invoice.aggregate({
        where: {
          status: InvoiceStatus.PAID,
          paidAt: { gte: from, lt: to },
        },
        _sum: { amount: true },
      });

      // ⚠️ **抽佣收入 = 区间内抽佣流水（COMMISSION）的合计**。
      //
      // ⚠️ **为什么不再读 `orders` 表**（阶段 5i 的口径收口）：
      //    报表原先从 `orders` 聚合（按 `paidAt` 取 `commissionAmount`），
      //    而结算单与出款单从 `commission_entries` 读 —— **两套口径、两套数据源**。
      //    两边迟早漂移：流水是 append-only 的审计凭证（写进去就不改），
      //    订单的 `commissionAmount` 是快照、可能被后续逻辑改动；
      //    结算单的金额是从流水聚合出来的，报表却从订单聚合 ——
      //    于是「平台报表的抽佣」与「结算单已结的抽佣」对不上，
      //    平台超管看到的收入不是商家账上真正被扣走的钱。
      //    现在四者（报表 / 结算单 / 出款单 / 对账单）都收敛到流水这一张事实源。
      //
      // ⚠️ **归期口径不变**：流水的 `occurredAt` 写入时取的就是 `order.paidAt`
      //    （抽佣）/ `order.refundedAt`（冲回），与旧口径同源 —— 数字不变，
      //    只是改从哪儿读。
      //
      // ⚠️ **流水天然就是毛额**：流水表里抽佣与冲回是两类行，
      //    冲回不在 `COMMISSION` 的合计里 → 抽佣收入保持「毛额」语义。
      const commissionAggregate = await this.prisma.commissionEntry.aggregate({
        where: {
          type: CommissionEntryType.COMMISSION,
          occurredAt: { gte: from, lt: to },
        },
        _sum: { amount: true },
      });

      // ⚠️ **退款冲回 = 区间内冲回流水的合计**（口径同上：读流水，不读订单）。
      //
      // ⚠️ **冲回是毛额的对冲项**：净收入 = 订阅收入 + 抽佣收入 − 冲回。
      // 一笔单无论退没退款，全周期净贡献都是对的：
      // 退了就是 +抽佣（支付期）−抽佣（退款期）= 0。
      //
      // ⚠️ **按退款期间归期，不按支付期间**：一笔在 1 月支付、3 月退款的订单，
      // 3 月的账上要有那笔冲回 —— 否则 3 月的账会把「白拿的抽佣」算成收入。
      const reversalAggregate = await this.prisma.commissionEntry.aggregate({
        where: {
          type: CommissionEntryType.REVERSAL,
          occurredAt: { gte: from, lt: to },
        },
        _sum: { amount: true },
      });

      // ⚠️ **`_sum` 的键必须与字段名逐字一致**：写 `_sum: { amount: true }`
      // 就要读 `_sum.amount`。读成别的键拿到的是 undefined，
      // `?? 0` 之后永远是 0 —— **数字全错却不报错**，是最难查的那种错。
      const subscriptionRevenue = subscriptionAggregate._sum.amount ?? 0;

      // ⚠️ **符号换算必须走 `toReportAmounts`**：
      //    流水的 `REVERSAL.amount` 恒 ≤ 0，报表口径的 `reversal` 恒 ≥ 0
      //    （`netRevenue = 订阅 + 抽佣 − 冲回`）。
      //    符号写反 → 冲回被减两次 → 净收入翻倍。
      //    `toReportAmounts` 还会在符号异常时抛错，并把 `-0` 归一成 `0`。
      const { commissionRevenue, reversal } = toReportAmounts(
        commissionAggregate._sum.amount ?? 0,
        reversalAggregate._sum.amount ?? 0,
      );

      return {
        from,
        to,
        subscriptionRevenue,
        commissionRevenue,
        reversal,
        netRevenue: subscriptionRevenue + commissionRevenue - reversal,
      };
    });
  }

  /**
   * 跨租户的订阅列表（新的在前）。
   *
   * ⚠️ **同样必须显式走平台作用域**：与 `summary()` 同款理由 ——
   * 「平台超管能看到所有租户的订阅」是接口的职责，不是上下文碰巧对的结果。
   */
  async listSubscriptions(): Promise<{
    items: PlatformSubscriptionItem[];
    total: number;
  }> {
    return tenantContext.run(platformScope(), async () => {
      const [subscriptions, total] = await Promise.all([
        this.prisma.subscription.findMany({
          orderBy: { createdAt: 'desc' },
          take: SUBSCRIPTION_PAGE_SIZE,
        }),
        this.prisma.subscription.count(),
      ]);

      if (subscriptions.length === 0) {
        return { items: [], total };
      }

      // ⚠️ **租户名与套餐名要分开查再合并**。
      //
      // `Subscription.planId` 与 `Subscription.tenantId` **都不是 Prisma 关系**：
      // 订阅表只有 `planId` 纯标量（套餐是平台的数据，跨域不声明外键），
      // 也没有声明 `tenant` 关系。所以 `include: { tenant: true }` 根本写不出来。
      //
      // `Tenant` 与 `Plan` **都不在** `TENANT_SCOPED_MODELS` 白名单里
      // （见 `common/tenant/tenant-models.ts`），任何作用域都能查。
      const tenantIds = [...new Set(subscriptions.map((s) => s.tenantId))];
      const tenants = await this.prisma.tenant.findMany({
        where: { id: { in: tenantIds } },
      });
      const tenantById = new Map(tenants.map((t) => [t.id, t]));

      // ⚠️ **待生效的套餐也要一起查**：订阅有两个套餐 id（当前与待生效）。
      const planIds = [
        ...new Set(
          subscriptions.flatMap((s) =>
            [s.planId, s.pendingPlanId].filter((id): id is string => !!id),
          ),
        ),
      ];
      const plans = await this.prisma.plan.findMany({
        where: { id: { in: planIds } },
      });
      const planById = new Map(plans.map((p) => [p.id, p]));

      const items = subscriptions.map((subscription) => {
        const tenant = tenantById.get(subscription.tenantId);
        const plan = planById.get(subscription.planId);
        const pendingPlan = subscription.pendingPlanId
          ? planById.get(subscription.pendingPlanId)
          : undefined;

        return {
          id: subscription.id,
          tenantId: subscription.tenantId,
          // ⚠️ **查不到就回落到 id 本身**：租户被删了也要让超管看到这一行
          // （「有个商家订阅了一个不存在的套餐」是超管必须知道的事实）。
          // 让整行消失的话，超管看到的订阅总数会莫名其妙对不上账。
          tenantName: tenant?.name ?? subscription.tenantId,
          // ⚠️ **查不到时给「—」而不是空串**：空串看不出是「租户不存在」
          // 还是「数据缺失」。**不回落到 tenantId** —— 那是个 id，不是子域名，
          // 回落过去反而误导。
          tenantSubdomain: tenant?.subdomain ?? '—',
          planId: subscription.planId,
          planName: plan?.name ?? subscription.planId,
          pendingPlanId: subscription.pendingPlanId,
          pendingPlanName: subscription.pendingPlanId
            ? (pendingPlan?.name ?? subscription.pendingPlanId)
            : null,
          status: subscription.status,
          // ⚠️ **查不到套餐时抽佣费率给 0**：费率是套餐的属性，
          // 没有套餐就没有费率 —— 但这不代表「不抽佣」，
          // 只代表「查不到」，超管看到这一行本身就是要去查原因。
          commissionBps: plan?.commissionBps ?? 0,
          startedAt: subscription.startedAt,
          trialEndsAt: subscription.trialEndsAt,
          currentPeriodStart: subscription.currentPeriodStart,
          currentPeriodEnd: subscription.currentPeriodEnd,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        };
      });

      // ⚠️ **`total` 要是真实总数，不能用 `items.length`**：
      // `items` 被 `take: 200` 截断了，跨租户视图下 200 家商家是很正常的量级，
      // 截断真的会发生 —— 超管看到「总共 200 条订阅」会以为平台只有 200 个订阅。
      // 前端能自己从 `total > items.length` 推出来还有没有更多，
      // 所以后端**不用**再加 `truncated` / `hasMore` 字段。
      return { items, total };
    });
  }

  /**
   * 定出报表的区间。
   *
   * ⚠️ **时间用数据库的时钟**（护栏 M15）：多副本部署时各机器的时钟有偏差，
   * 边界时刻会摇摆。数据库的 `now()` 是单一事实来源。
   *
   * ⚠️ **缺省窗口在这里算，不在 DTO 里**：DTO 只负责解析，
   * 这样默认窗口与显式传入的窗口用**同一个时钟来源**。
   *
   * ⚠️ **是 public 的**：抽佣明细（`GET /platform/commissions`）与收入报表
   * 用的是**同一套区间语义**（缺省最近 30 天、同一时钟来源）。
   * 复制一份到别的 service 里，两边的缺省窗口迟早会漂移。
   */
  async resolveWindow(input: {
    from?: Date;
    to?: Date;
  }): Promise<{ from: Date; to: Date }> {
    // ⚠️ **只在真的需要 `now` 时才查库**：`from` 与 `to` 都显式传入时
    // `now` 根本用不到，那次 DB 往返是白跑的。
    const to = input.to ?? (await this.prisma.databaseNow());
    const from =
      input.from ?? new Date(to.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS);

    return { from, to };
  }
}
