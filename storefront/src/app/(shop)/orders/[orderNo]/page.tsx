import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { auth } from '@/auth';
import { OrderDetail } from '@/components/order/order-detail';
import { fetchOrder } from '@/lib/shop-api';

/**
 * 消费者侧订单详情页（Server Component）。
 *
 * ⚠️ 未登录 → 跳登录页；订单不存在（或不属于当前消费者）→ 404。
 * 后端会校验归属（订单号不是秘密，出现在支付回调与商家后台的搜索框里），
 * 这里不做任何「按订单号找别的单」的尝试。
 */
export const dynamic = 'force-dynamic';

export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ orderNo: string }>;
}) {
  const { orderNo } = await params;

  const session = await auth();
  if (!session) {
    redirect('/login');
  }

  const { order, error } = await fetchOrder(orderNo);

  if (!order) {
    // 404（订单不存在 / 不属于当前消费者）交给 notFound()：
    // 渲染一个 404 页面比显示「加载失败」诚实，也不该把 id 探测的结果泄出去。
    if (error && error.includes('404')) {
      notFound();
    }
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 p-6">
        <p className="text-sm text-destructive">{error ?? '订单加载失败'}</p>
        <Link href="/orders" className="text-sm underline">
          返回我的订单
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-6">
      <nav className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link href="/orders" className="underline-offset-4 hover:underline">
          我的订单
        </Link>
        <span aria-hidden>›</span>
        <span>详情</span>
      </nav>

      <OrderDetail initial={order} />
    </main>
  );
}
