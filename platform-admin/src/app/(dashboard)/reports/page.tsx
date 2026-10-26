import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import {
  formatDateTime,
  formatRevenueLabel,
  toIsoRange,
  type ReportSummary,
} from '@/lib/billing';
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
 * 平台收入报表页（Server Component）。
 *
 * ⚠️ **四个数一律用后端返回的值，前端不自己算净额**：
 * 与结算页「客户端算的钱一律不信」同款原则。净额由后端算好，
 * 前端再算一遍就成了第二套口径，账迟早对不上。
 *
 * ⚠️ **区间来自 URL**（`?from=YYYY-MM-DD&to=YYYY-MM-DD`）：
 * 这样报表的区间可以分享、可以后退，也就不用引入客户端 state。
 */
export default async function ReportsPage({
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
    // 区间不完整的报表比没有报表更糟。
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

  let report: ReportSummary | null = null;
  let error: string | null = null;

  if (!intervalError) {
    try {
      // ⚠️ **path 里带 query 串是可以的**（apiFetch 直接把 path 拼到 base url 后面）。
      report = await apiFetchAuthed<ReportSummary>(`/platform/reports${query}`);
    } catch (cause) {
      if (cause instanceof ApiError) {
        error = `加载报表失败（${cause.status}）：${cause.message}`;
      } else {
        error = cause instanceof Error ? cause.message : '报表加载失败';
      }
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-bold">报表</h2>

      {intervalError && (
        <p className="text-sm text-destructive">{intervalError}</p>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* ⚠️ **纯 GET 表单**：提交就是一次普通的页面跳转，不需要任何客户端 JS。
          写成客户端组件反而要多一套状态同步，还容易与 URL 对不上。 */}
      <form method="get" action="/reports" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="report-from">开始日期</Label>
            <Input
              id="report-from"
              type="date"
              name="from"
              // ⚠️ **没给就留空**：留空 = 最近 30 天（后端的缺省值）。
              defaultValue={fromDay ?? ''}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="report-to">结束日期</Label>
            <Input
              id="report-to"
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

      {report && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardHeader>
                <CardTitle>订阅收入</CardTitle>
                <CardDescription>
                  区间内已付账单的金额之和
                </CardDescription>
              </CardHeader>
              <CardContent>
                {/* ⚠️ **四个数都直接用后端返回的值**，前端不自己算。 */}
                <span className="text-xl font-semibold">
                  {formatRevenueLabel(report.subscriptionRevenue)}
                </span>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>抽佣收入</CardTitle>
                <CardDescription>区间内收过钱的订单的抽佣之和（毛额）</CardDescription>
              </CardHeader>
              <CardContent>
                <span className="text-xl font-semibold">
                  {formatRevenueLabel(report.commissionRevenue)}
                </span>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>退款冲回</CardTitle>
                <CardDescription>区间内已退款订单当初抽了多少</CardDescription>
              </CardHeader>
              <CardContent>
                <span className="text-xl font-semibold">
                  {formatRevenueLabel(report.reversal)}
                </span>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>净收入</CardTitle>
                <CardDescription>平台实际到手的钱</CardDescription>
              </CardHeader>
              <CardContent>
                <span className="text-xl font-semibold">
                  {formatRevenueLabel(report.netRevenue)}
                </span>
              </CardContent>
            </Card>
          </div>

          <p className="text-sm text-muted-foreground">
            净收入 = 订阅收入 + 抽佣收入 − 退款冲回。
          </p>

          {/* ⚠️ **回显后端实际用的区间**，而不是 URL 里给的：
              后端可能用了「最近 30 天」的缺省值，界面要显示它真正统计的那段。 */}
          <p className="text-sm text-muted-foreground">
            统计区间：{formatDateTime(report.from)} ~ {formatDateTime(report.to)}
          </p>
        </>
      )}
    </div>
  );
}
