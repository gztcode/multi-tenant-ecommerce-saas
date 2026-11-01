import { PayoutStatus } from '@prisma/client';
import { ReconciliationDiffType, ReconciliationSeverity } from '@prisma/client';
import type { ChannelPayoutRecord } from '../../common/payment/payout-provider.interface';

/** 参与比对的本地单（已按设计 §四·4.1 查好） */
export interface LocalPayoutForReconcile {
  id: string;
  payoutNo: string;
  payoutTxnId: string | null;
  status: PayoutStatus;
  netAmount: number;
  receiptAmount: number;
  commissionAmount: number;
  entryCount: number;
  paidAt: Date | null;
  processingAt: Date | null;
  failedAt: Date | null;
}

/** 比对引擎的入参 */
export interface ReconcileInput {
  /** 名义窗口 `[from, to)` */
  window: { from: Date; to: Date };
  /** 扩大的窗口边界（用于判定 D 类是否落在窗口内） */
  expandedWindow: { from: Date; to: Date };
  /** 本地单集合 */
  localPayouts: LocalPayoutForReconcile[];
  /** 渠道流水集合（**已含失败那次**） */
  channelRecords: ChannelPayoutRecord[];
}

/** 一条差异 */
export interface ReconcileDiff {
  type: ReconciliationDiffType;
  severity: ReconciliationSeverity;
  payoutId: string | null;
  channelTxnId: string | null;
  channelReferenceNo: string | null;
  channelAmount: number | null;
  channelStatus: string | null;
  channelPaidAt: Date | null;
  localAmount: number | null;
  localStatus: PayoutStatus | null;
}

/** 比对引擎的出参 */
export interface ReconcileOutput {
  diffs: ReconcileDiff[];
  /** 口径 = **本地单数**（不是渠道流水条数） */
  matchedCount: number;
}

/**
 * 从一组里挑一条权威记录。
 *
 * 1. 组内有 `status === 'SUCCESS'` 的 → **取它**（有多条 SUCCESS 则取 `paidAt` 最晚的）
 * 2. 组内没有 SUCCESS → 取 `paidAt` 最晚的（没有 `paidAt` 的取最后一条）
 *
 * ⚠️ **第 2 条依赖组内已按 `paidAt` 升序排好** —— 见 `sortChannelRecords`。
 */
export function pickAuthoritative(
  group: ChannelPayoutRecord[],
): ChannelPayoutRecord {
  const successes = group.filter((r) => r.status === 'SUCCESS');
  if (successes.length > 0) {
    return latestByPaidAt(successes);
  }
  return latestByPaidAt(group);
}

/** 取 `paidAt` 最晚的一条；都没有 `paidAt` 时取数组最后一条 */
function latestByPaidAt(records: ChannelPayoutRecord[]): ChannelPayoutRecord {
  let best = records[records.length - 1];
  for (const record of records) {
    if (!record.paidAt) {
      continue;
    }
    if (!best.paidAt || record.paidAt.getTime() > best.paidAt.getTime()) {
      best = record;
    }
  }
  return best;
}

/**
 * 把渠道流水按 `paidAt` **升序**排好（没有 `paidAt` 的排最后）。
 *
 * ⚠️ **排序不是可有可无的整理工作，而是 `pickAuthoritative` 的前置条件** ——
 *    第 2 条兜底规则「组内没有 SUCCESS → 取 `paidAt` 最晚的；全都没有 `paidAt`
 *    的取数组最后一条」**依赖组内已按 `paidAt` 升序排好**。
 *    渠道侧不承诺输出顺序（假网关按 `referenceNo` 分组输出，真渠道更是分页/倒序/
 *    按状态分组都有）→ 不自己排序的话，同一份账单换个行序就会得出不同的结论。
 *
 * ⚠️ **必须有确定的次级排序键** —— 两条记录 `paidAt` 完全相同时，比较结果为 0
 *    → 相对顺序就取决于**输入顺序** → 权威记录仍然会漂。用 `providerTxnId` 的
 *    字典序做 tie-break，保证「同一份输入永远同一个结论」。
 */
function sortChannelRecords(
  records: ChannelPayoutRecord[],
): ChannelPayoutRecord[] {
  return [...records].sort((a, b) => {
    const at = a.paidAt?.getTime();
    const bt = b.paidAt?.getTime();
    if (at === undefined && bt === undefined) {
      // 两条都没有 `paidAt` → 走 tie-break
      return compareProviderTxnId(a, b);
    }
    if (at === undefined) return 1; // 没有 paidAt 的排最后
    if (bt === undefined) return -1;
    if (at !== bt) return at - bt;
    // `paidAt` 相同 → 走 tie-break
    return compareProviderTxnId(a, b);
  });
}

