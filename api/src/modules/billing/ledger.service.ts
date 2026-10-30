import { Injectable } from '@nestjs/common';
import { PayoutKind, PayoutStatus, SettlementStatus } from '@prisma/client';

import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { groupReceiptsByPeriod, splitPayoutAmounts } from './ledger';
import { formatPeriodLabel } from './settlement';

/**
 * 账目的按期批量聚合（阶段 5i）。
 *
 * ⚠️ **这个服务存在的唯一理由：把「N 期 × 3 次查询」变成固定 6 次查询** ——
 *    阶段 5h-2 的遗留 L55（`PayoutService.availablePeriods` 的 N+1）就是这么来的：
 *    逐期循环调 `computeAmounts`，每期 3 次查询，期数一多就线性放大。
 *    商家侧对账单（Task 5）也要按期聚合 → 同样的 N+1 会**再出现一次**。
 *    → **两边共用这一个服务**，数字与查询次数一起统一。
 *
 * ⚠️ **口径是「一份事实源」**：货款取流水（实时聚合），佣金取结算单的冻结值，
 *    出款取出款单。与 `PayoutService.computeAmounts` 逐字同源 ——
 *    两处口径漂了账就错了。
 */

/** 一期的聚合结果 */
export interface PeriodAmounts {
  /** 货款净额（实时聚合，带符号） */
  receiptAmount: number;
  /** 货款流水笔数 */
  receiptCount: number;
  /** 该期结算单 id；null = 该期没有结算单 */
  statementId: string | null;
  /** 佣金净额（带符号，取结算单的 `netAmount`）；null = 该期没有结算单 */
  commissionAmount: number | null;
  /** 结算单状态；null = 该期没有结算单 */
  statementStatus: SettlementStatus | null;
  /** 抽佣流水笔数（结算单纳入的） */
  commissionEntryCount: number;
  /**
   * 当期**真实**的抽佣流水笔数（全部流水，不是结算单纳入的那些）。
   *
   * ⚠️ 与 `commissionEntryCount`（结算单纳入的笔数）的差值 = 缺笔数。
   */
  actualCommissionEntryCount: number;
  /** 已出款金额（`PAID` 的出款单之和） */
  paidAmount: number;
  /** 在途金额（`REQUESTED` / `APPROVED` / `PROCESSING` 的出款单之和） */
  inFlightAmount: number;
  /** 有没有活跃的正常单（**活跃含 `PAID`**） */
  hasActiveNormal: boolean;
  /** 有没有活跃的补差单 */
  hasActiveSupplement: boolean;
  /** 正常单是否已 `PAID` */
  normalPaid: boolean;
  /** 未纳入的货款（补差金额）；null = 还没算 */
  supplementAmount: number | null;
}

/**
 * **非活跃**的出款单状态。
 *
 * ⚠️ **这个集合必须与另外两处逐字一致**：
 * ① 部分唯一索引 `payouts` 的 `WHERE status NOT IN (...)`（迁移 SQL 里的）；
 * ② `PayoutService.findActivePayout` 的 `notIn`；
 * ③ 这里。
 *
 * ⚠️ **三处不一致的后果**：查询认为不活跃、插入却被索引拦下（或反过来）
 *    → 「商家点申请说已有单在处理中，但列表页没有它」这种查无实据的现象。
 *
 * ⚠️ **不含 `PAID`** —— `PAID` 的正常单**也是活跃单**（它占着索引位，
 *    且它正是「这一期已结清、只能走补差」的判据）。
 */
const INACTIVE_PAYOUT_STATUSES: readonly PayoutStatus[] = [
  PayoutStatus.REJECTED,
  PayoutStatus.CANCELLED,
  PayoutStatus.FAILED,
];

/** 一行出款单（聚合时只需要这几个字段） */
interface PayoutRow {
  id: string;
  periodStart: Date;
  status: PayoutStatus;
  /** 应结金额（整数分） */
  netAmount: number;
  kind: PayoutKind;
}

@Injectable()
export class LedgerService {
  constructor(private readonly prisma: TenantPrismaService) {}

