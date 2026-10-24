import { CartList } from '@/components/cart/cart-list';

/**
 * 购物车页（Server Component）。
 *
 * 只负责外壳——购物车数据由 `CartList` 在客户端经同源的 `/api/cart` 中转取。
 *
 * ⚠️ **为什么不在服务端取数据**：游客购物车靠 `cart_token` cookie 定位，
 * 后端第一次访问时会**种下**这个 cookie。而 Next.js 只允许在 Server Action
 * 或 Route Handler 里写 cookie——在 Server Component 的渲染过程中调
 * `cookies().set()` 会抛 `ReadonlyRequestCookiesError`（整页 500，
 * 但 `tsc` 与 `next build` 都过得去）。中转路由是 Route Handler，
 * 后端种下的 `Set-Cookie` 才能原样落到浏览器上。
 */
export const dynamic = 'force-dynamic';

export default function CartPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-bold">购物车</h1>

      <CartList />
    </main>
  );
}