/** tie-break：`providerTxnId` 的字典序（保证排序是全序，不依赖输入顺序） */
function compareProviderTxnId(
  a: ChannelPayoutRecord,
  b: ChannelPayoutRecord,
): number {
  if (a.providerTxnId === b.providerTxnId) return 0;
  return a.providerTxnId < b.providerTxnId ? -1 : 1;
}

/**
 * 比对引擎的主函数（纯函数）。
 *
 * ## 判定顺序（设计 §四·4.4）
 *
 * ```
 * 第一步：归组（1a 匹配本地单 → 1b 同单归组 → 1c 取权威记录）
 * 第二步：逐张本地单对照它的权威渠道记录
 *   a. 渠道 SUCCESS 且 本地 PROCESSING      → A 类
 *   b. 渠道 SUCCESS 且 本地 FAILED         → B 类
 *   c. 渠道 SUCCESS 且 本地 PAID 且金额不同  → C 类
 *   d. 渠道 SUCCESS 且 本地 PAID 且金额一致  → 匹配
 *   e. 渠道 FAILED  且 本地 PAID           → F 类
 *   f. 渠道 FAILED  且 本地 FAILED         → 匹配
 *   g. 渠道非终态 / 其它组合               → 不算差异
 *   h. 没有权威渠道记录 且 本地是 PAID       → E 类
 * 第三步：没有匹配到任何本地单的渠道流水
 *   a. 时刻落在【扩大的窗口】内 → D 类
 *   b. 落在窗口外（时钟偏移导致的多余记录） → 忽略
 * ```
 */
export function reconcile(input: ReconcileInput): ReconcileOutput {
  const diffs: ReconcileDiff[] = [];
  let matchedCount = 0;

  // ---- ① 把渠道流水归到本地单上 ----
  const byReferenceNo = new Map<string, ChannelPayoutRecord[]>();
  const byTxnId = new Map<string, ChannelPayoutRecord[]>();
  const orphanRecords: ChannelPayoutRecord[] = [];

  // ⚠️ **必须先排序再归组** —— `pickAuthoritative` 的兜底规则依赖组内已按 `paidAt`
  //    升序排好。渠道侧不承诺输出顺序，不排序的话同一份账单换个行序就会得出
  //    不同的差异类型（金额差 1500 元的 C 类告警会凭空消失）。
  const sortedRecords = sortChannelRecords(input.channelRecords);

  for (const record of sortedRecords) {
    const local = matchLocal(input.localPayouts, record);
    if (!local) {
      orphanRecords.push(record);
      continue;
    }
    if (record.referenceNo) {
      const list = byReferenceNo.get(record.referenceNo) ?? [];
      list.push(record);
      byReferenceNo.set(record.referenceNo, list);
    } else {
      const list = byTxnId.get(record.providerTxnId) ?? [];
      list.push(record);
      byTxnId.set(record.providerTxnId, list);
    }
  }

  // ---- ② 逐张本地单对照它的权威渠道记录 ----
  for (const local of input.localPayouts) {
    const group = [
      ...(byReferenceNo.get(local.payoutNo) ?? []),
      ...(local.payoutTxnId ? (byTxnId.get(local.payoutTxnId) ?? []) : []),
    ];

    if (group.length === 0) {
      // h 档：没有权威渠道记录且本地是 PAID → E 类
      if (local.status === PayoutStatus.PAID) {
        diffs.push({
          type: ReconciliationDiffType.LOCAL_PAID_CHANNEL_ABSENT,
          severity: ReconciliationSeverity.CRITICAL,
          payoutId: local.id,
          channelTxnId: null,
          channelReferenceNo: null,
          channelAmount: null,
          channelStatus: null,
          channelPaidAt: null,
          localAmount: local.netAmount,
          localStatus: local.status,
        });
      }
      // ⚠️ **其余状态没有权威渠道记录 → 不算差异**
      //    （本地 PROCESSING 但渠道查不到：可能渠道还没处理）
      continue;
    }

    const authoritative = pickAuthoritative(group);

    if (authoritative.status === 'SUCCESS') {
      if (local.status === PayoutStatus.PROCESSING) {
        // a 档 → A 类
        diffs.push(
          buildDiff(
            ReconciliationDiffType.CHANNEL_PENDING_LOCAL,
            ReconciliationSeverity.INFO,
            local,
            authoritative,
          ),
        );
      } else if (local.status === PayoutStatus.FAILED) {
        // b 档 → B 类
        diffs.push(
          buildDiff(
            ReconciliationDiffType.CHANNEL_SUCCESS_LOCAL_FAILED,
            ReconciliationSeverity.WARNING,
            local,
            authoritative,
          ),
        );
      } else if (local.status === PayoutStatus.PAID) {
        if (authoritative.amount !== local.netAmount) {
          // c 档 → C 类
          diffs.push(
            buildDiff(
              ReconciliationDiffType.AMOUNT_MISMATCH,
              ReconciliationSeverity.CRITICAL,
              local,
              authoritative,
            ),
          );
        } else {
          // d 档 → 匹配
          matchedCount += 1;
        }
      } else {
        // ⚠️ **本地不是终态（REQUESTED / APPROVED）** → 不算差异
      }
    } else if (authoritative.status === 'FAILED') {
      if (local.status === PayoutStatus.PAID) {
        // e 档 → F 类（渠道明确拒付，本地却记已付）
        diffs.push(
          buildDiff(
            ReconciliationDiffType.STATUS_MISMATCH,
            ReconciliationSeverity.CRITICAL,
            local,
            authoritative,
          ),
        );
      } else if (local.status === PayoutStatus.FAILED) {
        // f 档 → 双方一致说「没打出去」→ 匹配，不是差异
        matchedCount += 1;
      }
      // ⚠️ **本地是 PROCESSING 且渠道说 FAILED** → 不算差异
      //    （渠道说没打成功，本地还在等 → 正常的失败重试流程）
    } else {
      // g 档：渠道非终态 → **不算差异**
      //    「只有双方都声称终态且互相矛盾才是差异」
    }
  }

  // ---- ③ 没有匹配到任何本地单的渠道流水 ----
  for (const record of orphanRecords) {
    // ⚠️ **只在【扩大的窗口】内才算 D 类** —— 扩大的窗口会把名义窗口之外的
    //    渠道记录也拉进来（防时钟偏移），一律判成 D 类会凭空多出一堆假差异
    const paidAt = record.paidAt;
    if (!paidAt) {
      continue;
    }
    const t = paidAt.getTime();
    if (
      t < input.expandedWindow.from.getTime() ||
      t >= input.expandedWindow.to.getTime()
    ) {
      continue;
    }
    diffs.push({
      type: ReconciliationDiffType.CHANNEL_ONLY,
      severity: ReconciliationSeverity.CRITICAL,
      payoutId: null,
      channelTxnId: record.providerTxnId,
      channelReferenceNo: record.referenceNo ?? null,
      channelAmount: record.amount,
      channelStatus: record.status,
      channelPaidAt: paidAt,
      localAmount: null,
      localStatus: null,
    });
  }

  return { diffs, matchedCount };
}

