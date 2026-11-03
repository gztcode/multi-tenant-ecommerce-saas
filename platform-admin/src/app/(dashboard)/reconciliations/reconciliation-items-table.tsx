'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { formatCents } from '@/lib/payout';
import { formatDateTime } from '@/lib/billing';
import {
  RECONCILIATION_DIFF_LABEL,
  RECONCILIATION_RESOLUTION_LABEL,
  RECONCILIATION_SEVERITY_LABEL,
  ReconciliationItem,
  ReconciliationSource,
} from '@/lib/reconciliation';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ReconciliationActions } from './reconciliation-actions';

/**
 * 对账差异表（阶段 6a Task 7：客户端化，支持勾选与批量确认）。
 *
 * ⚠️ **哪些行可勾选由服务端给的口径决定，前端只做镜像**：
 *    只有 `source === 'FILE' && type === 'CHANNEL_PENDING_LOCAL'
 *    && resolution === 'PENDING' && payoutId` 的行能勾。
 *    B 类（本地记成失败）必须逐单走四道闸，批量确认只做 A 类。
 *
 * ⚠️ **「确认全部」走游标分批，不一次请求吃下整张表** ——
 *    每条 A 类纠正都是独立事务，几千条会超过 HTTP 超时并把连接占死；
 *    而且中途可以停止（已确认的保留，剩下的仍是待处置）。
 */

/** 单批条数（与后端 DTO / 中转路由的上限一致） */
const BATCH_SIZE = 200;

/** 统一的失败文案前缀 */
const FAILURE_TEXT = '批量确认失败';

interface BatchResult {
  succeeded: string[];
  failed: Array<{ id: string; message: string }>;
  nextCursor: string | null;
}

/** 调同源中转路由 */
async function callBatch(
  reconciliationId: string,
  body: Record<string, unknown>,
): Promise<BatchResult> {
  const response = await fetch(
    `/api/billing/reconciliations/${reconciliationId}/items/batch-confirm`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      message?: string;
    };
    throw new Error(payload.message ?? FAILURE_TEXT);
  }
  return (await response.json()) as BatchResult;
}

/** 一行是否可批量确认 */
function isActionable(item: ReconciliationItem, source: ReconciliationSource): boolean {
  return (
    source === 'FILE' &&
    item.type === 'CHANNEL_PENDING_LOCAL' &&
    item.resolution === 'PENDING' &&
    !!item.payoutId
  );
}

