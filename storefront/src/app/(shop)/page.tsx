import { headers } from 'next/headers';
import { apiFetch } from '@/lib/api-client';
import { resolveTenantSubdomain } from '@/lib/tenant';

interface StoreInfo {
  id: string;
  name: string;
  slug: string;
  status: string;
}

export default async function StorefrontHome() {
  // Next.js 15 起 headers() 是异步的，必须 await。
  const headerList = await headers();
  const subdomain = resolveTenantSubdomain(headerList);

  let store: StoreInfo | null = null;
  let error: string | null = null;

  try {
    store = await apiFetch<StoreInfo>(`/stores/by-subdomain/${subdomain}`);
  } catch (cause) {
    // 店铺信息拉不到时仍然要渲染页面：子域名写错、店铺不存在、或者后端没起，
    // 都应该给用户一句能看懂的提示，而不是一个 500 空白页。
    error = cause instanceof Error ? cause.message : '店铺加载失败';
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-3xl font-bold">{store?.name ?? '未知店铺'}</h1>
      <p className="text-muted-foreground">子域名：{subdomain}</p>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <p className="text-sm text-muted-foreground">
        商品与结算功能在计划 2、计划 3 交付。
      </p>
      <a href="/login" className="text-sm underline">
        消费者登录
      </a>
    </main>
  );
}