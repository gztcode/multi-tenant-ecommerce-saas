import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import {
  COMMISSION_ENTRY_TYPE_LABEL,
  describeSettlementStatus,
  formatCommissionRate,
  formatDateTime,
  formatRevenueLabel,
  describeRecalculateHint,
  type SettlementDetail,
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

import { SettlementRowActions } from '../settlement-actions';

/**
 * 结算单明细分页的响应（阶段 5l）。
 *
 * ⚠️ **与 `SettlementDetail.entries` 分开** —— 详情接口的 `entries` 是
 *    无上限全量返回，本页改用分页端点取当前页。
 */
interface SettlementEntry {
  entryId: string;
  orderNo: string;
  type: 'COMMISSION' | 'REVERSAL';
  amount: number;
  rateBps: number;
  baseAmount: number;
  occurredAt: string;
}

interface SettlementEntriesPage {
  items: SettlementEntry[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * 每页条数的可选档位（阶段 5l）。
 *
 * ⚠️ **默认 50** —— 明细一行六列，20 条一屏太挤、100 条又太长。
 */
const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;

/**
 * 平台结算单详情页（Server Component）。
 *
 * ⚠️ **明细的金额直接展示后端给的值**：明细是流水 join 出来的，
 *    前端不自己加总（与列表页同款原则）。
 */
export default async function SettlementDetailPage({
  params,
  searchParams,
}: {
  // Next.js 15 起 params 是 Promise，必须 await。
  params: Promise<{ id: string }>;
  // Next.js 15 起 searchParams 也是 Promise，必须 await。
  searchParams: Promise<{ page?: string; pageSize?: string }>;
}) {
  const [{ id }, { page: pageParam, pageSize: pageSizeParam }] = await Promise.all(
    [params, searchParams],
  );

  // ⚠️ **页码与每页条数从 URL 读** —— 纯服务端翻页，不需要客户端组件。
  const parsedPage = Number.parseInt(pageParam ?? '1', 10);
  const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const parsedPageSize = Number.parseInt(pageSizeParam ?? '50', 10);
  // ⚠️ **夹到 1..100**（上限与后端 `clampPagination` 的 `MAX_PAGE_SIZE` 一致）。
  const pageSize = Math.min(
    100,
    Math.max(1, Number.isFinite(parsedPageSize) ? parsedPageSize : 50),
  );

  let statement: SettlementDetail | null = null;
  let entriesPage: SettlementEntriesPage | null = null;
  let error: string | null = null;
  // ⚠️ **明细的错与单头的错分开** —— 明细挂了就写进 `entriesError`，
  //    页面顶部仍显示单头正常加载，不必让两个错误互相覆盖。
  let entriesError: string | null = null;

  try {
    statement = await apiFetchAuthed<SettlementDetail>(
      `/platform/settlements/${id}`,
    );
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 404) {
      notFound();
    }
    error =
      cause instanceof ApiError
        ? `加载结算单失败（${cause.status}）：${cause.message}`
        : cause instanceof Error
          ? cause.message
          : '结算单加载失败';
  }

  // ⚠️ **明细单独取分页接口** —— 详情接口的 `entries` 是全量返回，
  //    一页几百上千行全渲染进 DOM，浏览器会卡住。
  //    明细取不到不阻断整页（单头信息比明细更要紧）。
  if (statement) {
    try {
      entriesPage = await apiFetchAuthed<SettlementEntriesPage>(
        `/platform/settlements/${id}/entries?page=${page}&pageSize=${pageSize}`,
      );
    } catch (cause) {
      entriesError =
        cause instanceof ApiError
          ? `加载结算明细失败（${cause.status}）：${cause.message}`
          : cause instanceof Error
            ? cause.message
            : '结算明细加载失败';
    }
  }

  if (!statement) {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="text-2xl font-bold">结算单详情</h2>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    );
  }

  const entries = entriesPage?.items ?? [];
  const entriesTotal = entriesPage?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(entriesTotal / pageSize));

  /**
   * 拼一个带当前页码 / 每页条数的 query。
   *
   * ⚠️ **翻页链接必须带上 `pageSize`** —— 漏掉的话翻一次页，
   *    每页条数就被重置回默认的 50 条，页码与条数对不上。
   */
  const buildQuery = (nextPage: number, nextPageSize: number): string => {
    const query = new URLSearchParams();
    query.set('page', String(nextPage));
    query.set('pageSize', String(nextPageSize));
    return `?${query.toString()}`;
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">结算单详情</h2>
        <Link
          href="/settlements"
          className="text-sm underline-offset-4 hover:underline"
        >
          返回列表
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {statement.tenantName} · {statement.periodLabel}
          </CardTitle>
          <CardDescription>
            单号 {statement.statementNo} ·{' '}
            {describeSettlementStatus(statement.status)}
            {statement.confirmedAt
              ? ` · 确认于 ${formatDateTime(statement.confirmedAt)}`
              : ''}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3">
            <div className="flex gap-6 text-sm">
              <span>毛额 {formatRevenueLabel(statement.grossAmount)}</span>
              <span>冲回 {formatRevenueLabel(statement.reversalAmount)}</span>
              <span className="font-medium">
                净额 {formatRevenueLabel(statement.netAmount)}
              </span>
              <span className="text-muted-foreground">
                {statement.entryCount} 笔
              </span>
            </div>
            <SettlementRowActions
              statementId={statement.id}
              status={statement.status}
            />
            {/* ⚠️ **缺笔要在这里说清楚，并给出能走的下一步**：
                只报一个坏消息，超管还是不知道该做什么。
                ⚠️ **指引按「实际能走哪条路」写**（`describeRecalculateHint`）：
                `DRAFT` 直接「重算」、`CONFIRMED` 先「取消确认」再「重算」、
                有出款单引用（`canRecalculate` 为假）只能走调账流程。
                只看 `canRecalculate` 会给草稿单指一条走不通的路。 */}
            {statement.missingEntryCount > 0 && (
              <div className="flex flex-col gap-1 text-sm">
                <p className="text-destructive">
                  本期结算单缺 {statement.missingEntryCount}{' '}
                  笔抽佣流水，佣金与当期真实流水对不上。
                </p>
                <p className="text-muted-foreground">
                  {describeRecalculateHint(
                    statement.status,
                    statement.canRecalculate,
                  )}
                </p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>结算明细</CardTitle>
          <CardDescription>
            这一期纳入的抽佣流水：金额带符号（抽佣为正、冲回为负）。
            {entriesTotal > 0 && ` 共 ${entriesTotal} 笔`}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* ⚠️ **明细挂了就明说**：静默显示「暂无明细」会让超管以为
              这张单真的没有流水 —— 那是**误导**（真没流水与取不到是两件事）。 */}
          {entriesError && (
            <p className="text-sm text-destructive">{entriesError}</p>
          )}
          {entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {entriesError ? '结算明细加载失败。' : '暂无明细。'}
            </p>
          ) : (
            <>
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
                    <TableRow key={entry.entryId}>
                      <TableCell className="text-muted-foreground">
                        {formatDateTime(entry.occurredAt)}
                      </TableCell>
                      <TableCell>{entry.orderNo}</TableCell>
                      <TableCell>
                        {COMMISSION_ENTRY_TYPE_LABEL[entry.type] ?? entry.type}
                      </TableCell>
                      <TableCell>{formatRevenueLabel(entry.amount)}</TableCell>
                      <TableCell>{formatCommissionRate(entry.rateBps)}</TableCell>
                      <TableCell>{formatRevenueLabel(entry.baseAmount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {/* ⚠️ **每页条数三档** —— 换档时页码重置为 1
                  （页码是按旧的每页条数算的，新的条数下第 3 页可能已越界）。 */}
              <div className="flex gap-2 text-sm">
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
                <div className="flex items-center gap-4 text-sm">
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
                    第 {page} / {totalPages} 页，共 {entriesTotal} 笔
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
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
