import { Suspense } from 'react';
import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import { OrderList } from '@/components/order/order-list';
import type { MerchantOrder } from '@/components/order/types';

/**
 * 商家侧订单列表页（Server Component）。
 *
 * 列表数据在服务端取（apiFetchAuthed 走 session 里的 accessToken），
 * 组件只负责渲染表格、筛选与分页。
 *
 * ⚠️ **路径是 `/merchant/orders`**（不是 `/orders`）：两侧鉴权方式不同，
 * 同一条路径挂两套守卫时后注册的那整套会被完全遮住。
 */
interface OrderListResponse {
  items: MerchantOrder[];
  total: number;
}

/** 只接受后端认识的状态值。status 来自查询串，是用户可控的。 */
const STATUS_VALUES = [
  'PENDING_PAYMENT',
  'PAID',
  'SHIPPED',
  'COMPLETED',
  'CANCELLED',
  'REFUNDED',
  'CLOSED',
] as const;

const PAGE_SIZE = 20;

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    from?: string;
    to?: string;
    page?: string;
  }>;
}) {
  const { status, from, to, page } = await searchParams;

  const params = new URLSearchParams();
  if (status && (STATUS_VALUES as readonly string[]).includes(status)) {
    params.set('status', status);
  }
  // 时间筛选：只放「能解析成日期」的值，避免把任意字符串发给后端
  // （后端 new Date('乱七八糟') 会得到 Invalid Date，查询结果莫名其妙）。
  if (from && !Number.isNaN(Date.parse(from))) {
    params.set('from', from);
  }
  if (to && !Number.isNaN(Date.parse(to))) {
    params.set('to', to);
  }
  const parsedPage = Number.parseInt(page ?? '1', 10);
  const currentPage =
    Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  params.set('page', String(currentPage));
  params.set('pageSize', String(PAGE_SIZE));

  let data: OrderListResponse | null = null;
  let error: string | null = null;

  try {
    data = await apiFetchAuthed<OrderListResponse>(
      `/merchant/orders?${params.toString()}`,
    );
  } catch (cause) {
    error =
      cause instanceof ApiError
        ? `加载订单失败（${cause.status}）：${cause.message}`
        : cause instanceof Error
          ? cause.message
          : '订单加载失败';
  }

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-bold">订单</h2>

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
    </div>
  );
}
