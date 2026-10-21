'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ApiError } from '@/lib/api-client';

interface StoreInfo {
  id: string;
  name: string;
  slug: string;
  status: string;
  /** 后端存的是 JSON,字段结构由前端设计系统决定;这里约定嵌套一层 colors。 */
  themeTokens: Record<string, unknown>;
}

/**
 * 把后端返回的 themeTokens 收窄成 `{ colors: { primary: string } }`。
 *
 * themeTokens 是 `Record<string, unknown>`（Json 字段直出）,
 * 任何访问都不能默认它有具体的 shape,先用 `typeof === 'object'` 探一遍,
 * 再依次断言键的存在。读取不到时回落到一个明确的兜底值,
 * 避免表单初始值直接是 undefined 给到 <input type="color">。
 */
function readPrimary(tokens: Record<string, unknown>): string {
  const colors = tokens.colors;
  if (!colors || typeof colors !== 'object') {
    return '#1677ff';
  }
  const primary = (colors as Record<string, unknown>).primary;
  if (typeof primary !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(primary)) {
    return '#1677ff';
  }
  return primary;
}

export function StoreSettingsForm({ initialStore }: { initialStore: StoreInfo }) {
  const router = useRouter();
  const [name, setName] = useState(initialStore.name);
  const [primary, setPrimary] = useState(readPrimary(initialStore.themeTokens));
  const [pending, setPending] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setSuccess(null);
    setError(null);

    try {
      // 与后端约定一致:nest 一层 colors.primary。
      // 后端对 themeTokens 内部形状不校验,但保持这个结构
      // 后续 storefront 读它时就不用再改 schema。
      //
      // 走的是**同源中转**接口而不是直接调后端:后端没开 CORS,
      // 浏览器直连会变成 Failed to fetch;而且 accessToken 只留在服务端。
      // 详见 src/app/api/stores/me/route.ts 的说明。
      const response = await fetch('/api/stores/me', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          themeTokens: { colors: { primary } },
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new ApiError(
          response.status,
          'UNKNOWN',
          payload.message ?? '保存失败',
        );
      }

      setSuccess('已保存');
      // 让 dashboard 概览页也能看到最新值
      router.refresh();
    } catch (cause) {
      if (cause instanceof ApiError) {
        setError(`保存失败（${cause.status}）：${cause.message}`);
      } else {
        setError(cause instanceof Error ? cause.message : '保存失败');
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>店铺设置</CardTitle>
        <CardDescription>
          当前 slug：<code>{initialStore.slug}</code>，状态：{initialStore.status}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="name">店铺名称</Label>
            <Input
              id="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              minLength={2}
              maxLength={60}
              required
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="primary">主题主色</Label>
            <div className="flex items-center gap-2">
              <input
                id="primary"
                type="color"
                value={primary}
                onChange={(event) => setPrimary(event.target.value)}
                className="h-8 w-14 cursor-pointer rounded border border-input bg-transparent p-0"
              />
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{primary}</code>
            </div>
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
