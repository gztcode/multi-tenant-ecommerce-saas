import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, apiFetchAuthed } from '@/lib/api-client';
// ⚠️ **复用 `lib/billing.ts` 的 `formatDateTime`，不要在页面里内联
//    `new Date(...).toLocaleString()`** —— 两份实现迟早漂。
import { formatDateTime } from '@/lib/billing';
import {
  describeCommissionEntryType,
  describeReceiptPayoutStatus,
  describeReceiptType,
  describeStatementStatus,
  formatCents,
  formatRateBps,
} from '@/lib/statement';
import type { StatementPeriodDetail } from '@/lib/statement';

/**
 * 商家侧的对账单详情页（Server Component）。
 *
 * ⚠️ **金额一律用后端返回的值**：前端自己加总就是第二套口径，迟早漂。
 */
export default async function StatementDetailPage({
  params,
}: {
  params: Promise<{ period: string }>;
}) {
  // Next.js 15 起 params 是 Promise，必须 await。
  const { period } = await params;

  let data: StatementPeriodDetail | null = null;
  let error: string | null = null;

  try {
    data = await apiFetchAuthed<StatementPeriodDetail>(
      `/merchant/statements/${period}`,
    );
  } catch (cause) {
    // ⚠️ **404 要交给 `notFound()`**：这一期压根不存在时，
    //    渲染一个「加载失败」页比渲染 404 更让商家困惑。
    if (cause instanceof ApiError && cause.status === 404) {
      notFound();
    }
    error =
      cause instanceof ApiError
        ? `加载对账单失败：${cause.message}`
        : cause instanceof Error
          ? cause.message
          : '对账单加载失败';
  }

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="text-2xl font-bold">对账单详情</h2>
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      </div>
    );
  }

  if (!data) {
    return null;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">对账单详情</h2>
        {/* ⚠️ **必须有返回列表的入口**：商家进详情后只能靠浏览器后退，
            那是浏览器行为不是站点行为。 */}
        <Link
          href="/statements"
          className="text-sm underline-offset-4 hover:underline"
        >
          返回对账单列表
        </Link>
      </div>

      <div className="flex flex-col gap-1 text-sm">
        <p>
          {data.period} · 结算单状态{' '}
          {describeStatementStatus(data.statementStatus)}
        </p>
        <p>
          货款净额 {formatCents(data.receiptAmount)} · 平台佣金{' '}
          {data.commissionAmount === null
            ? '—'
            : formatCents(data.commissionAmount)}{' '}
          · 应结金额{' '}
          {data.payableAmount === null ? '—' : formatCents(data.payableAmount)}{' '}
          · 已出款 {formatCents(data.paidAmount)} · 在途{' '}
          {formatCents(data.inFlightAmount)} · 待出款{' '}
          {data.pendingAmount === null
            ? '—'
            : formatCents(data.pendingAmount)}
        </p>
        {/* ⚠️ **口径说明不能省**：商家看到「应结」这一期一个数、下一期又变，
            必须告诉他为什么 —— 货款按流水实时统计，佣金以已确认的结算单为准。 */}
        <p className="text-muted-foreground">
          货款按流水实时统计，平台佣金以已确认的结算单为准。
        </p>
        {/* ⚠️ **超付要显眼**：平台多付了钱，等着调账 ——
            商家看到「待出款 0」却不知道原因时会以为漏付。 */}
        {data.overpaidAmount > 0 && (
          <p className="text-destructive">
            本期已超付 {formatCents(data.overpaidAmount)}，待平台调账。
          </p>
        )}
        {data.blockedReason && (
          <p className="text-muted-foreground">{data.blockedReason}</p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-lg font-semibold">抽佣明细</h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th>时间</th>
              <th>订单号</th>
              <th>类型</th>
              <th>计佣基数</th>
              <th>费率</th>
              <th>佣金</th>
            </tr>
          </thead>
          <tbody>
            {data.commissionEntries.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-4 text-muted-foreground">
                  暂无抽佣明细。
                </td>
              </tr>
            ) : (
              data.commissionEntries.map((entry) => (
                <tr key={entry.entryId} className="border-b">
                  <td>{formatDateTime(entry.occurredAt)}</td>
                  <td>{entry.orderNo}</td>
                  {/* ⚠️ **类型翻成中文**：裸枚举商家看不懂。 */}
                  <td>{describeCommissionEntryType(entry.type)}</td>
                  <td>{formatCents(entry.baseAmount)}</td>
                  {/* ⚠️ **费率显示成百分数**（`500 bps` 商家看不懂）。 */}
                  <td>{formatRateBps(entry.rateBps)}</td>
                  {/* ⚠️ **佣金是带符号的**：冲回是负数，不要自己加负号。 */}
                  <td>{formatCents(entry.amount)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-lg font-semibold">货款明细</h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th>时间</th>
              <th>订单号</th>
              <th>类型</th>
              <th>金额</th>
              <th>出款状态</th>
            </tr>
          </thead>
          <tbody>
            {data.receiptEntries.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-4 text-muted-foreground">
                  暂无货款明细。
                </td>
              </tr>
            ) : (
              data.receiptEntries.map((entry) => (
                <tr key={entry.entryId} className="border-b">
                  <td>{formatDateTime(entry.occurredAt)}</td>
                  <td>{entry.orderNo}</td>
                  <td>{describeReceiptType(entry.type)}</td>
                  <td>{formatCents(entry.amount)}</td>
                  {/* ⚠️ **标出哪笔已经给过了**：商家最常问的两件事是
                      「哪笔钱还没给我」与「哪笔已经给了」。
                      ⚠️ **三态**：在途的单标「出款中」，
                      否则商家看到「已出款」却没收到钱就会来投诉。 */}
                  <td>{describeReceiptPayoutStatus(entry.payoutStatus)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
