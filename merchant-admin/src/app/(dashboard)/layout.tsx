import { redirect } from 'next/navigation';
import Link from 'next/link';
import { auth, signOut } from '@/auth';

/**
 * 商家后台的受保护区：未登录直接跳登录页。
 *
 * 用路由组 `(dashboard)` 的好处是登录页 `(auth)/login` 不在这个 layout 下,
 * 否则会出现「未登录 → 跳 /login → 又被 layout 弹回 /login」的环。
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  // 未登录时 redirect 会抛特殊错误（NEXT_REDIRECT）中断渲染,
  // 因此下面的 session 一定是非空的。
  //
  // ⚠️ 判 `!session?.accessToken` 而不是 `!session`：
  // 会话作废（刷新失败）后 session 仍存在，只是 accessToken 是 ''。
  // 只判 !session 的话页面仍显示「已登录」，点任何操作都是 401
  // ——L1 的症状不会因为 session 回调的 `?? ''` 而消失。
  if (!session?.accessToken) {
    redirect('/login');
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between border-b pb-4">
        <div className="flex items-center gap-6">
          <h1 className="text-xl font-bold">商家后台</h1>
          <nav className="flex gap-4 text-sm">
            <Link href="/" className="underline-offset-4 hover:underline">
              概览
            </Link>
            <Link href="/settings" className="underline-offset-4 hover:underline">
              店铺设置
            </Link>
            <Link href="/products" className="underline-offset-4 hover:underline">
              商品
            </Link>
            <Link href="/categories" className="underline-offset-4 hover:underline">
              品类
            </Link>
            <Link href="/inventory" className="underline-offset-4 hover:underline">
              库存
            </Link>
            <Link href="/orders" className="underline-offset-4 hover:underline">
              订单
            </Link>
            <Link href="/marketing" className="underline-offset-4 hover:underline">
              营销
            </Link>
          </nav>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-muted-foreground">{session?.user?.email}</span>
          <form
            action={async () => {
              'use server';
              await signOut({ redirectTo: '/login' });
            }}
          >
            <button type="submit" className="underline">
              退出登录
            </button>
          </form>
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
