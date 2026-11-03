'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import type { PayoutChannelOption } from '@/lib/settings';

/**
 * 平台默认出款渠道表单（客户端组件）。
 *
 * ⚠️ **提交走同源的 `/api/settings/payout-channel` 中转**，不直连后端：
 *    后端没开 CORS，accessToken 也必须留在服务端。
 *    同样**不能**用 `apiFetchAuthed`（它内部 `await auth()`，只能在服务端调用）。
 */
export function PayoutChannelForm({
  current,
  options,
}: {
  /** `null` = 平台还没有配置默认渠道 */
  current: string | null;
  options: PayoutChannelOption[];
}) {
  const router = useRouter();
  const [channel, setChannel] = useState(current ?? '');
  const [pending, setPending] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ⚠️ **当前值可能不在下拉里**（例如 devOnly 渠道被后端 `list()` 过滤掉）。
  //    不补这一项的话，浏览器会把下拉显示成第一项，用户容易误以为当前就是它。
  const currentListed =
    current !== null && options.some((option) => option.channel === current);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setSuccess(null);
    setError(null);

    try {
      const response = await fetch('/api/settings/payout-channel', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new Error(payload.message ?? `保存失败（${response.status}）`);
      }

      setSuccess('已保存');
      // 让服务端页面重新取数，显示新的渠道与来源。
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>默认出款渠道</CardTitle>
        <CardDescription>
          只影响新创建的出款单；出款单一旦开始执行就写死渠道，之后不会换渠道。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="payout-channel">渠道</Label>
            <select
              id="payout-channel"
              value={channel}
              onChange={(event) => setChannel(event.target.value)}
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {/* ⚠️ **尚未配置时的占位项**：没有它，下拉会默认显示第一项，
                  用户以为已经选中了某个渠道，直接点保存才发现选中的不是自己想选的。 */}
              {current === null && !channel ? (
                <option value="">（尚未配置，请选择）</option>
              ) : null}
              {current !== null && !currentListed && (
                <option value={current}>{current}（当前值）</option>
              )}
              {options.map((option) => (
                <option key={option.channel} value={option.channel}>
                  {option.channel}（{option.provider}）
                </option>
              ))}
            </select>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {success && <p className="text-sm text-primary">{success}</p>}
          <div className="flex justify-end">
            <Button type="submit" disabled={pending || channel === ''}>
              {pending ? '保存中…' : '保存'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
