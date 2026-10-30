import Link from 'next/link';
import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import {
  describeMissingEntries,
  describeStatementStatus,
  formatCents,
} from '@/lib/statement';
import type { StatementPeriod } from '@/lib/statement';

/**
 * 商家侧的「对账单」列表页（Server Component）。
 *
 * ⚠️ **merchant-admin 没有 `Table` 组件** → 用裸 `<table>`
 * （照抄 `merchant-admin/src/app/(dashboard)/settlements/page.tsx` 的写法）。
 *
 * ⚠️ **金额一律用后端返回的值**：前端自己把「货款 − 佣金」加总一遍，
 *    就是第二套口径，迟早漂。
 *
 * ⚠️ **这一页列出的是「所有有货款的期」**（不只是能申请出款的期）——
 *    商家要能看见「我这期有货款，但结算单还没确认」，
 *    否则只能打电话问客服（后端 `MerchantStatementService.list()` 的口径）。
 */
export default async function StatementsPage() {
  let rows: StatementPeriod[] | null = null;
  let error: string | null = null;

  try {
    rows = await apiFetchAuthed<StatementPeriod[]>('/merchant/statements');
  } catch (cause) {
    error =
      cause instanceof ApiError
        ? `加载对账单失败：${cause.message}`
        : cause instanceof Error
          ? cause.message
          : '对账单加载失败';
  }

  const periods = rows ?? [];

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-bold">对账单</h2>
      {/* ⚠️ **口径说明不能省**：货款是实时流水、佣金以已确认的结算单为准，
          商家看到「应结」会变，不说清楚就会来问「为什么金额变了」。 */}
      <p className="text-sm text-muted-foreground">
        货款按流水实时统计，平台佣金以已确认的结算单为准。
      </p>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {rows && (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th>周期</th>
              <th>结算单状态</th>
              <th>货款净额</th>
              <th>平台佣金</th>
              <th>应结金额</th>
              <th>已出款</th>
              <th>待出款</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {periods.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-4 text-muted-foreground">
                  还没有货款入账。
                </td>
              </tr>
            ) : (
              periods.map((row) => {
                // ⚠️ **先算一次再渲染**：条件与内容用同一个值，
                //    免得两处各调一次函数（万一将来它不是纯函数就会不一致）。
                const missingHint = describeMissingEntries(row.missingEntryCount);
                return (
                <tr key={row.period} className="border-b">
                  <td>
                    {/* ⚠️ **周期链到详情页**：商家要在这一期里逐笔核对。 */}
                    <Link href={`/statements/${row.period}`} className="underline">
                      {row.period}
                    </Link>
                  </td>
                  <td>
                    {describeStatementStatus(row.statementStatus)}
                    {/* ⚠️ **缺笔提示要显眼**：结算单少纳了几笔抽佣流水，
                        商家对账时看到明细与金额对不上，得知道去问谁。
                        ⚠️ **文案只陈述事实**：缺哪一类、该谁补钱，
                        得平台自己判断，商家端不替平台下结论。 */}
                    {missingHint && (
                      <p className="text-xs text-muted-foreground">
                        {missingHint}
                      </p>
                    )}
                  </td>
                  <td>{formatCents(row.receiptAmount)}</td>
                  {/* ⚠️ **佣金是带符号的**（正数 = 平台抽了，负数 = 平台退了）：
                      直接展示，不要自己加负号 —— 符号已经是数据的一部分。 */}
                  <td>
                    {row.commissionAmount === null
                      ? '—'
                      : formatCents(row.commissionAmount)}
                  </td>
                  {/* ⚠️ **应结金额一律用后端返回的值**：
                      后端给 null 说明佣金还没算（没有结算单），
                      这与「佣金是 0」是两回事 —— 填 0 会让商家
                      以为这一期不用扣佣。 */}
                  <td>
                    {row.payableAmount === null
                      ? '—'
                      : formatCents(row.payableAmount)}
                  </td>
                  <td>{formatCents(row.paidAmount)}</td>
                  <td>
                    {row.pendingAmount === null
                      ? '—'
                      : formatCents(row.pendingAmount)}
                  </td>
                  <td>
                    {/* ⚠️ **状态列的优先级不能换**：
                        超付最要紧（平台多付了钱，要调账）→ 排在最前；
                        其次是「不能申请的原因」（商家要知道自己为什么提不了）；
                        再是可申请的种类；都没有就是「—」。 */}
                    {row.overpaidAmount > 0 ? (
                      <span className="text-destructive">
                        已超付 {formatCents(row.overpaidAmount)}，待平台调账
                      </span>
                    ) : row.blockedReason ? (
                      <span className="text-muted-foreground">
                        {row.blockedReason}
                      </span>
                    ) : row.applicableKind === 'SUPPLEMENT' ? (
                      '可申请补差'
                    ) : row.applicableKind === 'NORMAL' ? (
                      '可申请出款'
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
                );
              })
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
