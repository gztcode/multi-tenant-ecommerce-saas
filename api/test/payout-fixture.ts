import { randomBytes } from 'node:crypto';
import { PayoutKind, PayoutStatus } from '@prisma/client';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import {
  platformScope,
  tenantContext,
} from '../src/common/tenant/tenant-context';

/** 一天的毫秒数 */
export const DAY_MS = 24 * 3600 * 1000;

/** 一个自然月的区间（左闭右开） */
export interface Period {
  label: string;
  from: Date;
  to: Date;
}

/** 造一个自然月区间 */
export function month(label: string): Period {
  const [year, m] = label.split('-').map(Number);
  return {
    label,
    from: new Date(Date.UTC(year, m - 1, 1)),
    to: new Date(Date.UTC(year, m, 1)),
  };
}

/** 区间内的某个时刻（避开边界） */
export function inside(period: Period, offsetDays: number): Date {
  return new Date(period.from.getTime() + offsetDays * DAY_MS);
}

/**
 * 造数用的结算期序号。
 *
 * ⚠️ **为什么需要它** —— 部分唯一索引
 *    `payouts_tenantId_period_kind_active_uniq`
 *    = `(tenantId, periodStart, kind) WHERE status NOT IN ('REJECTED','CANCELLED','FAILED')`
 *    → **同一租户下两张活跃单（`PAID` / `PROCESSING` / `REQUESTED` / `APPROVED`）
 *    不能有相同的 `periodStart`**。
 *    对账用例常常要给同一个商家造 5 张不同状态的单（其中 4 张是活跃的）
 *    → 结算期必须自动错开，否则插库直接撞 P2002。
 */
let periodSeq = 0;

/** 自动错开的结算期起点 */
function nextPeriodStart(): Date {
  periodSeq += 1;
  return new Date(Date.UTC(2021, 0, 1) + periodSeq * DAY_MS);
}

/** 造一张出款单时要什么 */
export interface SeedPayoutOptions {
  /** 商家租户 id */
  tenantId: string;
  /** 出款单状态 */
  status: PayoutStatus;
  /** 结算期起点 —— 留空则自动错开（见 `nextPeriodStart`） */
  periodStart?: Date;
  /** 结算期终点 —— 留空则 `periodStart + 30 天` */
  periodEnd?: Date;
  /** 货款净额（正数） */
  receiptAmount?: number;
  /** 佣金净额（正数） */
  commissionAmount?: number;
  /** 应结给商家的金额 —— 留空则 `receiptAmount − commissionAmount` */
  netAmount?: number;
  /** 纳入的货款流水笔数 */
  entryCount?: number;
  /** 出款单号 —— 留空则随机 */
  payoutNo?: string;
  /** 打款渠道名 */
  payoutChannel?: string | null;
  /** 渠道交易号 */
  payoutTxnId?: string | null;
  /** 已尝试次数 */
  attemptCount?: number;
  /** 失败原因 */
  failureReason?: string | null;
  /** 「钱确定没打出去」的标记 */
  failedBeforePayout?: boolean;
  /** 释放的明细 id（JSON 数组字符串）—— 阶段 5m 新增的字段 */
  releasedEntryIds?: string | null;
  /** 开始执行的时刻 */
  processingAt?: Date | null;
  /** 打款成功时刻 */
  paidAt?: Date | null;
  /** 失败落终态的时刻 */
  failedAt?: Date | null;
}

/** 造出来的一张出款单 */
export interface SeededPayout {
  id: string;
  payoutNo: string;
  netAmount: number;
  receiptAmount: number;
  commissionAmount: number;
  entryCount: number;
  status: PayoutStatus;
}

