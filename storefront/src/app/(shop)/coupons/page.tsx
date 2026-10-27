import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { CouponList } from '@/components/coupon/coupon-list';
import { fetchAvailableCoupons, fetchMyCoupons } from '@/lib/shop-api';

/**
 * 领券中心（Server Component）。
 *
 * ## 为什么取数在服务端
 *
 * 券要登录才能领（后端整组挂 JwtAuthGuard），而 accessToken 只在服务端
 * 请求作用域里拿得到——与地址簿、订单列表同一套做法（`lib/shop-api.ts`）。
 *
 * ## `now` 从服务端传下去
 *
 * ⚠️ 「我的券」的状态（可用 / 已用完 / 已过期）要拿当前时间判。
 * 如果在客户端组件里直接 `new Date()`，服务端渲染出的 HTML 与客户端
 * 首次渲染（hydration）算出来的时刻可能差几毫秒——跨过 `endsAt` 的
 * 那一刻两边就会渲染出不同的文字，React 报 hydration 不一致。
 * 由服务端算好一个时刻传下去，两边用的是同一个值。
 */
export const dynamic = 'force-dynamic';

export default async function CouponsPage() {
  const session = await auth();
  if (!session?.accessToken) {
    redirect('/login');
  }

  const [{ coupons: available }, { coupons: mine }] = await Promise.all([
    fetchAvailableCoupons(),
    fetchMyCoupons(),
  ]);

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-bold">领券中心</h1>

      <CouponList available={available} mine={mine} now={new Date().toISOString()} />
    </main>
  );
}
