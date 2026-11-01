'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * 对账差异的处置操作（阶段 5m）。
 *
 * ⚠️ **照 `platform-admin/src/app/(dashboard)/payouts/payout-actions.tsx` 的写法** ——
 *    `busyRef` 防重复点击、原生 `prompt()` 收集原因、`router.refresh()` 刷新。
 * ⚠️ **没有 dialog 组件**，本仓的原因收集默认用 `prompt()`。
 */

/** 统一的失败文案前缀 */
const FAILURE_TEXT = '操作失败';

/**
 * 读取中转路由的错误体。
 *
 * ⚠️ **先判断 `response.ok` 再决定要不要解析**：中转可能返回 204 无内容，
 * 对 204 调 `response.json()` 会抛「body 已消费」。
 */
async function readFailure(
  response: Response,
  fallback: string,
): Promise<string | null> {
  if (response.ok) return null;
  const payload = (await response.json().catch(() => ({}))) as {
    message?: string;
  };
  return payload.message ?? fallback;
}

/**
 * 一条对账差异的处置按钮。
 *
 * ⚠️ **只有「待处置」才有按钮**：已处置 / 已忽略的不能再改
 *    （改了就等于抹掉运营当时的判断，后台的留痕也对不上了）。
 */
export function ReconciliationActions({
  reconciliationId,
  itemId,
  payoutId,
  diffType,
  resolution,
}: {
  reconciliationId: string;
  itemId: string;
  payoutId: string | null;
  diffType: string;
  resolution: string;
}) {
  const router = useRouter();
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  if (resolution !== 'PENDING') {
    return null;
  }

  /**
   * 处置一条差异。
   *
   * @param note 处置说明（已由调用方收集好）
   * @param target 处置结果
   */
  async function resolve(
    target: 'RESOLVED' | 'IGNORED',
    note: string,
  ): Promise<boolean> {
    const response = await fetch(
      `/api/billing/reconciliations/${reconciliationId}/items/${itemId}/resolve`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resolution: target, note }),
      },
    );
    const problem = await readFailure(response, FAILURE_TEXT);
    if (problem) throw new Error(problem);
    return true;
  }

  /** 「标记已处置」 / 「忽略」—— 只处置差异本身 */
  async function runResolve(target: 'RESOLVED' | 'IGNORED') {
    // ⚠️ **闸门读的是 ref 不是 state**（与 `payout-actions.tsx` 同款）——
    //    连点两次会一起通过检查发出两次请求。
    if (busyRef.current) return;
    const answer = prompt(
      target === 'RESOLVED'
        ? '请填写处置说明（会记进对账留痕）'
        : '请填写忽略这条差异的原因',
    );
    const trimmed = (answer ?? '').trim();
    if (!trimmed) {
      setFailure('必须填写处置说明');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    try {
      await resolve(target, trimmed);
      // ⚠️ **成功后必须 router.refresh()**：详情页是服务端渲染的，
      //    不刷新就看不到新的处置状态。
      router.refresh();
    } catch (cause) {
      setFailure(
        `${FAILURE_TEXT}：${cause instanceof Error ? cause.message : '未知错误'}`,
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  /**
   * B 类（渠道已打款、本地记成失败）的人工确认。
   *
   * ⚠️ **先确认已付款、再把差异标成已处置** —— 两步都要做：
   *    后端的「确认已付款」只改出款单与写操作留痕，
   *    **不会**把对账差异项标成已处置（差异项与出款单是两套状态）。
   *
   * ⚠️ **原因只收集一次**：确认与处置共用同一段说明，
   *    两次 `prompt()` 会让运营填两遍，第二遍还可能填成不一样的内容。
   */
  async function confirmPaid() {
    if (busyRef.current) return;
    if (!payoutId) return;
    const answer = prompt(
      '请填写确认原因（会记进出款操作留痕）。' +
        '确认后系统会复原这笔出款的明细并把状态改成已付款。',
    );
    const trimmed = (answer ?? '').trim();
    if (!trimmed) {
      setFailure('必须填写确认原因');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const response = await fetch(`/api/billing/payouts/${payoutId}/confirm-paid`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          reason: trimmed,
          reconciliationId,
        }),
      });
      const problem = await readFailure(response, FAILURE_TEXT);
      if (problem) throw new Error(problem);

      // ⚠️ **确认成功后把差异项一并标为已处置** —— 否则这条差异
      //    仍是「待处置」，未处置统计不降，运营会反复看到它。
      await resolve('RESOLVED', trimmed);
      router.refresh();
    } catch (cause) {
      setFailure(
        `${FAILURE_TEXT}：${cause instanceof Error ? cause.message : '未知错误'}`,
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      {diffType === 'CHANNEL_SUCCESS_LOCAL_FAILED' && payoutId ? (
        <button
          type="button"
          disabled={busy}
          onClick={confirmPaid}
          className="text-sm underline disabled:opacity-50"
        >
          {busy ? '处理中…' : '确认已付款'}
        </button>
      ) : (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() => runResolve('RESOLVED')}
            className="mr-2 text-sm underline disabled:opacity-50"
          >
            {busy ? '处理中…' : '标记已处置'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => runResolve('IGNORED')}
            className="text-sm underline disabled:opacity-50"
          >
            忽略
          </button>
        </>
      )}
      {failure ? (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      ) : null}
    </div>
  );
}