/**
 * 造一张出款单（直接插库，不走支付链路）。
 *
 * ⚠️ **只把「用例真正要区分的字段」做成必填**（`tenantId`、`status`），
 *    其余都有自洽的默认值：
 *    `receiptAmount = 10000`、`commissionAmount = 0`、
 *    `netAmount = receiptAmount − commissionAmount`、`entryCount = 0`。
 *
 * ⚠️ **账户快照留空** —— 对账用例不打款，不需要可解密的快照。
 *    真要打款的用例走「申请 → 审批」的真链路（`payout-execution.e2e-spec.ts` 那样）。
 */
export async function seedPayout(
  prisma: TenantPrismaService,
  options: SeedPayoutOptions,
): Promise<SeededPayout> {
  const receiptAmount = options.receiptAmount ?? 10_000;
  const commissionAmount = options.commissionAmount ?? 0;
  const netAmount = options.netAmount ?? receiptAmount - commissionAmount;
  const periodStart = options.periodStart ?? nextPeriodStart();
  const periodEnd =
    options.periodEnd ?? new Date(periodStart.getTime() + 30 * DAY_MS);

  const created = await tenantContext.run(platformScope(), async () =>
    prisma.payout.create({
      data: {
        tenantId: options.tenantId,
        payoutNo: options.payoutNo ?? `P5M-${randomBytes(6).toString('hex')}`,
        kind: PayoutKind.NORMAL,
        periodStart,
        periodEnd,
        statementId: null,
        receiptAmount,
        commissionAmount,
        netAmount,
        entryCount: options.entryCount ?? 0,
        status: options.status,
        requestedAmount: netAmount,
        requestedBy: 'test-merchant-user',
        approvedBy: null,
        approvedAt: null,
        attemptCount: options.attemptCount ?? 0,
        failureReason: options.failureReason ?? null,
        failedBeforePayout: options.failedBeforePayout ?? false,
        processingAt: options.processingAt ?? null,
        paidAt: options.paidAt ?? null,
        failedAt: options.failedAt ?? null,
        payoutChannel: options.payoutChannel ?? null,
        payoutTxnId: options.payoutTxnId ?? null,
        releasedEntryIds: options.releasedEntryIds ?? null,
        snapshotAccountName: null,
        snapshotBankName: null,
        snapshotAccountNoCipher: null,
        snapshotMaskedAccountNo: null,
        snapshotEncryptionVersion: 0,
      },
    }),
  );

  return {
    id: created.id,
    payoutNo: created.payoutNo,
    netAmount: created.netAmount,
    receiptAmount: created.receiptAmount,
    commissionAmount: created.commissionAmount,
    entryCount: created.entryCount,
    status: created.status,
  };
}

/**
 * 清掉所有出款单与对账数据。
 *
 * ⚠️ **为什么对账的 spec 必须调它** —— e2e 文件之间**共享同一个测试库**：
 *    `globalSetup` 每轮只清库一次，各 spec 文件之间不再清理 →
 *    前一个文件留下的出款单会进后一个文件的**对账结果**
 *    （本地 `PAID` + 渠道查无此笔 → 多出一条 E 类差异）。
 *    → 对账的 spec 必须在 `beforeAll` 里从干净状态开始。
 *
 * ⚠️ **删表顺序要紧**（外键）：
 *    ① `payout_reconciliation_items` 引用 `payout_reconciliations`；
 *    ② `payout_entries` / `payout_operations` 引用 `payouts`；
 *    ③ 最后才是 `payouts`。
 *
 * ⚠️ **不清 `merchant_receipts` 与 `settlement_statements`** ——
 *    出款单引用它们、不是它们引用出款单 → 留着不影响对账（对账只看 `payouts`），
 *    清了反而可能撞 Restrict 外键。
 */
export async function resetPayoutData(
  prisma: TenantPrismaService,
): Promise<void> {
  await tenantContext.run(platformScope(), async () => {
    await prisma.payoutReconciliationItem.deleteMany();
    await prisma.payoutReconciliation.deleteMany();
    await prisma.payoutEntry.deleteMany();
    await prisma.payoutOperation.deleteMany();
    await prisma.payout.deleteMany();
  });
}
