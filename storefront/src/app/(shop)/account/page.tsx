import { auth } from '@/auth';
import Link from 'next/link';
import { redirect } from 'next/navigation';

export default async function CustomerAccountPage() {
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
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 p-8">
      <h1 className="text-2xl font-bold">我的账户</h1>
      <p>邮箱：{session.user?.email}</p>
      <p>角色：{session.role}</p>
      <p>租户：{session.tenantId ?? '（无）'}</p>
      <Link href="/account/addresses" className="text-sm underline">
        收货地址
      </Link>
    </main>
  );
}