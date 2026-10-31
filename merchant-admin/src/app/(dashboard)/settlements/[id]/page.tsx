import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import {
  describePayoutAccount,
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

  // ⚠️ **先算一次再渲染**：条件与内容用同一个值，
  //    免得两处各调一次函数（万一将来它不是纯函数就会不一致）。
  const accountText = describePayoutAccount(payout);

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
        {/* ⚠️ **收款账户（申请时）要显示**：商家必须能看出「钱打给谁」。
            阶段 5j 之后库里只有密文，**掩码串是唯一能核对的东西** ——
            界面上不显示它，商家就只能打电话问。

            ⚠️ **显示的是申请那一刻的快照**，不是当前账户 ——
            商家申请后改过账户的话两者会不同，而**钱打给的是快照那份**。
            所以文案要写明「申请时」。

            ⚠️ **只显示掩码串，绝不显示完整账号** —— 完整账号压根不在响应里，
            前端也不去解密。 */}
        {accountText && (
          <p className="text-sm">
            收款账户（申请时）：{accountText}
          </p>
        )}
        {/* ⚠️ **时间说明按 `status` 走，不按「字段非空」走**：
            后端 `reject()` 也填 `approvedAt`（拒绝同样是一次审批动作），
            按字段非空显示就会出现「已拒绝 · 已审批」这种自相矛盾的说法。 */}
        <p className="text-muted-foreground">{describePayoutTimeline(payout)}</p>
        {/* ⚠️ **打款时刻要显示**：商家最关心的是「钱什么时候打过来的」，
            只显示「申请时间」商家无从判断钱到没到账。
            时间格式复用 `lib/billing.ts` 的 `formatDateTime`，不自己造。 */}
        {payout.status === 'PAID' && payout.paidAt && (
          <p className="text-muted-foreground">
            打款时间 {formatDateTime(payout.paidAt)}
          </p>
        )}
        {/* ⚠️ **失败时刻同样要显示**：便于商家与平台对账是哪一次尝试失败的。 */}
        {payout.status === 'FAILED' && payout.failedAt && (
          <p className="text-destructive">
            失败时间 {formatDateTime(payout.failedAt)}
          </p>
        )}
        {payout.rejectedReason && (
          <p className="text-destructive">拒绝原因：{payout.rejectedReason}</p>
        )}
        {/* ⚠️ **补差单的佣金是 0，这段话不能省**（设计 §6.4）：
            商家一定会问「这 5000 块为什么不抽佣」，不说清楚就会反复申诉。 */}
        {payout.kind === 'SUPPLEMENT' && (
          <p className="text-sm text-muted-foreground">
            这是补差出款单：该期结算单已结清，本期补差按零佣金结算。
          </p>
        )}
        {/* ⚠️ **失败原因直接用后端给的业务口径**（阶段 5l）——
            后端按「钱打没打出去」分流：
            ① 确定没打（账户不可用 / 金额异常 / 人工转失败）
               → 「收款账号信息异常，本次未打款，请更新收款账户后重新申请」
            ② 可能已打（渠道试满 / 金额核对不通过）
               → 「出款未完成，请联系平台确认出款情况」
            ⚠️ **不要再自己包「出款失败：」与「请联系平台确认出款情况。」** ——
            后端给的是**完整的一句话**，前端再包一遍会变成
            「出款失败：出款未完成，请联系平台确认出款情况。请联系平台确认出款情况。」
            而且第 ① 类会自相矛盾（前面说「本次未打款」后面说「请联系平台确认」）。 */}
        {payout.status === 'FAILED' && payout.failureReason && (
          <p className="text-sm text-destructive">{payout.failureReason}</p>
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
