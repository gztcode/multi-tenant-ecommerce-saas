import Link from 'next/link';
import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import {
  describePayoutKind,
  describePayoutStatus,
  formatCents,
  type PayoutListResult,
} from '@/lib/payout';
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
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * 平台侧的出款单列表页（Server Component）。
 *
 * ⚠️ **金额一律用后端返回的值**：前端自己把「货款 − 佣金」加总一遍，
 * 就是第二套口径，迟早漂。
 *
 * ⚠️ **周期来自 URL**（`?period=YYYY-MM`）：出款单的周期可以分享、
 * 可以后退，也就不用引入客户端 state（与结算单列表页同款做法）。
 */
export default async function PayoutsPage({
  searchParams,
}: {
  // Next.js 15 起 searchParams 是 Promise，必须 await。
  searchParams: Promise<{ period?: string }>;
}) {
  const { period: periodParam } = await searchParams;

  // ⚠️ **格式不对就不调后端**：非法的周期明细比没有明细更糟。
  const periodError =
    periodParam && !/^\d{4}-(0[1-9]|1[0-2])$/.test(periodParam)
      ? '周期格式非法：必须是 YYYY-MM（如 2026-10）'
      : null;

  let list: PayoutListResult | null = null;
  let error: string | null = null;

  if (!periodError) {
    try {
      // ⚠️ **显式请求 `pageSize=100`**（后端 `clampPagination` 的
      // `MAX_PAGE_SIZE` 就是 100，再大也会被夹回 100）：
      // 出款单的数量天然比套餐 / 订阅大一到两个数量级（商家数 × 月数），
      // 用后端缺省的条数会有一大半看不到，而超管连翻页都无从下手。
      const query = periodParam
        ? `?period=${encodeURIComponent(periodParam)}&pageSize=100`
        : '?pageSize=100';
      list = await apiFetchAuthed<PayoutListResult>(`/platform/payouts${query}`);
    } catch (cause) {
      if (cause instanceof ApiError) {
        error = `加载出款单失败（${cause.status}）：${cause.message}`;
      } else {
        error = cause instanceof Error ? cause.message : '出款单加载失败';
      }
    }
  }

  const items = list?.items ?? [];

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-bold">出款</h2>

      {periodError && <p className="text-sm text-destructive">{periodError}</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* ⚠️ **纯 GET 表单**：提交就是一次普通的页面跳转，不需要任何客户端 JS。 */}
      <form method="get" action="/payouts" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="payout-filter-period">出款周期</Label>
            <Input
              id="payout-filter-period"
              type="month"
              name="period"
              defaultValue={periodParam ?? ''}
            />
          </div>
          <Button type="submit">查询</Button>
        </div>
        <p className="text-sm text-muted-foreground">
          不选周期 = 全部周期。周期按 UTC 自然月计算，左闭右开。
        </p>
      </form>

      {list && (
        <Card>
          <CardHeader>
            <CardTitle>出款单</CardTitle>
            <CardDescription>
              共 {list.total} 张
              {list.total > items.length ? `（本页显示 ${items.length} 张）` : ''}
              {/* ⚠️ **明确告诉超管超量时怎么办**：本页一次最多取 100 张
                  （后端 `clampPagination` 的 `MAX_PAGE_SIZE`），超出部分只能靠筛选缩小范围。 */}
              {list.total > items.length ? '。超过 100 张时请按周期筛选' : ''}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {items.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无出款单。</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>商家</TableHead>
                    <TableHead>周期</TableHead>
                    <TableHead>类型</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>货款净额</TableHead>
                    <TableHead>佣金</TableHead>
                    <TableHead>应结金额</TableHead>
                    <TableHead>笔数</TableHead>
                    <TableHead>单号</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((payout) => (
                    <TableRow key={payout.id}>
                      <TableCell className="font-medium">
                        {/* ⚠️ **商家名链到详情页**：超管要能点进去审批。 */}
                        <Link
                          href={`/payouts/${payout.id}`}
                          className="underline-offset-4 hover:underline"
                        >
                          {payout.tenantName}
                        </Link>
                      </TableCell>
                      <TableCell>{payout.periodLabel}</TableCell>
                      {/* ⚠️ **类型要单列出来**：补差出款是**增量**，
                          混在正常出款里超管会按同一口径核账。 */}
                      <TableCell>{describePayoutKind(payout.kind)}</TableCell>
                      <TableCell>
                        {/* ⚠️ **卡住标红**：钱可能已经打出去了，
                            运营需要人工去查 —— 前端只提醒，不做任何自动处理。 */}
                        <span className={isStuck(payout) ? 'text-destructive' : undefined}>
                          {describePayoutStatus(payout.status)}
                        </span>
                        {/* ⚠️ **失败原因与尝试次数要显示出来**：
                            运营需要知道「试了几次、为什么失败」才能决定怎么补。 */}
                        {payout.status === 'FAILED' && payout.failureReason && (
                          <p className="text-xs text-muted-foreground">
                            {payout.failureReason}（已尝试 {payout.attemptCount} 次）
                          </p>
                        )}
                      </TableCell>
                      {/* ⚠️ **金额直接用后端返回的三个数**，前端不加总。 */}
                      <TableCell>{formatCents(payout.receiptAmount)}</TableCell>
                      <TableCell>{formatCents(payout.commissionAmount)}</TableCell>
                      <TableCell>{formatCents(payout.netAmount)}</TableCell>
                      {/* ⚠️ **带单位（「N 笔」）**：光一个裸数字会跟页面上的
                          其它数字（周期 `2026-01`、金额 `¥999.99`）混淆，
                          断言与阅读都容易对错行。 */}
                      <TableCell>{payout.entryCount} 笔</TableCell>
                      <TableCell>
                        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                          {payout.payoutNo}
                        </code>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/**
 * 这张单是不是卡在「打款中」太久了。
 *
 * ⚠️ **阈值 10 分钟**，与后端兜底扫描的阈值一致。
 *
 * ⚠️ **前端只标红提醒，不做任何处理** ——
 *    后端**绝不自动重试**卡在 `PROCESSING` 的单：
 *    这个状态最可能的成因是「请求发出去了、回包丢了」，
 *    钱**可能已经打到商家账上** —— 自动重试等于确定性地重复打款。
 */
function isStuck(payout: {
  status: string;
  processingAt: string | null;
}): boolean {
  if (payout.status !== 'PROCESSING' || !payout.processingAt) {
    return false;
  }
  const elapsed = Date.now() - new Date(payout.processingAt).getTime();
  return elapsed > 10 * 60 * 1000;
}
