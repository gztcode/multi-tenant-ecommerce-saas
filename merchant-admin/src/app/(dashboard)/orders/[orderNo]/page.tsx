import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import { OrderDetail } from '@/components/order/order-detail';
import type { MerchantOrder } from '@/components/order/types';

/**
 * 商家侧订单详情页（Server Component）。
 *
 * 详情在服务端取（apiFetchAuthed 走 session 里的 accessToken），只把**数据**
 * 往下传给客户端组件，绝不传函数——Server → Client 传事件处理器在 tsc 与
 * next build 下都能过，只有真正渲染这一页时才 500。
 *
 * ⚠️ **路径是 `/merchant/orders`**（不是 `/orders`）。
 */
export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ orderNo: string }>;
}) {
  const { orderNo } = await params;

  let order: MerchantOrder;
  try {
    order = await apiFetchAuthed<MerchantOrder>(
      `/merchant/orders/${encodeURIComponent(orderNo)}`,
    );
  } catch (cause) {
    // 404（订单不存在 / 不属于本租户）交给 notFound()：
    // 渲染一个 404 页面比显示「加载失败」诚实，也不该把 id 探测的结果泄出去。
    if (cause instanceof ApiError && cause.status === 404) {
      notFound();
    }
    return (
      <div className="flex flex-col gap-4">
        <Breadcrumb />
        <p className="text-sm text-destructive">
          {cause instanceof ApiError
            ? `加载订单失败（${cause.status}）：${cause.message}`
            : cause instanceof Error
              ? cause.message
              : '订单加载失败'}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Breadcrumb />
      <OrderDetail initial={order} />
    </div>
  );
}

/** 面包屑 + 返回列表 */
function Breadcrumb() {
  return (
    <nav className="flex items-center gap-2 text-sm text-muted-foreground">
      <Link href="/orders" className="underline-offset-4 hover:underline">
        订单
      </Link>
      <span aria-hidden>›</span>
      <span>详情</span>
    </nav>
  );
}
