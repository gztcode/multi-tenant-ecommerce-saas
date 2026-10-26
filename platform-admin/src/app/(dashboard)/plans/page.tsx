import Link from 'next/link';
import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import {
  formatCommissionRate,
  formatFeatureFlags,
  formatPeriodDays,
  formatPriceLabel,
  formatQuota,
  describePlanStatus,
  type PlanList,
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
import { PlanDisableButton, PlanForm } from './plan-form';

/**
 * 套餐列表页（Server Component）。
 *
 * ⚠️ **状态用 URL 表达，不用客户端 state**：
 * `?new=1` 渲染新建表单、`?edit=<planId>` 渲染编辑表单。
 * 这样「新建」与「编辑」都是可分享、可后退的地址，
 * 也就不用为了切换表单而引入客户端 state。
 *
 * ⚠️ **展示一律用 `lib/billing.ts` 的纯函数**（金额、费率、额度、周期、
 * 状态文案各一处出处）。在页面里另写一套换算，页面与商家后台就会漂移。
 */
export default async function PlansPage({
  searchParams,
}: {
  // Next.js 15 起 searchParams 是 Promise，必须 await，否则拿到的是 Promise 对象。
  searchParams: Promise<{ new?: string; edit?: string }>;
}) {
  const { new: wantsNew, edit: editId } = await searchParams;

  // ⚠️ **取数失败不要整页崩掉**：渲染一句错误提示即可。
  // 后端没起 / 令牌角色不对（403）/ 网络抖动都归到这里。
  let plans: PlanList | null = null;
  let error: string | null = null;

  try {
    plans = await apiFetchAuthed<PlanList>('/platform/plans');
  } catch (cause) {
    if (cause instanceof ApiError) {
      error = `加载套餐列表失败（${cause.status}）：${cause.message}`;
    } else {
      error = cause instanceof Error ? cause.message : '套餐列表加载失败';
    }
  }

  const items = plans?.items ?? [];
  // ⚠️ **编辑的套餐从列表里找**：后端没有 `GET /platform/plans/:id`，
  // 而列表接口本来就调了，不必再发一次请求。
  // 找不到（列表被截断或 id 不存在）就当没有编辑目标 —— 至少页面还能用。
  const editingPlan = editId ? items.find((item) => item.id === editId) : undefined;
  const showForm = Boolean(wantsNew) || Boolean(editId);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">套餐</h2>
        <Link
          href="/plans?new=1"
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
        >
          新建套餐
        </Link>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {showForm && (
        <div className="flex flex-col gap-2">
          <PlanForm plan={editingPlan} />
          <div>
            <Link
              href="/plans"
              className="text-sm text-muted-foreground underline underline-offset-4"
            >
              取消
            </Link>
          </div>
          {editId && !editingPlan && (
            <p className="text-sm text-destructive">
              找不到要编辑的套餐（可能已下架或已被移除），下面显示的是新建表单。
            </p>
          )}
        </div>
      )}

      {plans && (
        <Card>
          <CardHeader>
            <CardTitle>全部套餐（{plans.total}）</CardTitle>
            <CardDescription>
              套餐是平台的数据，不属于任何租户。下架不可逆。
            </CardDescription>
          </CardHeader>
          <CardContent>
            {items.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无套餐。</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>名称</TableHead>
                    <TableHead>周期价格</TableHead>
                    <TableHead>订阅周期</TableHead>
                    <TableHead>试用期</TableHead>
                    <TableHead>抽佣费率</TableHead>
                    <TableHead>额度</TableHead>
                    <TableHead>功能开关</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((plan) => (
                    <TableRow key={plan.id}>
                      <TableCell className="font-medium">
                        <div className="flex flex-col">
                          <span>{plan.name}</span>
                          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                            {plan.code}
                          </code>
                        </div>
                      </TableCell>
                      <TableCell>{formatPriceLabel(plan.price)}</TableCell>
                      <TableCell>{formatPeriodDays(plan.periodDays)}</TableCell>
                      <TableCell>
                        {plan.trialDays > 0
                          ? `${plan.trialDays} 天`
                          : '—'}
                      </TableCell>
                      <TableCell>
                        {formatCommissionRate(plan.commissionBps)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {/* ⚠️ **三个额度都要显示**：超管要一眼看出套餐卡在哪一项上。
                            null（不限）由 formatQuota 显示成「不限」。 */}
                        商品 {formatQuota(plan.maxProducts)} · SKU{' '}
                        {formatQuota(plan.maxSkus)} · 店铺{' '}
                        {formatQuota(plan.maxStores)}
                      </TableCell>
                      <TableCell>
                        {formatFeatureFlags(plan.features ?? {})}
                      </TableCell>
                      <TableCell>{describePlanStatus(plan.status)}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <Link
                            href={`/plans?edit=${plan.id}`}
                            className="text-sm underline underline-offset-4"
                          >
                            编辑
                          </Link>
                          <PlanDisableButton
                            planId={plan.id}
                            planName={plan.name}
                          />
                        </div>
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
