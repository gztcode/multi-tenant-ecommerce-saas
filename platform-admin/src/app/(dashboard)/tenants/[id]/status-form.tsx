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
import { describeStatus, normalizeStatus, TENANT_STATUSES } from '@/lib/tenant';

/**
 * 商家状态切换表单。
 *
 * ⚠️ 提交走的是**同源**的 `/api/tenants/:id/status` 中转接口，不是直接
 * fetch 后端。两个原因，缺一不可：
 * 1. 后端没开 CORS（设计上前端与 API 同源、由 Nginx 反代），
 *    浏览器直连 localhost:3000 会被拦掉，只留下毫无线索的 `Failed to fetch`；
 * 2. accessToken 因此可以完全留在服务端，不必为发一个 PATCH 就下发到客户端。
 *
 * 同理也**不能**用 `apiFetchAuthed`：它内部 `await auth()`，
 * 而 NextAuth v5 的 auth() 在 JWT 策略下要读 cookie（走 `headers()`），
 * 只能在服务端组件/路由的请求作用域里调用；客户端调用会抛
 * 「`headers` was called outside a request scope」。
 */
export function TenantStatusForm({
  tenantId,
  initialStatus,
}: {
  tenantId: string;
  initialStatus: string;
}) {
  const router = useRouter();
  const initial = normalizeStatus(initialStatus);
  // 后端状态值不在已知枚举内时（例如后端先加了一个新状态），
  // 下拉框回落到 TRIAL，但**不会**因为默认值而静默提交——
  // 用户必须主动点「保存」才会覆盖。
  const [status, setStatus] = useState(initial ?? 'TRIAL');
  const [pending, setPending] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setSuccess(null);
    setError(null);

    try {
      const response = await fetch(`/api/tenants/${tenantId}/status`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status }),
      });

      if (!response.ok) {
        // 中转接口的错误体是 { message }；解析失败时兜底成状态码文案，
        // 不能让 catch 块只显示一个无信息的 "Failed to fetch"。
        const payload = (await response.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new Error(payload.message ?? `请求失败（${response.status}）`);
      }

      setSuccess('已更新');
      // 让详情页与列表页都读到服务端的新值，而不是继续显示本地 state。
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '更新失败');
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>状态管理</CardTitle>
        <CardDescription>
          当前状态：{describeStatus(initialStatus).label}。
          置为「已停用」后该商家的店铺将无法访问。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="status">目标状态</Label>
            <select
              id="status"
              value={status}
              onChange={(event) =>
                setStatus(event.target.value as (typeof TENANT_STATUSES)[number])
              }
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {TENANT_STATUSES.map((option) => (
                <option key={option} value={option}>
                  {describeStatus(option).label}（{option}）
                </option>
              ))}
            </select>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {success && <p className="text-sm text-primary">{success}</p>}
          <div className="flex justify-end">
            <Button type="submit" disabled={pending}>
              {pending ? '保存中…' : '保存'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}