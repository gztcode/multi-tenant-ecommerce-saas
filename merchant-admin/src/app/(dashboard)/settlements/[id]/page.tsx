import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import {
  describePayoutEntryType,
  describePayoutStatus,
  describePayoutTimeline,
  formatCents,
} from '@/lib/payout';
import type { PayoutDetail } from '@/lib/payout';
// ⚠️ **复用 `lib/billing.ts` 的 `formatDateTime`，不要在页面里内联
//    `new Date(...).toLocaleString()`** —— 两份实现迟早漂。
import { formatDateTime } from '@/lib/billing';
import { PayoutCancelButton } from '../payout-cancel-button';

/**
 * 商家侧的出款单详情页（Server Component）。
 */
export default async function PayoutDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // Next.js 15 起 params 是 Promise，必须 await。
  const { id } = await params;

  let payout: PayoutDetail | null = null;
  let error: string | null = null;

  try {
    payout = await apiFetchAuthed<PayoutDetail>(`/merchant/payouts/${id}`);
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 404) {
      notFound();
    }
    error =
      cause instanceof ApiError
        ? `加载出款单失败：${cause.message}`
        : cause instanceof Error
          ? cause.message
          : '出款单加载失败';
  }

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="text-2xl font-bold">出款详情</h2>
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      </div>
    );
  }

  if (!payout) {
    return null;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">出款详情</h2>
        {/* ⚠️ **必须有返回列表的入口**：商家进详情后只能靠浏览器后退，
            那是浏览器行为不是站点行为（换个标签页就回不去了）。 */}
        <Link
          href="/settlements"
          className="text-sm underline-offset-4 hover:underline"
        >
          返回出款列表
        </Link>
      </div>

      <div className="flex flex-col gap-1 text-sm">
        <p>
          {payout.periodLabel} · 单号 {payout.payoutNo} ·{' '}
          {describePayoutStatus(payout.status)}
        </p>
        <p>
          货款净额 {formatCents(payout.receiptAmount)} · 平台佣金{' '}
          {formatCents(payout.commissionAmount)} · 应结金额{' '}
          {formatCents(payout.netAmount)} · {payout.entryCount} 笔
        </p>
        {/* ⚠️ **申请时的预估金额要单独显示**：审批时平台会**重算**
            并锁定金额，两者可能不同 —— 商家申请时看到的是预估那个数，
            不显示出来商家会以为金额没变过。 */}
        <p className="text-muted-foreground">
          申请时预估 {formatCents(payout.requestedAmount)}
          （审批通过时平台会重算一次并锁定，可能与上值不同）
        </p>
        {/* ⚠️ **时间说明按 `status` 走，不按「字段非空」走**：
            后端 `reject()` 也填 `approvedAt`（拒绝同样是一次审批动作），
            按字段非空显示就会出现「已拒绝 · 已审批」这种自相矛盾的说法。 */}
        <p className="text-muted-foreground">{describePayoutTimeline(payout)}</p>
        {payout.rejectedReason && (
          <p className="text-destructive">拒绝原因：{payout.rejectedReason}</p>
        )}
      </div>

      <PayoutCancelButton payoutId={payout.id} status={payout.status} />

      <div className="flex flex-col gap-2">
        <h3 className="text-lg font-semibold">出款明细</h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th>时间</th>
              <th>订单号</th>
              <th>类型</th>
              <th>金额</th>
            </tr>
          </thead>
          <tbody>
            {payout.entries.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-4 text-muted-foreground">
                  暂无明细。
                </td>
              </tr>
            ) : (
              payout.entries.map((entry) => (
                <tr key={entry.entryId} className="border-b">
                  <td>{formatDateTime(entry.occurredAt)}</td>
                  <td>{entry.orderNo}</td>
                  <td>{describePayoutEntryType(entry.type)}</td>
                  <td>{formatCents(entry.amount)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
