'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { PayoutStatus } from '@/lib/payout';
import { describePayoutStatus } from '@/lib/payout';

/**
 * 出款单的审批操作（通过 / 拒绝）。
 *
 * ⚠️ **所有写操作都走同源的 `/api/**` 中转**（不是直连后端）：
 * 后端没开 CORS，而且 accessToken 不该进客户端代码。
 *
 * ⚠️ **闸门读的是 ref 不是 state**：state 同一 tick 内还是旧值，
 * 连点两次会一起通过检查发出两次请求（重复审批）。ref 是同步写的。
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
 * 出款单的审批操作。
 *
 * ⚠️ **只有「待审批」才显示按钮**：已审批的不能再批、已拒绝的不能改主意
 * （商家要重新申请）。已出款 / 出款失败在 5h-1 不可达。
 *
 * ⚠️ **拒绝必须填原因**：没有原因的拒绝对商家毫无意义 ——
 * 商家不知道该改什么，只能打电话问客服。
 */
export function PayoutActions({
  payoutId,
  status,
  requestedAmount,
}: {
  payoutId: string;
  status: PayoutStatus;
  /** 申请时的预估金额（审批时会重算 → 两者可能不同） */
  requestedAmount: number;
}) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);

  async function run(action: 'approve' | 'reject') {
    // ⚠️ **闸门读的是 ref 不是 state**：state 同一 tick 内还是旧值，
    // 连点两次会一起通过检查发出两次请求。
    if (busyRef.current) return;

    if (action === 'reject') {
      const trimmed = reason.trim();
      if (!trimmed) {
        setFailure('拒绝出款必须填写原因');
        return;
      }
      if (
        !confirm(
          `确定拒绝这张出款单？\n拒绝原因：${trimmed}\n` +
            '商家可以重新申请同一周期。',
        )
      ) {
        return;
      }
    } else {
      if (
        !confirm(
          '确定通过这张出款单？\n' +
            `通过时平台会**重算一次金额并锁定**（申请时预估 ` +
            `¥${(requestedAmount / 100).toFixed(2)}，重算结果可能不同），` +
            '之后不再随流水变化。',
        )
      ) {
        return;
      }
    }

    busyRef.current = true;
    setBusy(true);
    setFailure(null);

    try {
      const response = await fetch(`/api/billing/payouts/${payoutId}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body:
          action === 'reject'
            ? JSON.stringify({ reason: reason.trim() })
            : undefined,
      });
      const problem = await readFailure(response, FAILURE_TEXT);
      if (problem) throw new Error(problem);

      // ⚠️ **成功后必须 router.refresh()**：详情与列表是服务端渲染的，
      // 不刷新就看不到新状态。
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

  // ⚠️ **非「待审批」一律不给按钮**：已审批的不能再批、已拒绝的不能改主意。
  //    但**不能整块渲染成 `null`** —— 那详情页上就是一片空白，
  //    超管会以为页面没加载出来，而不是「这单已经批过了」。
  if (status !== 'REQUESTED') {
    return (
      <p className="text-sm text-muted-foreground">
        该出款单当前是「{describePayoutStatus(status)}」，没有可执行的审批操作。
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <Label htmlFor={`payout-reason-${payoutId}`}>拒绝原因</Label>
        <Input
          id={`payout-reason-${payoutId}`}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="拒绝时必填，如：该期结算单尚未确认"
        />
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() => run('approve')}
        >
          {busy ? '处理中…' : '通过'}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => run('reject')}
        >
          {busy ? '处理中…' : '拒绝'}
        </Button>
      </div>
      {failure && (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      )}
    </div>
  );
}
