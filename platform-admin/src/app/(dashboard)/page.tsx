import Link from 'next/link';
import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { describeStatus, formatCreatedAt, type Tenant } from '@/lib/tenant';

export default async function TenantListPage() {
  // `GET /tenants` 要求平台超管身份。未登录已被 layout 提前挡掉，
  // 剩下的失败主要是后端没起 / 令牌角色不对（403）/ 网络抖动——
  // 一律渲染成页面上的错误提示，不让整页 500。
  let tenants: Tenant[] | null = null;
  let error: string | null = null;

  try {
    tenants = await apiFetchAuthed<Tenant[]>('/tenants');
  } catch (cause) {
    if (cause instanceof ApiError) {
      error = `加载商家列表失败（${cause.status}）：${cause.message}`;
    } else {
      error = cause instanceof Error ? cause.message : '商家列表加载失败';
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-bold">商家列表</h2>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {tenants && (
        <Card>
          <CardHeader>
            <CardTitle>商家（{tenants.length}）</CardTitle>
            <CardDescription>点击商家名称进入详情，可变更其启用状态。</CardDescription>
          </CardHeader>
          <CardContent>
            {tenants.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无商家。</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>名称</TableHead>
                    <TableHead>子域名</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>创建时间</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tenants.map((tenant) => {
                    const status = describeStatus(tenant.status);
                    return (
                      <TableRow key={tenant.id}>
                        <TableCell className="font-medium">
                          <Link
                            href={`/tenants/${tenant.id}`}
                            className="underline-offset-4 hover:underline"
                          >
                            {tenant.name}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                            {tenant.subdomain}
                          </code>
                        </TableCell>
                        <TableCell>
                          <span className={status.className}>{status.label}</span>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatCreatedAt(tenant.createdAt)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}