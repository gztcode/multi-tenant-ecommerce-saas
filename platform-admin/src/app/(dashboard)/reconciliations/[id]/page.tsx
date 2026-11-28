import Link from 'next/link';
import { apiFetchAuthed } from '@/lib/api-client';
import { formatDateTime } from '@/lib/billing';
import {
  RECONCILIATION_DIFF_LABEL,
  RECONCILIATION_DIFF_TYPE_VALUES,
  RECONCILIATION_RESOLUTION_LABEL,
  RECONCILIATION_RESOLUTION_VALUES,
  RECONCILIATION_SEVERITY_LABEL,
  RECONCILIATION_SEVERITY_VALUES,
  Reconciliation,
  ReconciliationDiffType,
  ReconciliationResolution,
  ReconciliationSeverity,
  sortItemsBySeverity,
} from '@/lib/reconciliation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ReconciliationItemsTable } from '../reconciliation-items-table';
import { encodePathSegment } from '@ecom/frontend-shared/url';

/** 详情页的筛选参数（全部来自 URL，服务端读） */
interface ReconciliationDetailSearchParams {
  severity?: string;
  resolution?: string;
  type?: string;
}

/** 原生 `<select>` 的统一外观（与 `settings/payout-channel-form.tsx` 一致） */
const SELECT_CLASS =
  'h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

/**
 * 从 URL 取一个筛选值。
 *
 * ⚠️ **空串当作「没传」** —— 筛选表单是原生 GET 表单，没选的
 *    `<select>` 也会被提交（`?severity=&resolution=`），把空串当非法值
 *    会让「什么都不选、直接点筛选」报错。
 * ⚠️ **非法值不静默改成默认值**：返回 `invalid`，页面如实提示「已忽略」——
 *    悄悄按「全部」查再展示，运营会以为自己看的是某个筛选结果。
 */
function readFilter<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
): { value?: T; invalid: boolean } {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return { invalid: false };
  }
  return allowed.includes(trimmed as T)
    ? { value: trimmed as T, invalid: false }
    : { invalid: true };
}

/**
 * 对账任务的差异详情（阶段 5m，阶段 6a 增加批量确认）。
 *
 * ⚠️ **差异列表按严重级排序** —— C/D/E/F 置顶（运营先看最危险的）。
 * ⚠️ **表格是本仓第一个带勾选的客户端组件** —— 批量确认要收集勾选、
 *    切 `prompt()`、循环调中转路由，服务端组件做不到。
 * ⚠️ **筛选状态放在 URL 里**（`searchParams`）—— 服务端组件读、原生 GET 表单提交，
 *    刷新/分享链接都能复现同一视角，不用客户端状态。
 */
