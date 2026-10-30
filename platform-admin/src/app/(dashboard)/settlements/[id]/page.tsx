import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import {
  COMMISSION_ENTRY_TYPE_LABEL,
  describeSettlementStatus,
  formatCommissionRate,
  formatDateTime,
  formatRevenueLabel,
  describeRecalculateHint,
  type SettlementDetail,
} from '@/lib/billing';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

import { SettlementRowActions } from '../settlement-actions';

/**
 * 平台结算单详情页（Server Component）。
 *
 * ⚠️ **明细的金额直接展示后端给的值**：明细是流水 join 出来的，
 *    前端不自己加总（与列表页同款原则）。
 */
export default async function SettlementDetailPage({
  params,
}: {
  // Next.js 15 起 params 是 Promise，必须 await。
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let statement: SettlementDetail | null = null;
  let error: string | null = null;

  try {
    statement = await apiFetchAuthed<SettlementDetail>(
      `/platform/settlements/${id}`,
    );
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 404) {
      notFound();
    }
    error =
      cause instanceof ApiError
        ? `加载结算单失败（${cause.status}）：${cause.message}`
        : cause instanceof Error
          ? cause.message
          : '结算单加载失败';
  }

  if (!statement) {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="text-2xl font-bold">结算单详情</h2>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">结算单详情</h2>
        <Link
          href="/settlements"
          className="text-sm underline-offset-4 hover:underline"
        >
          返回列表
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {statement.tenantName} · {statement.periodLabel}
          </CardTitle>
          <CardDescription>
            单号 {statement.statementNo} ·{' '}
            {describeSettlementStatus(statement.status)}
            {statement.confirmedAt
              ? ` · 确认于 ${formatDateTime(statement.confirmedAt)}`
              : ''}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3">
            <div className="flex gap-6 text-sm">
              <span>毛额 {formatRevenueLabel(statement.grossAmount)}</span>
              <span>冲回 {formatRevenueLabel(statement.reversalAmount)}</span>
              <span className="font-medium">
                净额 {formatRevenueLabel(statement.netAmount)}
              </span>
              <span className="text-muted-foreground">
                {statement.entryCount} 笔
              </span>
            </div>
            <SettlementRowActions
              statementId={statement.id}
              status={statement.status}
            />
            {/* ⚠️ **缺笔要在这里说清楚，并给出能走的下一步**：
                只报一个坏消息，超管还是不知道该做什么。
                ⚠️ **指引按「实际能走哪条路」写**（`describeRecalculateHint`）：
                `DRAFT` 直接「重算」、`CONFIRMED` 先「取消确认」再「重算」、
                有出款单引用（`canRecalculate` 为假）只能走调账流程。
                只看 `canRecalculate` 会给草稿单指一条走不通的路。 */}
            {statement.missingEntryCount > 0 && (
              <div className="flex flex-col gap-1 text-sm">
                <p className="text-destructive">
                  本期结算单缺 {statement.missingEntryCount}{' '}
                  笔抽佣流水，佣金与当期真实流水对不上。
                </p>
                <p className="text-muted-foreground">
                  {describeRecalculateHint(
                    statement.status,
                    statement.canRecalculate,
                  )}
                </p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>结算明细</CardTitle>
          <CardDescription>
            这一期纳入的抽佣流水：金额带符号（抽佣为正、冲回为负）。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {statement.entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无明细。</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>订单号</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>金额</TableHead>
                  <TableHead>费率</TableHead>
                  <TableHead>计佣基数</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {statement.entries.map((entry) => (
                  <TableRow key={entry.entryId}>
                    <TableCell className="text-muted-foreground">
                      {formatDateTime(entry.occurredAt)}
                    </TableCell>
                    <TableCell>{entry.orderNo}</TableCell>
                    <TableCell>
                      {COMMISSION_ENTRY_TYPE_LABEL[entry.type] ?? entry.type}
                    </TableCell>
                    <TableCell>{formatRevenueLabel(entry.amount)}</TableCell>
                    <TableCell>{formatCommissionRate(entry.rateBps)}</TableCell>
                    <TableCell>{formatRevenueLabel(entry.baseAmount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