  /**
   * 一次查齐所有期的货款 / 佣金 / 出款，内存里按期分组。
   *
   * ⚠️ **查询次数与期数无关** —— 不论 1 期还是 100 期，都是 7 次查询
   *    （每张表各 1 次）。这是本服务存在的全部意义（L55 的解药）。
   *
   * ⚠️ **两张关联表要靠 id 列表限定**：
   *    `settlement_statement_entries` 与 `payout_entries` **没有 `tenantId` 字段、
   *    刻意不在租户作用域白名单里** → 扩展**不会**给它们附加 tenantId 条件
   *    → 直接查就是全局事实。
   *    这里的做法是「先查该租户的结算单 / 出款单，再按它们的 id 列表关联」
   *    → **归属天然安全**（那些 id 本来就是该租户的）。
   *
   * ⚠️ **佣金取结算单的冻结值，不重新聚合抽佣流水**：
   *    结算单是**已确认的凭证**，以它为准；重新聚合会与冻结值对不上，
   *    且结算单被「取消确认 → 重算」之后两边立刻漂移。
   *
   * @param tenantId 该商家 id。⚠️ **显式写进 `where` 的理由见各查询处的注释**
   * @param periods 要聚合的周期区间（左闭右开，通常是自然月）
   */
  async aggregatePeriods(
    tenantId: string,
    periods: Array<{ from: Date; to: Date }>,
  ): Promise<Map<string, PeriodAmounts>> {
    const result = new Map<string, PeriodAmounts>();
    // ⚠️ **没有期就没有要聚合的东西** → 连库都不碰。
    //    （「查询次数固定」的承诺是「期数 ≥ 1 时恒为 6 次」）
    if (periods.length === 0) {
      return result;
    }

    // ⚠️ **用 reduce 而不是 `Math.min(...arr)`**：`Math.min` 展开参数个数有上限，
    //    期数多了会抛「Maximum call stack size exceeded」。
    const from = new Date(
      periods.reduce((min, p) => Math.min(min, p.from.getTime()), Infinity),
    );
    const to = new Date(
      periods.reduce((max, p) => Math.max(max, p.to.getTime()), -Infinity),
    );

    // ---- ① 货款流水（一次）----
    // ⚠️ **显式带 `tenantId`**：本方法可能被**平台作用域**调用
    //    （平台作用域下扩展**不附加** tenantId 条件，不带就是跨租户取数）。
    //    商家侧带着它是冗余的（扩展会覆盖成同一个值），但不能省 ——
    //    与 `PayoutService.computeAmounts` 同款理由。
    const receipts = await this.prisma.merchantReceipt.findMany({
      where: {
        tenantId,
        occurredAt: { gte: from, lt: to },
      },
      select: { id: true, amount: true, occurredAt: true },
    });
    // ⚠️ **分组口径与报表/结算单同款**（`formatPeriodLabel`，UTC 自然月）
    const receiptByPeriod = groupReceiptsByPeriod(receipts);

    // ---- ② 结算单（一次）----
    const statements = await this.prisma.settlementStatement.findMany({
      where: {
        tenantId,
        periodStart: { gte: from, lt: to },
      },
      select: {
        id: true,
        periodStart: true,
        netAmount: true,
        status: true,
      },
    });
    const statementByPeriod = new Map(
      statements.map((statement) => [
        formatPeriodLabel(statement.periodStart),
        statement,
      ]),
    );

    // ---- ③ 结算单纳入的抽佣流水关联（一次）----
    // ⚠️ **`settlement_statement_entries` 没有 tenantId、不在白名单**
    //    → 扩展不附加任何过滤 → **必须靠 id 列表限定归属**。
    const statementLinks = await this.prisma.settlementStatementEntry.findMany({
      where: { statementId: { in: statements.map((s) => s.id) } },
      select: { statementId: true, entryId: true },
    });
    const statementIdByEntryId = new Map(
      statementLinks.map((link) => [link.entryId, link.statementId]),
    );

    // ---- ④ 抽佣流水（一次）----
    // ⚠️ **笔数按「真实存在的流水行」算，不按关联行的条数算** ——
    //    关联行数是「结算单声称纳入了多少笔」，真实行数是「实际纳入了多少笔」。
    //    两者不等时说明关联行指向了已不存在的流水（脏数据），
    //    对商家显示的笔数必须以真实行数为准。
    const commissionEntries = await this.prisma.commissionEntry.findMany({
      where: { id: { in: [...statementIdByEntryId.keys()] } },
      select: { id: true },
    });
    const entryCountByStatement = new Map<string, number>();
    for (const entry of commissionEntries) {
      const statementId = statementIdByEntryId.get(entry.id);
      if (!statementId) {
        continue;
      }
      entryCountByStatement.set(
        statementId,
        (entryCountByStatement.get(statementId) ?? 0) + 1,
      );
    }

    // ---- ⑤ 出款单（一次）----
    const payouts = (await this.prisma.payout.findMany({
      where: {
        tenantId,
        periodStart: { gte: from, lt: to },
      },
      select: {
        id: true,
        periodStart: true,
        status: true,
        netAmount: true,
        kind: true,
      },
    })) as PayoutRow[];

    // ---- ⑥ 已被出款单占用的货款流水（一次）----
    // ⚠️ **`payout_entries` 同样没有 tenantId、不在白名单** → 靠 id 列表限定。
    const payoutLinks = await this.prisma.payoutEntry.findMany({
      where: { payoutId: { in: payouts.map((p) => p.id) } },
      select: { payoutId: true, entryId: true },
    });
    // ⚠️ **「已被占用」按 `payout_entries` 的实际行算，不按出款单的 `entryCount` 求和** ——
    //    被拒 / 撤回 / 失败的单已经释放了明细占用，但它们的 `entryCount` 列
    //    **仍是旧数字**（历史快照，没清零）。拿 `entryCount` 求和会把
    //    「已释放的流水」算成「已纳入」→ 补差金额被凭空抹掉。
    const claimedEntryIds = new Set(payoutLinks.map((link) => link.entryId));

    // ---- ⑦ 当期全部抽佣流水（用于算缺笔）----
    // ⚠️ **按流水自己的 `occurredAt` 取，再按期分组** ——
    //    不能用账单的 periodStart 筛流水（跨期回填的流水归期在退款期）。
    // ⚠️ 第 ④ 步查的是「已被结算单纳入的那些」，这里查的是「当期全部」，
    //    两者相减才是缺笔数。
    const allCommissionEntries = await this.prisma.commissionEntry.findMany({
      where: { tenantId, occurredAt: { gte: from, lt: to } },
      select: { occurredAt: true },
    });
    const actualCountByPeriod = new Map<string, number>();
    for (const entry of allCommissionEntries) {
      const label = formatPeriodLabel(entry.occurredAt);
      actualCountByPeriod.set(label, (actualCountByPeriod.get(label) ?? 0) + 1);
    }

    // ---- ⑧ 分期汇总（纯内存）----
    for (const period of periods) {
      const label = formatPeriodLabel(period.from);
      const amounts: PeriodAmounts = {
        receiptAmount: 0,
        receiptCount: 0,
        statementId: null,
        commissionAmount: null,
        statementStatus: null,
        commissionEntryCount: 0,
        actualCommissionEntryCount: 0,
        paidAmount: 0,
        inFlightAmount: 0,
        hasActiveNormal: false,
        hasActiveSupplement: false,
        normalPaid: false,
        // ⚠️ **恒有值**：本服务总会把它算出来（算出来是 0 也如实给 0）。
        //    「还没算」是**别的调用方**（还没跑到聚合那一步）的状态。
        supplementAmount: 0,
      };

      // ---- 货款（实时聚合）----
      const receiptSum = receiptByPeriod.get(label);
      amounts.receiptAmount = receiptSum?.amount ?? 0;
      amounts.receiptCount = receiptSum?.count ?? 0;

      // ---- 当期全部抽佣流水笔数（缺笔数的分母）----
      // ⚠️ **按流水自己的 `occurredAt` 归期** —— 不能用账单的 `periodStart`：
      //    跨期回填的流水归期在退款期，不在原期。
      amounts.actualCommissionEntryCount = actualCountByPeriod.get(label) ?? 0;

      // ---- 佣金（取结算单的冻结值）----
      const statement = statementByPeriod.get(label);
      if (statement) {
        amounts.statementId = statement.id;
        amounts.commissionAmount = statement.netAmount;
        amounts.statementStatus = statement.status;
        amounts.commissionEntryCount =
          entryCountByStatement.get(statement.id) ?? 0;
      }
      // ⚠️ **没有结算单时 `commissionAmount` 恒为 `null`，不是 0** ——
      //    「佣金是 0」与「佣金还不知道」是两回事：零额抽佣的商家**有**结算单
      //    （`netAmount = 0`），而没有结算单说明**佣金压根没算过**。
      //    填 0 会让「该期还没结算」被误读成「该期不用扣佣」。

      // ---- 出款单分桶 ----
      const periodPayouts = payouts.filter(
        (payout) => formatPeriodLabel(payout.periodStart) === label,
      );
      const buckets = splitPayoutAmounts(periodPayouts);
      amounts.paidAmount = buckets.paid;
      amounts.inFlightAmount = buckets.inFlight;
      for (const payout of periodPayouts) {
        // ⚠️ **「活跃」与 `PayoutService.findActivePayout` 逐字一致** ——
        //    同一个 `INACTIVE_PAYOUT_STATUSES` 集合，**含 `PAID`**。
        const active = !INACTIVE_PAYOUT_STATUSES.includes(payout.status);
        if (payout.kind === PayoutKind.NORMAL) {
          if (active) {
            amounts.hasActiveNormal = true;
          }
          if (payout.status === PayoutStatus.PAID) {
            // ⚠️ **「已结清」只看 `PAID` 的正常单** —— 它是「走正常路径
            //    还是补差路径」的判据（`FAILED` 的正常单要重走正常路径）。
            amounts.normalPaid = true;
          }
        } else if (active) {
          amounts.hasActiveSupplement = true;
        }
      }

      // ---- 未纳入的货款（补差金额）----
      // ⚠️ **只算「没有被任何出款单占用」的货款** ——
      //    已被正常单纳入的那批已经打出去了，再算一次就是重复打款。
      //    ⚠️ **按流水的归期（`occurredAt`）归期**，与货款聚合同口径。
      amounts.supplementAmount = receipts
        .filter((receipt) => formatPeriodLabel(receipt.occurredAt) === label)
        .filter((receipt) => !claimedEntryIds.has(receipt.id))
        .reduce((sum, receipt) => sum + receipt.amount, 0);

      result.set(label, amounts);
    }

    return result;
  }
}
