import Link from 'next/link';
import { apiFetchAuthed } from '@/lib/api-client';
import { formatDateTime } from '@/lib/billing';
import {
  RECONCILIATION_SOURCE_LABEL,
  RECONCILIATION_STATUS_LABEL,
  Reconciliation,
  ReconciliationListResult,
} from '@/lib/reconciliation';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { TriggerReconciliation } from './trigger-reconciliation';

/**
 * 每页条数（对账任务列表）。
 *
 * ⚠️ **固定 20 条** —— 对账任务是一张**只增不减**的历史表，
 *    运营关心的永远是「最近几批对得怎么样」，不需要一屏铺满上百行。
 */
const PAGE_SIZE = 20;

/**
 * 渠道对账任务列表（阶段 5m）。
 *
 * ⚠️ **服务端组件** —— 数据直连后端，不走 Next.js 的 `/api` 路由。
 */
export default async function ReconciliationsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const sp = await searchParams;
  // ⚠️ **页码要夹到 1 起** —— `?page=0` 或 `?page=abc` 会被后端
  //    的 `@Min(1)` 拒掉（整页报错），夹一下更省事。
  const parsedPage = Number.parseInt(sp.page ?? '1', 10);
  const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;

  const data = await apiFetchAuthed<ReconciliationListResult>(
    `/platform/payout-reconciliations?page=${page}&pageSize=${PAGE_SIZE}`,
  );

  const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">渠道对账</h1>
        <div className="flex items-center gap-2">
          {/* ⚠️ **「导入账单」是 CSV 渠道唯一的对账入口** ——
              真渠道没有批量查单接口，运营只能靠渠道账单对账。 */}
          <Button
            nativeButton={false}
            variant="outline"
            size="sm"
            render={<Link href="/reconciliations/import" />}
          >
            导入账单
          </Button>
          {/* ⚠️ **「立即对账」必须在这里** —— 定时对账每天只跑一次，
              运营临时发现「这批单有问题」时干等一天不可接受。 */}
          <TriggerReconciliation />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>对账任务</CardTitle>
        </CardHeader>
        <CardContent>
          {data.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">还没有对账任务。</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>渠道</TableHead>
                  <TableHead>来源</TableHead>
                  <TableHead>时间窗</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>本地单</TableHead>
                  <TableHead>渠道流水</TableHead>
                  <TableHead>一致</TableHead>
                  <TableHead>差异</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((item: Reconciliation) => (
                  <TableRow key={item.id}>
                    <TableCell>{item.channel}</TableCell>
                    <TableCell>
                      {RECONCILIATION_SOURCE_LABEL[item.source] ?? item.source}
                    </TableCell>
                    <TableCell className="text-xs">
                      {formatDateTime(item.windowFrom)} ~{' '}
                      {formatDateTime(item.windowTo)}
                    </TableCell>
                    <TableCell>
                      {RECONCILIATION_STATUS_LABEL[item.status] ?? item.status}
                    </TableCell>
                    <TableCell>{item.localCount}</TableCell>
                    <TableCell>{item.channelCount}</TableCell>
                    <TableCell>{item.matchedCount}</TableCell>
                    <TableCell>
                      {/* ⚠️ **差异数链到详情页** —— 运营要点进去看具体差在哪。 */}
                      <Link
                        href={`/reconciliations/${item.id}`}
                        className="underline-offset-4 hover:underline"
                      >
                        {item.diffCount}
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {totalPages > 1 && (
            <div className="mt-4 flex items-center gap-4 text-sm">
              <Link
                href={`/reconciliations?page=${page - 1}`}
                className={
                  page <= 1
                    ? 'pointer-events-none opacity-40'
                    : 'underline-offset-4 hover:underline'
                }
              >
                上一页
              </Link>
              <span>
                第 {page} / {totalPages} 页，共 {data.total} 条
              </span>
              <Link
                href={`/reconciliations?page=${page + 1}`}
                className={
                  page >= totalPages
                    ? 'pointer-events-none opacity-40'
                    : 'underline-offset-4 hover:underline'
                }
              >
                下一页
              </Link>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
