import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import {
  describeSubscriptionStatus,
  formatCommissionRate,
  formatDateTime,
  type SubscriptionList,
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

/**
 * 订阅列表页（Server Component）。
 *
 * ⚠️ **平台侧只有「看」**：换套餐要商家自己在商家后台操作
 * （护栏 M3：平台能替商家换套餐就能绕过计费规则）。
 * 所以这一页没有写操作。
 */
export default async function SubscriptionsPage() {
  // ⚠️ **取数失败不要整页崩掉**：渲染一句错误提示即可。
  let data: SubscriptionList | null = null;
  let error: string | null = null;

  try {
    data = await apiFetchAuthed<SubscriptionList>('/platform/subscriptions');
  } catch (cause) {
    if (cause instanceof ApiError) {
      error = `加载订阅列表失败（${cause.status}）：${cause.message}`;
    } else {
      error = cause instanceof Error ? cause.message : '订阅列表加载失败';
    }
  }

  const items = data?.items ?? [];
  // ⚠️ **后端的订阅列表按 200 条截断，`total` 是真实总数**：
  // 不提示的话，超管看到「200 条」会以为平台只有 200 个订阅。
  const truncated = data !== null && data.total > data.items.length;

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-bold">订阅</h2>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {data && (
        <Card>
          <CardHeader>
            <CardTitle>全部订阅（{data.total}）</CardTitle>
            <CardDescription>
              跨租户的订阅视图：谁订了哪个套餐、费率多少、什么时候到期。
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {truncated && (
              <p className="text-sm text-muted-foreground">
                仅显示最近 {data.items.length} 条，共 {data.total} 条。
              </p>
            )}
            {items.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无订阅。</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>商家</TableHead>
                    <TableHead>套餐</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>抽佣费率</TableHead>
                    <TableHead>当前周期</TableHead>
                    <TableHead>到期后不续费</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((subscription) => (
                    <TableRow key={subscription.id}>
                      <TableCell className="font-medium">
                        <div className="flex flex-col">
                          <span>{subscription.tenantName}</span>
                          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                            {subscription.tenantSubdomain}
                          </code>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <span>{subscription.planName}</span>
                          {/* ⚠️ **有预约换套餐时要说清楚**：超管要知道
                              下个周期会换成什么，否则这张表读不出
                              「这家即将涨价」这种事。 */}
                          {subscription.pendingPlanName && (
                            <span className="text-xs text-muted-foreground">
                              下个周期：{subscription.pendingPlanName}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {describeSubscriptionStatus(subscription.status)}
                      </TableCell>
                      <TableCell>
                        {formatCommissionRate(subscription.commissionBps)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDateTime(subscription.currentPeriodStart)} ~{' '}
                        {formatDateTime(subscription.currentPeriodEnd)}
                      </TableCell>
                      <TableCell>
                        {subscription.cancelAtPeriodEnd ? '是' : '否'}
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
