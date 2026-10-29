'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { describePayoutStatus } from '@/lib/payout';
import type { PayoutStatus } from '@/lib/payout';

/**
 * 撤回出款申请的按钮。
 *
 * ⚠️ **只有「待审批」可撤**：已审批的金额已经锁定，撤回要走平台。
 */
export function PayoutCancelButton({
  payoutId,
  status,
}: {
  payoutId: string;
  status: PayoutStatus;
}) {
  const router = useRouter();
  const [failure, setFailure] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);

  if (status !== 'REQUESTED') {
    return null;
  }

  async function handleCancel() {
    if (busyRef.current) return;
    if (!confirm('确定撤回这张出款申请？撤回后可以重新申请同一周期。')) {
      return;
    }

    busyRef.current = true;
    setBusy(true);
    setFailure(null);

    try {
      const response = await fetch(`/api/merchant/payouts/${payoutId}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new Error(payload.message ?? '撤回失败');
      }
      router.refresh();
    } catch (cause) {
      setFailure(
        `撤回失败：${cause instanceof Error ? cause.message : '未知错误'}`,
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={handleCancel}
        >
          {busy ? '撤回中…' : '撤回申请'}
        </Button>
        <span className="text-xs text-muted-foreground">
          当前状态：{describePayoutStatus(status)}
        </span>
      </div>
      {failure && (
        <p role="alert" className="text-xs text-destructive">
          {failure}
        </p>
      )}
    </div>
  );
}