export function ReconciliationItemsTable({
  reconciliationId,
  source,
  items,
  actionableCount,
}: {
  reconciliationId: string;
  source: ReconciliationSource;
  items: ReconciliationItem[];
  actionableCount: number;
}) {
  const router = useRouter();
  const busyRef = useRef(false);
  const stopRef = useRef(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const actionableIds = useMemo(
    () => items.filter((item) => isActionable(item, source)).map((item) => item.id),
    [items, source],
  );
  const allSelectedOnPage =
    actionableIds.length > 0 && actionableIds.every((id) => selected.has(id));

  /** 切换一行 */
  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** 表头「全选当前页」（只选可确认的行，不可确认的行永远不被选中） */
  function toggleAll() {
    setSelected(allSelectedOnPage ? new Set() : new Set(actionableIds));
  }

  /** 收集统一说明；取消返回 null */
  function askNote(): string | null {
    const answer = prompt(
      '请填写统一确认说明（会记进每条出款的操作留痕）',
    );
    const note = (answer ?? '').trim();
    if (!note) {
      setFailure('必须填写确认说明');
      return null;
    }
    if (note.length > 200) {
      setFailure('确认说明不能超过 200 字');
      return null;
    }
    return note;
  }

  /** 勾选确认：`mode = IDS`，一次最多 200 条 */
  async function confirmSelected() {
    if (busyRef.current || selected.size === 0) return;
    const ids = [...selected];
    if (ids.length > BATCH_SIZE) {
      setFailure(`一次最多确认 ${BATCH_SIZE} 条，请分批勾选`);
      return;
    }
    const note = askNote();
    if (!note) return;

    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    setProgress('正在确认选中项…');
    try {
      const result = await callBatch(reconciliationId, {
        mode: 'IDS',
        itemIds: ids,
        note,
      });
      setSelected(new Set());
      setProgress(
        `已确认 ${result.succeeded.length} 条，失败 ${result.failed.length} 条。`,
      );
      if (result.failed.length > 0) {
        setFailure(
          `有 ${result.failed.length} 条未确认成功：${result.failed
            .slice(0, 3)
            .map((f) => f.message)
            .join('；')}${result.failed.length > 3 ? '…' : ''}`,
        );
      }
      router.refresh();
    } catch (cause) {
      setFailure(
        `${FAILURE_TEXT}：${cause instanceof Error ? cause.message : '未知错误'}`,
      );
      setProgress(null);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  /** 全选确认：`mode = FILTER` 循环调用，直到 `nextCursor === null` */
  async function confirmAll() {
    if (busyRef.current || actionableCount === 0) return;
    const note = askNote();
    if (!note) return;

    busyRef.current = true;
    stopRef.current = false;
    setBusy(true);
    setStopping(false);
    setFailure(null);
    let confirmed = 0;
    let failed = 0;
    let cursor: string | null = null;
    try {
      do {
        setProgress(`正在确认… 已确认 ${confirmed} 条，失败 ${failed} 条`);
        const result = await callBatch(reconciliationId, {
          mode: 'FILTER',
          ...(cursor ? { cursor } : {}),
          limit: BATCH_SIZE,
          note,
        });
        confirmed += result.succeeded.length;
        failed += result.failed.length;
        // ⚠️ **游标前进到本批最后一条（失败项也跳过）** —— 后端已经这样返回，
        //    前端不再自己算，避免「失败项卡住 → 无限重试」。
        cursor = result.nextCursor;
      } while (cursor !== null && !stopRef.current);

      setProgress(
        stopRef.current
          ? `已停止：共确认 ${confirmed} 条，失败 ${failed} 条；未确认的仍是「待处置」。`
          : `已完成：共确认 ${confirmed} 条，失败 ${failed} 条。`,
      );
      if (failed > 0) {
        setFailure(`有 ${failed} 条未确认成功，请刷新后逐条查看。`);
      }
      setSelected(new Set());
      router.refresh();
    } catch (cause) {
      setFailure(
        `${FAILURE_TEXT}：${cause instanceof Error ? cause.message : '未知错误'}` +
          `（已确认 ${confirmed} 条，失败 ${failed} 条）`,
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
      setStopping(false);
    }
  }

  const canBatch = source === 'FILE' && actionableCount > 0;

  return (
    <div className="space-y-2">
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">没有差异。</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                {actionableIds.length > 0 ? (
                  <input
                    type="checkbox"
                    aria-label="全选当前页可确认的差异"
                    checked={allSelectedOnPage}
                    disabled={busy}
                    onChange={toggleAll}
                  />
                ) : null}
              </TableHead>
              <TableHead>严重级</TableHead>
              <TableHead>差异</TableHead>
              <TableHead>渠道</TableHead>
              <TableHead>本地</TableHead>
              <TableHead>出款单</TableHead>
              <TableHead>处置</TableHead>
              <TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => {
              const selectable = isActionable(item, source);
              return (
                <TableRow key={item.id}>
                  <TableCell>
                    {selectable ? (
                      <input
                        type="checkbox"
                        aria-label="选择这条差异"
                        checked={selected.has(item.id)}
                        disabled={busy}
                        onChange={() => toggle(item.id)}
                      />
                    ) : null}
                  </TableCell>
                  <TableCell>
                    {RECONCILIATION_SEVERITY_LABEL[item.severity] ??
                      item.severity}
                  </TableCell>
                  <TableCell>
                    {RECONCILIATION_DIFF_LABEL[item.type] ?? item.type}
                  </TableCell>
                  <TableCell className="text-xs">
                    {item.channelStatus ?? '—'} /{' '}
                    {item.channelAmount !== null
                      ? formatCents(item.channelAmount)
                      : '—'}
                    {item.channelPaidAt
                      ? ` / ${formatDateTime(item.channelPaidAt)}`
                      : ''}
                  </TableCell>
                  <TableCell className="text-xs">
                    {item.localStatus ?? '—'} /{' '}
                    {item.localAmount !== null
                      ? formatCents(item.localAmount)
                      : '—'}
                  </TableCell>
                  <TableCell className="text-xs">
                    {item.payoutId ? (
                      <Link
                        href={`/payouts/${item.payoutId}`}
                        className="underline-offset-4 hover:underline"
                      >
                        {item.payoutId.slice(0, 8)}
                      </Link>
                    ) : (
                      item.channelReferenceNo ?? '—'
                    )}
                  </TableCell>
                  <TableCell>
                    {RECONCILIATION_RESOLUTION_LABEL[item.resolution] ??
                      item.resolution}
                    {item.note ? (
                      <span className="block text-xs text-muted-foreground">
                        {item.note}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <ReconciliationActions
                      reconciliationId={reconciliationId}
                      itemId={item.id}
                      payoutId={item.payoutId}
                      diffType={item.type}
                      resolution={item.resolution}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {canBatch ? (
        <div className="space-y-1 border-t pt-2">
          <p className="text-xs text-muted-foreground">
            批量确认只纠正「渠道已打款、本地处理中」的差异；本地失败的 B
            类仍需逐单走人工确认。
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="text-sm underline disabled:opacity-50"
              disabled={busy || selected.size === 0}
              onClick={confirmSelected}
            >
              确认选中（{selected.size} 条）
            </button>
            <button
              type="button"
              className="text-sm underline disabled:opacity-50"
              disabled={busy || actionableCount === 0}
              onClick={confirmAll}
            >
              确认全部可批量确认（{actionableCount} 条）
            </button>
            {busy && !stopping ? (
              <button
                type="button"
                className="text-sm text-destructive underline"
                onClick={() => {
                  // ⚠️ **停止只影响「还要不要发下一批」** ——
                  //    当前这一批已经在路上，不能半路丢弃它的结果。
                  stopRef.current = true;
                  setStopping(true);
                }}
              >
                停止
              </button>
            ) : null}
            {stopping ? (
              <span className="text-xs text-muted-foreground">
                将在当前批次完成后停止…
              </span>
            ) : null}
          </div>
          {progress ? (
            <p className="text-sm text-muted-foreground">{progress}</p>
          ) : null}
          {failure ? (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
