/**
 * 渠道对账的类型与文案（阶段 5m）。
 *
 * ⚠️ **文案要给运营看** —— 用业务口径，不出现「快照」「密文」这类内部术语。
 */

/**
 * 对账的数据来源。
 *
 * ⚠️ **必须与后端 Prisma 的 `ReconciliationSource` 逐字一致**：
 * 写成别的拼法，界面上就是裸枚举。
 */
export type ReconciliationSource = 'API' | 'FILE';

/**
 * 对账任务的状态。
 *
 * ⚠️ **必须与后端 Prisma 的 `ReconciliationStatus` 逐字一致**。
 */
export type ReconciliationStatus = 'RUNNING' | 'COMPLETED' | 'FAILED';

/**
 * 差异的严重级。
 *
 * ⚠️ **必须与后端 Prisma 的 `ReconciliationSeverity` 逐字一致**。
 */
export type ReconciliationSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

/**
 * 差异的处置状态。
 *
 * ⚠️ **必须与后端 Prisma 的 `ReconciliationResolution` 逐字一致**。
 */
export type ReconciliationResolution = 'PENDING' | 'RESOLVED' | 'IGNORED';

/**
 * 差异类型（对应设计 §四·4.3 的 A–F 六类）。
 *
 * ⚠️ **必须与后端 Prisma 的 `ReconciliationDiffType` 逐字一致**。
 */
export type ReconciliationDiffType =
  | 'CHANNEL_PENDING_LOCAL'
  | 'CHANNEL_SUCCESS_LOCAL_FAILED'
  | 'AMOUNT_MISMATCH'
  | 'CHANNEL_ONLY'
  | 'LOCAL_PAID_CHANNEL_ABSENT'
  | 'STATUS_MISMATCH';

export const RECONCILIATION_SOURCE_LABEL: Record<ReconciliationSource, string> =
  {
    API: '渠道接口',
    FILE: '账单文件',
  };

export const RECONCILIATION_STATUS_LABEL: Record<ReconciliationStatus, string> =
  {
    RUNNING: '执行中',
    COMPLETED: '已完成',
    FAILED: '失败',
  };

export const RECONCILIATION_SEVERITY_LABEL: Record<
  ReconciliationSeverity,
  string
> = {
  INFO: '提示',
  WARNING: '警告',
  CRITICAL: '严重',
};

export const RECONCILIATION_RESOLUTION_LABEL: Record<
  ReconciliationResolution,
  string
> = {
  PENDING: '待处置',
  RESOLVED: '已处置',
  IGNORED: '已忽略',
};

/**
 * 差异类型的中文说明。
 *
 * ⚠️ **E 类与 F 类要写清「钱可能有问题」** —— 运营看到「渠道没有这笔」，
 *    要知道这意味着商家以为拿到了钱、实际可能没有。
 */
export const RECONCILIATION_DIFF_LABEL: Record<ReconciliationDiffType, string> =
  {
    CHANNEL_PENDING_LOCAL: '渠道已打款，本地还卡在「打款中」',
    CHANNEL_SUCCESS_LOCAL_FAILED: '渠道已打款，本地记成了失败',
    AMOUNT_MISMATCH: '渠道已打款，但金额与出款单不一致',
    CHANNEL_ONLY: '渠道有一笔打款，我们系统里没有对应的出款单',
    LOCAL_PAID_CHANNEL_ABSENT: '本地记着已付款，渠道查不到这笔',
    STATUS_MISMATCH: '渠道说这笔没打成功，本地却记着已付款',
  };

/**
 * 差异类型的严重级（前端按它排序，严重的置顶）。
 *
 * ⚠️ **必须与后端落库的 `severity` 一致** —— 后端是比对引擎算出来的，
 *    这里只是「同类型的兜底排序依据」，不让前端另算一套口径。
 */
export const RECONCILIATION_DIFF_SEVERITY: Record<
  ReconciliationDiffType,
  ReconciliationSeverity
> = {
  LOCAL_PAID_CHANNEL_ABSENT: 'CRITICAL',
  STATUS_MISMATCH: 'CRITICAL',
  AMOUNT_MISMATCH: 'CRITICAL',
  CHANNEL_ONLY: 'CRITICAL',
  CHANNEL_SUCCESS_LOCAL_FAILED: 'WARNING',
  CHANNEL_PENDING_LOCAL: 'INFO',
};

/** 严重级的排序权重（大的排前面） */
const SEVERITY_WEIGHT: Record<ReconciliationSeverity, number> = {
  CRITICAL: 3,
  WARNING: 2,
  INFO: 1,
};

/**
 * 差异项。
 *
 * ⚠️ **`localStatus` 的取值是出款单状态**（后端 Prisma 的 `PayoutStatus`），
 *    不是对账的状态 —— 前端展示时按出款单的文案翻。
 */
