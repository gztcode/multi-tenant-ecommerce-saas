import Link from 'next/link';
import { apiFetchAuthed } from '@/lib/api-client';
import { formatDateTime } from '@/lib/billing';
import { Reconciliation, sortItemsBySeverity } from '@/lib/reconciliation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ReconciliationItemsTable } from '../reconciliation-items-table';

/**
 * 对账任务的差异详情（阶段 5m，阶段 6a 增加批量确认）。
 *
 * ⚠️ **差异列表按严重级排序** —— C/D/E/F 置顶（运营先看最危险的）。
 * ⚠️ **表格是本仓第一个带勾选的客户端组件** —— 批量确认要收集勾选、
 *    切 `prompt()`、循环调中转路由，服务端组件做不到。
 */
export default async function ReconciliationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const data = await apiFetchAuthed<Reconciliation>(
    `/platform/payout-reconciliations/${id}`,
  );

  const items = sortItemsBySeverity(data.items ?? []);

  /**
   * 服务端把差异项截断到 200 条时的提示。
   *
   * ⚠️ **必须显式告诉运营「还有更多」** —— 差异项最多能到上万条，
   *    服务端只回前 200 条。静默截断会让运营以为「就这些差异」，
   *    而被截掉的那批往往正是最该处置的。
   */
  const truncatedNotice = data.itemsTruncated
    ? `差异共 ${data.itemsTotal ?? items.length} 条，这里只显示前 ${items.length} 条。` +
      '其余差异请在列表页按批次逐个查看，或直接以统计里的「未处置严重差异数」为准。'
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
        <CardContent className="space-y-2">
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
          />
        </CardContent>
      </Card>
    </div>
  );
}
