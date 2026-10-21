import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import { StoreSettingsForm } from './settings-form';

interface StoreInfo {
  id: string;
  name: string;
  slug: string;
  status: string;
  themeTokens: Record<string, unknown>;
}

export default async function StoreSettingsPage() {
  // 服务端先 GET 一次拿到初始值,客户端表单才有得渲染。
  // 如果让表单完全自己 fetch,首屏会有一次空表单闪烁,而且 server action
  // 也要重新拉,重复劳动。
  let store: StoreInfo | null = null;
  let error: string | null = null;

  try {
    store = await apiFetchAuthed<StoreInfo>('/stores/me');
  } catch (cause) {
    if (cause instanceof ApiError) {
      error = `加载店铺失败（${cause.status}）：${cause.message}`;
    } else {
      error = cause instanceof Error ? cause.message : '店铺加载失败';
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-bold">店铺设置</h2>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {store && <StoreSettingsForm initialStore={store} />}
    </div>
  );
}
