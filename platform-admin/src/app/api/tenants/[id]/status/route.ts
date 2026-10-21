import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { ApiError, apiFetch } from '@/lib/api-client';
import { TENANT_STATUSES } from '@/lib/tenant';

/**
 * 商家状态变更的同源中转接口。
 *
 * 为什么不直接在客户端组件里 fetch 后端 API：
 * 1. **跨域**：后端没有开 CORS（设计上前端与 API 同源，由 Nginx 反代）。
 *    浏览器从 localhost:3003 直连 localhost:3000 会被预检拦掉，
 *    表现为 `Failed to fetch`，且不会带任何后端错误信息。
 * 2. **令牌外泄**：走同源中转后，accessToken 只存在于服务端，
 *    不需要为了发一个 PATCH 就把它塞进客户端组件的 props。
 *
 * 这里复用后端已实现的 /tenants/:id/status，没有另造一套更新逻辑。
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await auth();

  if (!session) {
    return NextResponse.json(
      { message: '未登录或登录已过期' },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: '请求体不是合法 JSON' }, { status: 400 });
  }

  const status = (body as { status?: unknown })?.status;

  // 这里做一次白名单校验：即便前端下拉框已经限定了取值，
  // 客户端发来的请求体仍是不受信任的输入，不能直接透传给后端。
  if (
    typeof status !== 'string' ||
    !(TENANT_STATUSES as readonly string[]).includes(status)
  ) {
    return NextResponse.json(
      { message: 'status 必须是 TRIAL / ACTIVE / SUSPENDED' },
      { status: 400 },
    );
  }

  try {
    const tenant = await apiFetch(`/tenants/${id}/status`, {
      method: 'PATCH',
      body: { status },
      token: session.accessToken,
    });

    return NextResponse.json(tenant);
  } catch (cause) {
    if (cause instanceof ApiError) {
      return NextResponse.json(
        { message: cause.message },
        { status: cause.status },
      );
    }
    // 后端没起等网络层错误统一收敛成 502，别把内部细节泄给浏览器。
    return NextResponse.json({ message: '后端服务不可用' }, { status: 502 });
  }
}