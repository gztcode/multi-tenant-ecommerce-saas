import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { describeStatus, formatCreatedAt, type Tenant } from '@/lib/tenant';
import { TenantStatusForm } from './status-form';

export default async function TenantDetailPage({
  params,
}: {
  // Next.js 15 起 params 是 Promise，必须 await，否则拿到的是 Promise 对象。
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  // 后端目前**没有** `GET /tenants/:id`，只有列表 `GET /tenants`。
  // 所以这里从列表里筛出该 id 的商家，而不是去调不存在的端点——
  // 否则详情页会永远落在 404 分支。
  //
  // 列表接口本身失败（后端没起等）与「列表正常但 id 不存在」要分开处理：
  // 前者是环境问题，页面该给出错误提示；后者是路由问题，该 404。
  let tenants: Tenant[] | null = null;
  let error: string | null = null;

  try {
    tenants = await apiFetchAuthed<Tenant[]>('/tenants');
  } catch (cause) {
    if (cause instanceof ApiError) {
      error = `加载商家失败（${cause.status}）：${cause.message}`;
    } else {
      error = cause instanceof Error ? cause.message : '商家加载失败';
    }
  }

  const tenant = tenants?.find((item) => item.id === id);

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="text-2xl font-bold">商家详情</h2>
        <p className="text-sm text-destructive">{error}</p>
        <Link href="/" className="text-sm underline underline-offset-4">
          返回商家列表
        </Link>
      </div>
    );
  }

  if (!tenant) {
    // tenants 非 null 且筛不到 —— 确认是 id 不存在。
    notFound();
  }

  const status = describeStatus(tenant.status);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h2 className="text-2xl font-bold">{tenant.name}</h2>
        <Link
          href="/"
          className="text-sm text-muted-foreground underline underline-offset-4"
        >
          返回商家列表
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>基本信息</CardTitle>
          <CardDescription>商家 ID：{tenant.id}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <p className="text-sm">
            <span className="text-muted-foreground">名称：</span>
            {tenant.name}
          </p>
          <p className="text-sm">
            <span className="text-muted-foreground">子域名：</span>
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
              {tenant.subdomain}
            </code>
          </p>
          <p className="text-sm">
            <span className="text-muted-foreground">状态：</span>
            <span className={status.className}>{status.label}</span>
            <span className="text-muted-foreground">（{tenant.status}）</span>
          </p>
          <p className="text-sm">
            <span className="text-muted-foreground">创建时间：</span>
            {formatCreatedAt(tenant.createdAt)}
          </p>
        </CardContent>
      </Card>

      <TenantStatusForm tenantId={tenant.id} initialStatus={tenant.status} />
    </div>
  );
}