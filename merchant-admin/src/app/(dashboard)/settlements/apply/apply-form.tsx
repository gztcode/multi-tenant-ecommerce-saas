'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api-client';
import { formatCents } from '@/lib/payout';
import type { AvailablePeriod } from '@/lib/payout';

/**
 * 申请出款的表单。
 *
 * ⚠️ **周期用裸 `<select>`**：merchant-admin 没有 select 组件，
 * 而且 `type="month"` 的 input 在自动化测试里会被 jsdom 清洗成空串
 * （5g 的教训：非法周期那条用例根本没测到月份上界分支）。
 * 这里用 `<select>` 列可申请周期 —— 商家能选的只有后端给的那几个。
 */
export function PayoutApplyForm({ periods }: { periods: AvailablePeriod[] }) {
  const router = useRouter();
  const [period, setPeriod] = useState(periods[0]?.period ?? '');
  const [pending, setPending] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  const selected = periods.find((item) => item.period === period);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    // ⚠️ **闸门读的是 ref 不是 state**：state 同一 tick 内还是旧值，
    // 连点两次会一起通过检查发出两次请求（5g 的同款教训）。
    if (busyRef.current) return;

    if (!period) {
      setError('没有可申请的周期');
      return;
    }

    busyRef.current = true;
    setPending(true);
    setSuccess(null);
    setError(null);

    try {
      const response = await fetch('/api/merchant/payouts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // ⚠️ **请求体里只有周期**：金额是后端算的，
        // 客户端多传一个 `amount` 也到不了后端（中转路由白名单重建）。
        body: JSON.stringify({ period }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new ApiError(
          response.status,
          'UNKNOWN',
          payload.message ?? '申请失败',
        );
      }

      setSuccess('申请已提交，等待平台审批');
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? `申请失败：${cause.message}`
          : cause instanceof Error
            ? cause.message
            : '申请失败',
      );
    } finally {
      busyRef.current = false;
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>选择周期</CardTitle>
        <CardDescription>
          只有已结束、且有应结金额的周期才能申请。
        </CardDescription>
      </CardHeader>
      <CardContent>
        {periods.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            暂无可申请的周期。
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <Label htmlFor="period">结算周期</Label>
              <select
                id="period"
                value={period}
                onChange={(event) => setPeriod(event.target.value)}
                className="rounded-md border px-2 py-1 text-sm"
              >
                {periods.map((item) => (
                  <option key={item.period} value={item.period}>
                    {item.period}（应结 {formatCents(item.netAmount)}）
                    {item.alreadyApplied ? ' · 已申请' : ''}
                  </option>
                ))}
              </select>
            </div>

            {selected && (
              <div className="flex flex-col gap-1 text-sm text-muted-foreground">
                <p>
                  货款净额 {formatCents(selected.receiptAmount)} · 平台佣金{' '}
                  {formatCents(selected.commissionAmount)} · 应结{' '}
                  {formatCents(selected.netAmount)}
                </p>
                <p>共 {selected.entryCount} 笔货款</p>
              </div>
            )}

            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {success && (
              <p role="status" className="text-sm text-primary">
                {success}
              </p>
            )}

            <div className="flex justify-end">
              <Button type="submit" disabled={pending || !period}>
                {pending ? '提交中…' : '提交申请'}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
