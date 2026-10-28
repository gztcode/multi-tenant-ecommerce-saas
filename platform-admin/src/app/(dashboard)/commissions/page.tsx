import { ApiError, apiFetchAuthed } from '@/lib/api-client';
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
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const { from: fromDay, to: toDay } = await searchParams;

  // ---- 定出要发给后端的区间 ----
  let query = '';
  let intervalError: string | null = null;

  if (fromDay && toDay) {
    // ⚠️ **两个都给了才转区间**：只给一个时报错，不调后端——
    // 区间不完整的明细比没有明细更糟。
    const range = toIsoRange(fromDay, toDay);
    if ('error' in range) {
      intervalError = range.error;
    } else {
      const params = new URLSearchParams();
      params.set('from', range.from);
      params.set('to', range.to);
      query = `?${params.toString()}`;
    }
  } else if (fromDay || toDay) {
    intervalError = '请同时选择开始与结束日期';
  }
  // ⚠️ **两个都没给就不传 from/to**：让后端用它的「最近 30 天」缺省值。
  // 那个缺省窗口是用**数据库的时钟**算的（护栏 M15：多副本部署时各机器
  // 的时钟有偏差），前端自己算「最近 30 天」用的是浏览器的时钟，
  // 两者对不上时界面显示的区间与后端统计的就不是同一个区间。

  let ledger: CommissionLedger | null = null;
  let error: string | null = null;

  if (!intervalError) {
    try {
      // ⚠️ **path 里带 query 串是可以的**（apiFetch 直接把 path 拼到 base url 后面）。
      ledger = await apiFetchAuthed<CommissionLedger>(
        `/platform/commissions${query}`,
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
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
