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
  /** 主题配置由同一页面的 ThemeForm 独占读写，这里只读不用。 */
  themeTokens: Record<string, unknown>;
}

/**
 * 店铺基本信息表单——**只负责 name**。
 *
 * ⚠️ 这里刻意不再提交 themeTokens。
 *
 * 早先本表单自带一个「主题主色」取色器，保存时写 `themeTokens: { colors: { primary } }`。
 * 接入全量主题表单（ThemeForm）后这会出事：PATCH 是整体覆盖 themeTokens 字段，
 * 商家在上面的主题分区配好 30 多个 token，只要在这里点一次「保存」，
 * 整个 themeTokens 就被这个只含 primary 的对象整个盖掉——静默丢数据，且没有任何提示。
 *
 * 让一个组件独占某个字段的写入权，比在两处各自提交、各自覆盖要可靠得多。
 * 主题的编辑入口统一是同一页面的「店铺主题」分区。
 */
export function StoreSettingsForm({ initialStore }: { initialStore: StoreInfo }) {
  const router = useRouter();
  const [name, setName] = useState(initialStore.name);
  const [pending, setPending] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setSuccess(null);
    setError(null);

    try {
      // 走**同源中转**接口而不是直接调后端:后端没开 CORS,
      // 浏览器直连会变成 Failed to fetch;而且 accessToken 只留在服务端。
      // 详见 src/app/api/stores/me/route.ts 的说明。
      //
      // 请求体里**不含 themeTokens**:不传的字段后端保持原值。
      const response = await fetch('/api/stores/me', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
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