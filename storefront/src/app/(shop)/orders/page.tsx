import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { OrderList } from '@/components/order/order-list';
import { fetchMyOrders } from '@/lib/shop-api';
import { isOrderStatus } from '@/lib/cart';

/**
 * 我的订单列表页（Server Component）。
 *
 * 数据在服务端取（apiFetchAuthed 走 session 里的 accessToken），
 * 组件只负责渲染表格与筛选。
 */
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string }>;
}) {
  const session = await auth();
  if (!session) {
    redirect('/login');
  }

  const { status, page } = await searchParams;

  // status 来自查询串，是用户可控的：不校验的话 `?status=FOO` 会被原样
  // 发给后端，后端 @Query 上的枚举转换失败会 400，页面只剩一句
  // 「订单加载失败」，看不出是自己拼错了参数。
  const validStatus =
    status && isOrderStatus(status) ? status : undefined;

  const parsedPage = Number.parseInt(page ?? '1', 10);
  const currentPage = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;

  const { data, error } = await fetchMyOrders({
    status: validStatus,
    page: currentPage,
    pageSize: PAGE_SIZE,
  });

  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-bold">我的订单</h1>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {data && (
        // OrderList 里用了 useSearchParams：Next.js 要求它外面包一层
        // <Suspense>，否则整页在构建时会报「useSearchParams() should be
        // wrapped in a suspense boundary」。
        <Suspense fallback={null}>
          <OrderList
            initial={data.items}
            total={data.total}
            page={currentPage}
            pageSize={PAGE_SIZE}
          />
        </Suspense>
      )}
    </main>
  );
}