export default async function ReconciliationDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<ReconciliationDetailSearchParams>;
}) {
  const { id } = await params;
  const sp = await searchParams;

  const severity = readFilter<ReconciliationSeverity>(
    sp.severity,
    RECONCILIATION_SEVERITY_VALUES,
  );
  const resolution = readFilter<ReconciliationResolution>(
    sp.resolution,
    RECONCILIATION_RESOLUTION_VALUES,
  );
  const diffType = readFilter<ReconciliationDiffType>(
    sp.type,
    RECONCILIATION_DIFF_TYPE_VALUES,
  );

  const invalidKeys = [
    severity.invalid ? '严重级' : null,
    resolution.invalid ? '处置状态' : null,
    diffType.invalid ? '差异类型' : null,
  ].filter((label): label is string => label !== null);

  // ⚠️ **只把合法且有值的条件拼进 URL** —— 后端对未知/非法参数是 400
  const query = new URLSearchParams();
  if (severity.value) {
    query.set('severity', severity.value);
  }
  if (resolution.value) {
    query.set('resolution', resolution.value);
  }
  if (diffType.value) {
    query.set('type', diffType.value);
  }
  const queryString = query.toString();
  const hasFilter = queryString !== '';

  const data = await apiFetchAuthed<Reconciliation>(
    `/platform/payout-reconciliations/${encodePathSegment(id)}${queryString ? `?${queryString}` : ''}`,
  );

  const items = sortItemsBySeverity(data.items ?? []);

  /**
   * 服务端把差异项截断到 200 条时的提示。
   *
   * ⚠️ **必须显式告诉运营「还有更多」** —— 差异项最多能到上万条，
   *    服务端只回前 200 条。静默截断会让运营以为「就这些差异」，
   *    而被截掉的那批往往正是最该处置的。
   * ⚠️ **筛选后仍可能被截断** —— 原来的文案让人「去列表页按批次看」，
   *    但列表页根本没有差异项视图（只有任务级分页），那条路是死的。
   *    现在如实说明「当前筛选下共 N 条、只显示前 200 条」，并指向筛选控件。
   */
  const truncatedNotice = data.itemsTruncated
    ? `差异共 ${data.itemsTotal ?? items.length} 条${
        hasFilter ? '（当前筛选条件下）' : ''
      }，当前按筛选显示前 ${items.length} 条。` +
      '请用上方的筛选缩小范围（例如「严重」+「待处置」），' +
      '或直接以统计里的「未处置严重差异数」为准。'
    : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">对账详情</h1>
        <Link href="/reconciliations" className="text-sm underline">
          返回列表
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>基本信息</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p>渠道：{data.channel}</p>
          <p>
            时间窗：{formatDateTime(data.windowFrom)} ~{' '}
            {formatDateTime(data.windowTo)}
          </p>
          <p>
            本地单 {data.localCount} 张 / 渠道流水 {data.channelCount} 条 / 一致{' '}
            {data.matchedCount} 张 / 差异 {data.diffCount} 条
          </p>
          {data.errorMessage ? (
            <p role="alert" className="text-sm text-destructive">
              {data.errorMessage}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>差异明细</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/*
            ⚠️ **原生 GET 表单** —— 提交后 URL 变成 `?severity=...`，
            服务端组件按 URL 重新取数；不用 `useState`，刷新也保持视角。
          */}
          <form
            method="get"
            action={`/reconciliations/${id}`}
            className="flex flex-wrap items-end gap-3"
          >
            <label className="space-y-1 text-sm">
              <span className="block text-muted-foreground">严重级</span>
              <select
                name="severity"
                defaultValue={severity.value ?? ''}
                className={SELECT_CLASS}
              >
                <option value="">全部</option>
                {RECONCILIATION_SEVERITY_VALUES.map((value) => (
                  <option key={value} value={value}>
                    {RECONCILIATION_SEVERITY_LABEL[value]}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="block text-muted-foreground">处置状态</span>
              <select
                name="resolution"
                defaultValue={resolution.value ?? ''}
                className={SELECT_CLASS}
              >
                <option value="">全部</option>
                {RECONCILIATION_RESOLUTION_VALUES.map((value) => (
                  <option key={value} value={value}>
                    {RECONCILIATION_RESOLUTION_LABEL[value]}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="block text-muted-foreground">差异类型</span>
              <select
                name="type"
                defaultValue={diffType.value ?? ''}
                className={SELECT_CLASS}
              >
                <option value="">全部</option>
                {RECONCILIATION_DIFF_TYPE_VALUES.map((value) => (
                  <option key={value} value={value}>
                    {RECONCILIATION_DIFF_LABEL[value]}
                  </option>
                ))}
              </select>
            </label>
            <Button type="submit">筛选</Button>
            {hasFilter ? (
              <Link
                href={`/reconciliations/${id}`}
                className="text-sm underline"
              >
                清除筛选
              </Link>
            ) : null}
          </form>

          {invalidKeys.length > 0 ? (
            <p role="alert" className="text-sm text-destructive">
              筛选条件非法（{invalidKeys.join('、')}），已忽略该条件。
            </p>
          ) : null}

          {truncatedNotice ? (
            <p role="alert" className="text-sm text-destructive">
              {truncatedNotice}
            </p>
          ) : null}
          <ReconciliationItemsTable
            reconciliationId={data.id}
            source={data.source}
            items={items}
            actionableCount={data.actionableCount ?? 0}
            emptyText={
              hasFilter ? '当前筛选条件下没有差异。' : '没有差异。'
            }
          />
        </CardContent>
      </Card>
    </div>
  );
}
