import Link from 'next/link';
import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import {
  describeSettlementStatus,
  formatRevenueLabel,
  type SettlementListResult,
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
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { SettlementGenerateForm, SettlementRowActions } from './settlement-actions';

/**
 * 平台结算单列表页（Server Component）。
 *
 * ⚠️ **净单一律用后端返回的 `netAmount`，前端不自己加总**：
 * 与抽佣明细页「前端绝不自己算净额」同款原则。
 *
 * ⚠️ **区间来自 URL**（`?period=YYYY-MM`）：
 * 这样结算单的周期可以分享、可以后退，也就不用引入客户端 state。
 */
export default async function SettlementsPage({
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

  let list: SettlementListResult | null = null;
  let error: string | null = null;

  if (!periodError) {
    try {
      // ⚠️ **显式请求 `pageSize=200`**（后端 `pageSize` 的上限就是 200）：
      // 结算单的数量天然比套餐 / 订阅大一到两个数量级（商家数 × 月数），
      // 用后端缺省的 50 条会有一大半看不到，而超管连翻页都无从下手。
      const query = periodParam
        ? `?period=${encodeURIComponent(periodParam)}&pageSize=200`
        : '?pageSize=200';
      list = await apiFetchAuthed<SettlementListResult>(
        `/platform/settlements${query}`,
      );
    } catch (cause) {
      if (cause instanceof ApiError) {
        error = `加载结算单失败（${cause.status}）：${cause.message}`;
      } else {
        error = cause instanceof Error ? cause.message : '结算单加载失败';
      }
    }
  }

  const items = list?.items ?? [];

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-bold">结算单</h2>

      {periodError && <p className="text-sm text-destructive">{periodError}</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* ⚠️ **纯 GET 表单**：提交就是一次普通的页面跳转，不需要任何客户端 JS。 */}
      <form method="get" action="/settlements" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="settlement-filter-period">结算周期</Label>
            <Input
              id="settlement-filter-period"
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

      {/* ⚠️ **周期非法时不给表单预填**：否则表单初值就是那个非法值，
          超管点「生成」后客户端校验会再报一遍跟上面一模一样的错，
          同一屏出现两条相同的提示。 */}
      <SettlementGenerateForm
        period={periodError ? undefined : periodParam}
      />

      {list && (
        <Card>
          <CardHeader>
            <CardTitle>结算单</CardTitle>
            <CardDescription>
              共 {list.total} 张
              {list.total > items.length ? `（本页显示 ${items.length} 张）` : ''}
              {/* ⚠️ **明确告诉超管超量时怎么办**：本页一次最多取 200 张
                  （后端 `pageSize` 上限），超出部分只能靠筛选缩小范围。 */}
              {list.total > items.length ? '。超过 200 张时请按周期筛选' : ''}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {items.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无结算单。</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>商家</TableHead>
                    <TableHead>周期</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>毛额</TableHead>
                    <TableHead>冲回</TableHead>
                    <TableHead>净额</TableHead>
                    <TableHead>笔数</TableHead>
                    <TableHead>缺笔</TableHead>
                    <TableHead>单号</TableHead>
                    <TableHead>操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((statement) => (
                    <TableRow key={statement.id}>
                      <TableCell className="font-medium">
                        <Link
                          href={`/settlements/${statement.id}`}
                          className="underline-offset-4 hover:underline"
                        >
                          {statement.tenantName}
                        </Link>
                      </TableCell>
                      <TableCell>{statement.periodLabel}</TableCell>
                      <TableCell>
                        {describeSettlementStatus(statement.status)}
                      </TableCell>
                      {/* ⚠️ **金额直接用后端返回的三个数**，前端不加总。 */}
                      <TableCell>{formatRevenueLabel(statement.grossAmount)}</TableCell>
                      <TableCell>
                        {formatRevenueLabel(statement.reversalAmount)}
                      </TableCell>
                      <TableCell>{formatRevenueLabel(statement.netAmount)}</TableCell>
                      <TableCell>{statement.entryCount}</TableCell>
                      {/* ⚠️ **缺笔数是后端给的，前端不自己比**：
                          缺笔 = 当期真实流水笔数 − 结算单纳入的笔数。
                          0 时显示「—」——「缺 0 笔」是自相矛盾的说法。 */}
                      <TableCell>
                        {statement.missingEntryCount > 0 ? (
                          <span className="text-destructive">
                            缺 {statement.missingEntryCount} 笔
                          </span>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell>
                        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                          {statement.statementNo}
                        </code>
                      </TableCell>
                      <TableCell>
                        <SettlementRowActions
                          statementId={statement.id}
                          status={statement.status}
                        />
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
