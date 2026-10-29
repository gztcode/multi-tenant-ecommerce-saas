import { redirect } from 'next/navigation';
import Link from 'next/link';
import { auth, signOut } from '@/auth';

/**
 * 平台超管后台的受保护区：未登录直接跳登录页。
 *
 * 用路由组 `(dashboard)` 的好处是登录页 `(auth)/login` 不在这个 layout 下，
 * 否则会出现「未登录 → 跳 /login → 又被 layout 弹回 /login」的环。
 *
 * 注意这里只挡「未登录」，不挡「角色不对」：后端 `/tenants` 要求
 * PLATFORM_ADMIN，商家令牌会拿到 403——那是数据访问层的判定，
 * 前端再维护一份角色白名单只会两处漂移，由页面自己渲染错误提示即可。
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  // 未登录时 redirect 会抛特殊错误（NEXT_REDIRECT）中断渲染，
  // 因此下面的 session 一定是非空的。
  // ⚠️ **判 `!session?.accessToken` 而不是 `!session`**：
  //    凭证失效时 `jwt-callback.ts` 的 session 回调会把 `accessToken`
  //    兜底成空串，`session` 对象本身仍在 → `!session` 不成立 →
  //    不跳登录页，而是带着空 token 去请求 → 401 → 页面显示「Unauthorized」。
  //    判 `accessToken` 之后，会话失效直接跳登录页（与商家后台一致）。
  if (!session?.accessToken) {
    redirect('/login');
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between border-b pb-4">
        <div className="flex items-center gap-6">
          <h1 className="text-xl font-bold">平台超管后台</h1>
          <nav className="flex gap-4 text-sm">
            <Link href="/" className="underline-offset-4 hover:underline">
              商家列表
            </Link>
            <Link href="/plans" className="underline-offset-4 hover:underline">
              套餐
            </Link>
            <Link href="/subscriptions" className="underline-offset-4 hover:underline">
              订阅
            </Link>
            <Link href="/reports" className="underline-offset-4 hover:underline">
              报表
            </Link>
            <Link href="/commissions" className="underline-offset-4 hover:underline">
              抽佣明细
            </Link>
            <Link href="/settlements" className="underline-offset-4 hover:underline">
              结算单
            </Link>
            <Link href="/payouts" className="underline-offset-4 hover:underline">
              出款
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