import Link from 'next/link';
import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import { paginatedEntriesResponse } from '@ecom/frontend-shared/pagination-schema';
import {
  COMMISSION_ENTRY_TYPE_LABEL,
  formatCommissionRate,
  formatDateTime,
  formatRevenueLabel,
  toIsoRange,
  type CommissionLedger,
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

/**
 * 每页条数的可选档位（与出款单列表页同款）。
 */
const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;

/**
 * 平台抽佣明细页（Server Component）。
 *
 * ⚠️ **净抽佣一律用后端返回的 `netAmount`，前端不自己加总**：
 * 与报表页「前端绝不自己算净额」同款原则。净额由后端算好，
 * 前端再算一遍就成了第二套口径，账迟早对不上。
 *
 * ⚠️ **区间来自 URL**（`?from=YYYY-MM-DD&to=YYYY-MM-DD`）：
 * 这样抽佣明细的区间可以分享、可以后退，也就不用引入客户端 state。
 */
export default async function CommissionsPage({
  searchParams,
}: {
  // Next.js 15 起 searchParams 是 Promise，必须 await。
  searchParams: Promise<{
    from?: string;
    to?: string;
    page?: string;
    pageSize?: string;
  }>;
}) {
  const { from: fromDay, to: toDay, page: pageParam, pageSize: pageSizeParam } =
    await searchParams;

  // ⚠️ **页码与每页条数从 URL 读** —— 纯服务端翻页，不需要客户端组件
  // （与出款单列表页同款做法；缺省 20 与后端 `DEFAULT_PAGE_SIZE` 一致）。
  const parsedPage = Number.parseInt(pageParam ?? '1', 10);
  const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const parsedPageSize = Number.parseInt(pageSizeParam ?? '20', 10);
  // ⚠️ **夹到 1..100**（上限与后端 `clampPagination` 的 `MAX_PAGE_SIZE` 一致）。
  const pageSize = Math.min(
    100,
    Math.max(1, Number.isFinite(parsedPageSize) ? parsedPageSize : 20),
  );

  // ---- 定出要发给后端的区间 ----
  let query = '';
  let intervalError: string | null = null;
  // ⚠️ **两个都给了才转区间**：只给一个时报错，不调后端——
  // 区间不完整的明细比没有明细更糟。
  const range =
    fromDay && toDay ? toIsoRange(fromDay, toDay) : { error: 'INCOMPLETE' };

  if (fromDay && toDay) {
    if ('error' in range) {
      intervalError = range.error;
    }
  } else if (fromDay || toDay) {
    intervalError = '请同时选择开始与结束日期';
  }
  // ⚠️ **两个都没给就不传 from/to**：让后端用它的「最近 30 天」缺省值。
  // 那个缺省窗口是用**数据库的时钟**算的（护栏 M15：多副本部署时各机器
  // 的时钟有偏差），前端自己算「最近 30 天」用的是浏览器的时钟，
  // 两者对不上时界面显示的区间与后端统计的就不是同一个区间。

  // ⚠️ **分页参数无论有没有区间都要带上**（明细已改为后端分页）：
  // 漏掉的话不带区间的请求会永远只拿第一页。
  if (!intervalError) {
    const params = new URLSearchParams();
    if (fromDay && toDay && !('error' in range)) {
      params.set('from', range.from);
      params.set('to', range.to);
    }
    params.set('page', String(page));
    params.set('pageSize', String(pageSize));
    query = `?${params.toString()}`;
  }

  let ledger: CommissionLedger | null = null;
  let error: string | null = null;

  if (!intervalError) {
    try {
      // ⚠️ **path 里带 query 串是可以的**（apiFetch 直接把 path 拼到 base url 后面）。
      ledger = await apiFetchAuthed<CommissionLedger>(
        `/platform/commissions${query}`,
        // ⚠️ 报表响应带自有字段（from/to/byMerchant），用 looseObject
        //    只校验 entries + total，其余字段原样保留
        {
          validate: (data) =>
            paginatedEntriesResponse.parse(data) as unknown as CommissionLedger,
        },
      );
    } catch (cause) {
      if (cause instanceof ApiError) {
        error = `加载抽佣明细失败（${cause.status}）：${cause.message}`;
      } else {
        error = cause instanceof Error ? cause.message : '抽佣明细加载失败';
      }
    }
  }

  const merchants = ledger?.byMerchant ?? [];
  const entries = ledger?.entries ?? [];
  const total = ledger?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  /**
   * 拼一个带全部当前条件的 query（翻页 / 换每页条数用）。
   *
   * ⚠️ **翻页必须把区间一起带上** —— 漏掉的话翻一页区间就被重置成
   * 「最近 30 天」，看到的就不是同一份明细了。
   * ⚠️ **换每页条数时页码重置为 1** —— 新条数下原页码可能已越界。
   * ⚠️ **区间原样回传 URL 里的日期**（后端还会回显它实际统计的区间）。
   */
  const buildQuery = (nextPage: number, nextPageSize: number): string => {
    const params = new URLSearchParams();
    if (fromDay && toDay) {
      params.set('from', fromDay);
      params.set('to', toDay);
    }
    params.set('page', String(nextPage));
    params.set('pageSize', String(nextPageSize));
    return `?${params.toString()}`;
  };

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-bold">抽佣明细</h2>

      {intervalError && (
        <p className="text-sm text-destructive">{intervalError}</p>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* ⚠️ **纯 GET 表单**：提交就是一次普通的页面跳转，不需要任何客户端 JS。
          写成客户端组件反而要多一套状态同步，还容易与 URL 对不上。 */}
      <form method="get" action="/commissions" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="commission-from">开始日期</Label>
            <Input
              id="commission-from"
              type="date"
              name="from"
              // ⚠️ **没给就留空**：留空 = 最近 30 天（后端的缺省值）。
              defaultValue={fromDay ?? ''}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="commission-to">结束日期</Label>
            <Input
              id="commission-to"
              type="date"
              name="to"
              defaultValue={toDay ?? ''}
            />
          </div>
          <Button type="submit">查询</Button>
        </div>
        <p className="text-sm text-muted-foreground">
          不选日期 = 最近 30 天。区间按 UTC 自然日计算，结束日期当天包含在内。
        </p>
      </form>

      {ledger && (
        <>
          {/* ⚠️ **回显后端实际用的区间**，而不是 URL 里给的：
              后端可能用了「最近 30 天」的缺省值，界面要显示它真正统计的那段。 */}
          <p className="text-sm text-muted-foreground">
            统计区间：{formatDateTime(ledger.from)} ~ {formatDateTime(ledger.to)}
          </p>

          <Card>
            <CardHeader>
              <CardTitle>按商家汇总</CardTitle>
              <CardDescription>
                区间内各商家被抽走多少、抽了几笔、其中多少笔是退款冲回。
              </CardDescription>
            </CardHeader>
            <CardContent>
              {merchants.length === 0 ? (
                <p className="text-sm text-muted-foreground">暂无抽佣记录。</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>商家</TableHead>
                      <TableHead>子域名</TableHead>
                      <TableHead>净抽佣</TableHead>
                      <TableHead>笔数</TableHead>
                      <TableHead>其中冲回笔数</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {merchants.map((merchant) => (
                      <TableRow key={merchant.tenantId}>
                        <TableCell className="font-medium">
                          {merchant.tenantName}
                        </TableCell>
                        <TableCell>
                          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                            {merchant.subdomain}
                          </code>
                        </TableCell>
                        {/* ⚠️ **净额直接用后端返回的 `netAmount`**，
                            前端不自己把明细加总一遍。 */}
                        <TableCell>
                          {formatRevenueLabel(merchant.netAmount)}
                        </TableCell>
                        <TableCell>{merchant.entryCount}</TableCell>
                        <TableCell>{merchant.reversalCount}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>流水明细</CardTitle>
              <CardDescription>
                逐笔的抽佣与冲回：金额带符号（抽佣为正、冲回为负）。
              </CardDescription>
            </CardHeader>
            <CardContent>
              {entries.length === 0 ? (
                <p className="text-sm text-muted-foreground">暂无流水。</p>
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
                    {entries.map((entry) => (
                      <TableRow key={entry.id}>
                        <TableCell className="text-muted-foreground">
                          {formatDateTime(entry.occurredAt)}
                        </TableCell>
                        <TableCell>{entry.orderNo}</TableCell>
                        <TableCell>
                          {COMMISSION_ENTRY_TYPE_LABEL[entry.type] ?? entry.type}
                        </TableCell>
                        <TableCell>
                          {formatRevenueLabel(entry.amount)}
                        </TableCell>
                        <TableCell>
                          {formatCommissionRate(entry.rateBps)}
                        </TableCell>
                        <TableCell>
                          {formatRevenueLabel(entry.baseAmount)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              {/* ⚠️ **每页条数三档** —— 默认 20（与后端缺省一致） */}
              <div className="mt-4 flex gap-2 text-sm">
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <Link
                    key={size}
                    href={buildQuery(1, size)}
                    className={
                      size === pageSize
                        ? 'underline font-medium'
                        : 'underline-offset-4 hover:underline'
                    }
                  >
                    {size}
                  </Link>
                ))}
                <span className="text-muted-foreground">条 / 页</span>
              </div>
              {/* ⚠️ **翻页** —— 纯服务端：`<Link>` 改 URL，Server Component 重渲染。 */}
              {totalPages > 1 && (
                <div className="mt-2 flex items-center gap-4 text-sm">
                  <Link
                    href={buildQuery(Math.max(1, page - 1), pageSize)}
                    className={
                      page <= 1
                        ? 'pointer-events-none opacity-40'
                        : 'underline-offset-4 hover:underline'
                    }
                  >
                    上一页
                  </Link>
                  <span>
                    第 {page} / {totalPages} 页，共 {total} 笔
                  </span>
                  <Link
                    href={buildQuery(Math.min(totalPages, page + 1), pageSize)}
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
        </>
      )}
    </div>
  );
}