export interface ReconciliationItem {
  id: string;
  reconciliationId: string;
  type: ReconciliationDiffType;
  severity: ReconciliationSeverity;
  payoutId: string | null;
  channelTxnId: string | null;
  channelReferenceNo: string | null;
  channelAmount: number | null;
  channelStatus: string | null;
  channelPaidAt: string | null;
  localAmount: number | null;
  localStatus: string | null;
  resolution: ReconciliationResolution;
  resolvedBy: string | null;
  resolvedAt: string | null;
  note: string | null;
}

/**
 * 对账任务。
 *
 * ⚠️ **`items` 只在详情接口有** —— 列表接口不带差异项。
 */
export interface Reconciliation {
  id: string;
  channel: string;
  source: ReconciliationSource;
  windowFrom: string;
  windowTo: string;
  fileName: string | null;
  status: ReconciliationStatus;
  triggeredBy: string | null;
  startedAt: string;
  finishedAt: string | null;
  channelCount: number;
  localCount: number;
  matchedCount: number;
  diffCount: number;
  errorMessage: string | null;
  items?: ReconciliationItem[];
  /**
   * 差异项是否被服务端截断（阶段 5m）。
   *
   * ⚠️ **必须处理这个标记** —— 差异项最多能到上万条，
   *    服务端只返回前 200 条。静默截断会让运营以为「就这些差异」，
   *    漏掉的那批反而是最危险的。
   */
  itemsTruncated?: boolean;
  /**
   * 差异项的**真实总数**（截断前的条数）。
   *
   * ⚠️ **只有详情接口有**（列表接口不查差异项）。
   */
  itemsTotal?: number;
}

/** 列表接口的信封 */
export interface ReconciliationListResult {
  items: Reconciliation[];
  total: number;
}

/**
 * 未处置差异的统计（给横幅用）。
 */
export interface ReconciliationSummary {
  pendingCritical: number;
  pendingWarning: number;
  pendingInfo: number;
}

/**
 * 差异项按严重级排序（严重的置顶）。
 *
 * ⚠️ **排序只用后端给的 `severity`** —— 前端不自己按差异类型重算严重级，
 *    两套口径必然漂（后端改了一处、前端还按旧的排）。
 *
 * ⚠️ **同严重级保持原序**（`Array.prototype.sort` 在 V8 里是稳定的）：
 *    差异项没有业务上的先后顺序，保持后端返回的顺序比乱排更可预期。
 */
export function sortItemsBySeverity(items: ReconciliationItem[]): ReconciliationItem[] {
  return [...items].sort(
    (a, b) =>
      SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity],
  );
}

/**
 * CSV 账单的列映射（上传账单时由运营指定）。
 *
 * ⚠️ **必须与后端 `api/src/modules/payment/payout-reconciliation-csv.ts`
 *    的 `CsvColumnMapping` 逐字一致** —— 字段名对不上，
 *    后端的 `assertColumnMapping` 会直接拒掉整个导入。
 */
export interface CsvColumnMapping {
  /** 渠道交易号列（**必填** —— 没有它就无法匹配） */
  txnIdColumn: string;
  /** 业务单号列（选填） */
  referenceNoColumn?: string;
  /** 金额列（**必填**） */
  amountColumn: string;
  /**
   * ⚠️ **金额单位** —— 猜错就是金额差 100 倍。
   */
  amountUnit: 'CENT' | 'YUAN';
  /** 状态列（**必填** —— 不配就无从判断渠道是否真的打了款） */
  statusColumn: string;
  /**
   * ⚠️ **渠道状态词 → 内部状态** —— 与状态列同进同出。
   *    引擎只认 `'SUCCESS'` 与 `'FAILED'` 两个精确值，
   *    其余一律按「非终态 → 不算差异」处理。
   */
  statusMapping: Record<string, string>;
  /** 打款时间列（选填 —— 不配则 D 类差异检不出来） */
  paidAtColumn?: string;
}

/**
 * 导入渠道账单后的结果。
 *
 * ⚠️ **三个字段都不能省** ——
 *    `warning` 说「账单里没解析出任何打款时刻」（差异数仍是 0，
 *    但渠道多打的钱一笔都检不出来）；
 *    `skippedRowCount` / `skippedRows` 说「有行没能参与对账」
 *    （对账结论只基于剩下的行）。
 */
export interface CsvImportResult {
  /** 新生成的对账任务 id */
  id: string;
  /** 差异条数 */
  diffCount: number;
  /** 一致的条数 */
  matchedCount: number;
  /** 没解析出任何打款时刻时的警告 */
  warning?: string;
  /** 被跳过的行数 */
  skippedRowCount: number;
  /** 被跳过的行的明细（最多 100 条） */
  skippedRows: { rowNumber: number; reason: string }[];
  /** 明细是否被截断（只列了前 N 条） */
  skippedRowsTruncated: boolean;
}
