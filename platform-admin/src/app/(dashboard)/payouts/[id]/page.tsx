import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import {
  describePayoutEntryType,
  describePayoutStatus,
  describePayoutTimeline,
  formatCents,
  type PlatformPayoutDetail,
} from '@/lib/payout';
// ⚠️ **复用 `lib/billing.ts` 的 `formatDateTime`，不要在这里另写一份**：
//    两份实现迟早漂（时区格式、失败回显的措辞都会不一样）。
import { formatDateTime } from '@/lib/billing';
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

import { PayoutActions } from '../payout-actions';

/**
 * 平台侧出款单详情页（Server Component）。
 *
 * ⚠️ **明细的金额直接展示后端给的值**：明细是流水 join 出来的，
 *    前端不自己加总（与结算单详情页同款原则）。
 */
export default async function PayoutDetailPage({
  params,
}: {
  // Next.js 15 起 params 是 Promise，必须 await。
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let payout: PlatformPayoutDetail | null = null;
  let error: string | null = null;

  try {
    payout = await apiFetchAuthed<PlatformPayoutDetail>(
      `/platform/payouts/${id}`,
    );
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 404) {
      notFound();
    }
    error =
      cause instanceof ApiError
        ? `加载出款单失败（${cause.status}）：${cause.message}`
        : cause instanceof Error
          ? cause.message
          : '出款单加载失败';
  }

  if (!payout) {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="text-2xl font-bold">出款单详情</h2>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">出款单详情</h2>
        <Link
          href="/payouts"
          className="text-sm underline-offset-4 hover:underline"
        >
          返回列表
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {payout.tenantName} · {payout.periodLabel}
          </CardTitle>
          <CardDescription>
            单号 {payout.payoutNo} · {describePayoutStatus(payout.status)}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3">
            <div className="flex gap-6 text-sm">
              <span>货款净额 {formatCents(payout.receiptAmount)}</span>
              <span>佣金 {formatCents(payout.commissionAmount)}</span>
              <span className="font-medium">
                应结金额 {formatCents(payout.netAmount)}
              </span>
              <span className="text-muted-foreground">
                {payout.entryCount} 笔
              </span>
            </div>

            {/* ⚠️ **申请时的预估金额要单独显示**：审批时平台会**重算**
                并锁定金额，两者可能不同 —— 超管看到的「当前应结」是重算后的
                那个值，而商家申请时看到的是另一个数。 */}
            <p className="text-sm text-muted-foreground">
              申请时预估 {formatCents(payout.requestedAmount)}
              （审批通过时平台会重算一次并锁定，可能与上值不同）
            </p>

            {/* ⚠️ **时间说明按 `status` 走，不按「字段非空」走**：
                后端 `reject()` 也填 `approvedAt`（拒绝同样是一次审批动作），
                按字段非空显示就会出现「已拒绝 · 已审批」这种自相矛盾的说法。 */}
            <div className="text-sm text-muted-foreground">
              {describePayoutTimeline(payout)}
            </div>

            {payout.rejectedReason && (
              <p className="text-sm text-destructive">
                拒绝原因：{payout.rejectedReason}
              </p>
            )}

            <PayoutActions
              payoutId={payout.id}
              status={payout.status}
              requestedAmount={payout.requestedAmount}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>出款明细</CardTitle>
          <CardDescription>这一期纳入的货款流水，金额单位：元。</CardDescription>
        </CardHeader>
        <CardContent>
          {payout.entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无明细。</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>订单号</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>金额</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payout.entries.map((entry) => (
                  <TableRow key={entry.entryId}>
                    <TableCell className="text-muted-foreground">
                      {formatDateTime(entry.occurredAt)}
                    </TableCell>
                    <TableCell>{entry.orderNo}</TableCell>
                    {/* ⚠️ **不显示裸枚举**（`SALE` / `SALE_REVERSAL`） */}
                    <TableCell>{describePayoutEntryType(entry.type)}</TableCell>
                    <TableCell>{formatCents(entry.amount)}</TableCell>
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
