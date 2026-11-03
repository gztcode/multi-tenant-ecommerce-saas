'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

/**
 * 「立即对账」按钮（阶段 5m）。
 *
 * ⚠️ **为什么要有它** —— 定时对账每天只跑一次（UTC 自然日），
 *    运营临时发现「这批单好像有问题」时干等一天是不可接受的。
 *    后端一直有手动触发的端点，界面上没有入口 → 只能干等。
 *
 * ⚠️ **用 `prompt()` 收集参数** —— 本仓没有 dialog 组件，
 *    原因与时间窗这类参数用 `prompt()` 收集是既有约定
 *    （见 `payout-actions.tsx` 的说明）。
 *
 * ⚠️ **对账是异步入队的**（阶段 6 审查修复）—— 接口立刻返回，
 *    真正的对账在 worker 里跑（原先同步执行会被网关 60 秒超时砍掉，
 *    而后台还在跑 → 运营以为失败、连点几次）。
 *    → 按钮的文案是「已提交」而不是「对账中」；
 *    **必须提示去哪看结果**，否则运营会以为没生效。
 */
export function TriggerReconciliation() {
  const router = useRouter();
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  async function trigger() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    setNotice(null);

    try {
      // ⚠️ **默认值给全** —— 运营最常见的是「就查昨天」，
      //    直接回车就能用，不用自己想格式。
      const channel =
        window.prompt('渠道名', 'fake-payout')?.trim() ?? '';
      if (!channel) {
        return;
      }
      const today = new Date();
      const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
      const to = window.prompt(
        '时间窗的终点（不含，格式 YYYY-MM-DD）',
        today.toISOString().slice(0, 10),
      );
      if (!to) {
        return;
      }
      const from = window.prompt(
        '时间窗的起点（含，格式 YYYY-MM-DD）',
        yesterday.toISOString().slice(0, 10),
      );
      if (!from) {
        return;
      }

      const response = await fetch('/api/billing/reconciliations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, from, to }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          message?: string;
        };
        setFailure(payload.message ?? '触发对账失败');
        return;
      }
      // ⚠️ **必须说清「已提交，结果在列表里看」** —— 异步入队后
      //    接口立刻就返回了，运营看不到任何「在跑」的迹象。
      setNotice('已提交对账任务，稍后刷新列表查看结果。');
      router.refresh();
    } catch {
      setFailure('触发对账失败');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button type="button" onClick={trigger} disabled={busy}>
        {busy ? '提交中…' : '立即对账'}
      </Button>
      {notice ? (
        <p className="text-sm text-muted-foreground">{notice}</p>
      ) : null}
      {failure ? (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      ) : null}
    </div>
  );
}
