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
  failedBeforePayout,
}: {
  payoutId: string;
  status: PayoutStatus;
  /** 申请时的预估金额（审批时会重算 → 两者可能不同） */
  requestedAmount: number;
  /**
   * 这次失败是否发生在打款之前（钱确定没打出去）。
   *
   * ⚠️ **只有它为 true 才给「重试」按钮** —— 钱可能已经打出去的单
   *    重试 = **重复打款**。
   */
  failedBeforePayout?: boolean;
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

  /**
   * 平台端的人工处置（重试 / 解卡，阶段 5l）。
   *
   * ⚠️ **顺序是「先确认 → 再收原因 → 最后才发请求」**：
   *    取消确认就一步都不该往下走；原因留空也**不该发请求**
   *    （涉及钱的操作没有理由就等于没有留痕）。
   */
  async function runManual(
    action: 'retry' | 'unstick-failed' | 'unstick-redo',
  ) {
    // ⚠️ **闸门读的是 ref 不是 state**（与现有 `run` 同款）——
    //    连点两次会一起通过检查发出两次请求。
    if (busyRef.current) return;

    const confirms: Record<typeof action, string> = {
      retry:
        '确定重试这张出款单？\n钱确定没有打出去，重试后会重新打款。',
      'unstick-failed':
        '确定把这张单标记为失败？\n' +
        '请先核对渠道是否已打款 —— 标记失败后商家可以对该期重新申请。',
      'unstick-redo':
        '⚠️ 这张单可能已经打款！\n' +
        '重新打款会重复打款。请先核对渠道是否已到账。确认继续？',
    };
    if (!confirm(confirms[action])) {
      return;
    }

    // ⚠️ **原因必填** —— 涉及钱的操作不能没有理由（会记进操作留痕）
    const answer = prompt('请填写操作原因（会记进操作留痕）');
    const trimmed = (answer ?? '').trim();
    if (!trimmed) {
      setFailure('必须填写操作原因');
      return;
    }

    busyRef.current = true;
    setBusy(true);
    setFailure(null);

    try {
      const url =
        action === 'retry'
          ? `/api/billing/payouts/${payoutId}/retry`
          : `/api/billing/payouts/${payoutId}/unstick`;
      const body =
        action === 'retry'
          ? { reason: trimmed }
          : {
              to: action === 'unstick-failed' ? 'FAILED' : 'APPROVED',
              reason: trimmed,
            };
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const problem = await readFailure(response, FAILURE_TEXT);
      if (problem) throw new Error(problem);

      // ⚠️ **成功后必须 router.refresh()**（与现有 `run` 同款）
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

  // ⚠️ **出款失败的人工处置（阶段 5l）**：只有「钱确定没打出去」的单
  //    才给「重试」—— 渠道调过了只是没成功回包的单，钱可能已经打出去，
  //    重试 = **重复打款**。那种单只能人工核对渠道。
  if (status === 'FAILED') {
    return (
      <div className="flex flex-col gap-2">
        {failedBeforePayout ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => runManual('retry')}
          >
            {busy ? '处理中…' : '重试'}
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">
            该单可能已打款（渠道调过了，只是没成功回包），不能直接重试。
            请先核对渠道是否已到账。
          </p>
        )}
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
      </div>
    );
  }

  // ⚠️ **卡在「打款中」的人工解卡（阶段 5l）**：钱可能已经打出去 ——
  //    「重新打款」是重复打款的高危操作，必须在按钮旁用红字警示。
  if (status === 'PROCESSING') {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-destructive">
          ⚠️ 这张单可能已打款（卡在「打款中」超过 10 分钟）。
          重新打款会重复打款，请先核对渠道。
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => runManual('unstick-failed')}
          >
            {busy ? '处理中…' : '标记为失败'}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => runManual('unstick-redo')}
          >
            {busy ? '处理中…' : '重新打款'}
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
