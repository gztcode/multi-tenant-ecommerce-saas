import { auth } from '@/auth';
import { redirect } from 'next/navigation';

export default async function CustomerAccountPage() {
  const session = await auth();

  // 未登录时 redirect 会抛特殊错误（NEXT_REDIRECT）中断渲染，
  // 因此下面的 session 一定是非空的。
  if (!session) {
    redirect('/login');
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 p-8">
      <h1 className="text-2xl font-bold">我的账户</h1>
      <p>邮箱：{session.user?.email}</p>
      <p>角色：{session.role}</p>
      <p>租户：{session.tenantId ?? '（无）'}</p>
    </main>
  );
}