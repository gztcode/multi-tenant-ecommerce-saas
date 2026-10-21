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
  if (!session) {
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
          </nav>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-muted-foreground">{session.user?.email}</span>
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