/**
 * 把一条渠道流水匹配到本地单。
 *
 * ⚠️ **匹配键的优先级**（设计 §二·2.2）：
 * 1. `referenceNo`（= 我们的 `payoutNo`）—— 真渠道账单一般带「商户订单号」→ 首选
 * 2. `providerTxnId`（= 我们的 `payoutTxnId`）—— 渠道账单未必回显
 *
 * ⚠️ **`payoutTxnId` 没有唯一约束** → 命中**多张**本地单时，
 * **按 `paidAt` / `failedAt` 最新的一张取**，不要静默取第一条。
 */
function matchLocal(
  locals: LocalPayoutForReconcile[],
  record: ChannelPayoutRecord,
): LocalPayoutForReconcile | undefined {
  if (record.referenceNo) {
    const byNo = locals.find((l) => l.payoutNo === record.referenceNo);
    if (byNo) {
      return byNo;
    }
  }
  if (record.providerTxnId) {
    const candidates = locals.filter(
      (l) => l.payoutTxnId === record.providerTxnId,
    );
    if (candidates.length === 1) {
      return candidates[0];
    }
    if (candidates.length > 1) {
      // ⚠️ **多命中 → 取最新的一张**（不要静默取第一条）
      return [...candidates].sort(
        (a, b) => localTimestamp(b) - localTimestamp(a),
      )[0];
    }
  }
  return undefined;
}

/** 本地单的业务时刻（`paidAt` → `failedAt` → `processingAt` → 0） */
function localTimestamp(local: LocalPayoutForReconcile): number {
  return (
    local.paidAt?.getTime() ??
    local.failedAt?.getTime() ??
    local.processingAt?.getTime() ??
    0
  );
}

/** 组装一条差异 */
function buildDiff(
  type: ReconciliationDiffType,
  severity: ReconciliationSeverity,
  local: LocalPayoutForReconcile,
  authoritative: ChannelPayoutRecord,
): ReconcileDiff {
  return {
    type,
    severity,
    payoutId: local.id,
    channelTxnId: authoritative.providerTxnId,
    channelReferenceNo: authoritative.referenceNo ?? null,
    channelAmount: authoritative.amount,
    channelStatus: authoritative.status,
    channelPaidAt: authoritative.paidAt ?? null,
    localAmount: local.netAmount,
    localStatus: local.status,
  };
}
