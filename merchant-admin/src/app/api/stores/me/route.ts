import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { ApiError, apiFetch } from '@/lib/api-client';

/**
 * 店铺设置保存的同源中转接口。
 *
 * 为什么不直接在客户端组件里 fetch 后端 API：
 * 1. **跨域**：后端没有开 CORS（设计上前端与 API 同源，由 Nginx 反代）。
 *    浏览器从 localhost:3002 直连 localhost:3000 会被预检拦掉，
 *    表现为 `Failed to fetch`，且不会带任何后端错误信息。
 * 2. **令牌外泄**：走同源中转后，accessToken 只存在于服务端，
 *    不需要为了发一个 PATCH 就把它塞进客户端组件。
 * 3. **auth() 的调用域**：NextAuth v5 的 `auth()` 要读 cookie，只能在
 *    服务端请求作用域里调用——客户端组件里调它会抛
 *    `headers was called outside a request scope`。
 *
 * 这里复用后端已实现的 PATCH /stores/me，没有另造一套更新逻辑。
 *
 * themeTokens 的**唯一写入方**是设置页的「店铺主题」分区（ThemeForm）。
 * 基本信息表单不再提交这个字段：PATCH 对 themeTokens 是整体覆盖，
 * 两个入口各自提交会让后保存的一方把先保存的 token 整个盖掉。
 */
export async function PATCH(request: Request) {
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

  const payload = (body ?? {}) as {
    name?: unknown;
    themeTokens?: unknown;
  };

  // 客户端发来的请求体是不受信任的输入，不能直接透传给后端。
  const sanitized: { name?: string; themeTokens?: Record<string, unknown> } = {};

  if (payload.name !== undefined) {
    if (typeof payload.name !== 'string') {
      return NextResponse.json({ message: 'name 必须是字符串' }, { status: 400 });
    }
    sanitized.name = payload.name;
  }

  if (payload.themeTokens !== undefined) {
    if (
      typeof payload.themeTokens !== 'object' ||
      payload.themeTokens === null ||
      Array.isArray(payload.themeTokens)
    ) {
      return NextResponse.json(
        { message: 'themeTokens 必须是对象' },
        { status: 400 },
      );
    }
    sanitized.themeTokens = payload.themeTokens as Record<string, unknown>;
  }

  try {
    const store = await apiFetch('/stores/me', {
      method: 'PATCH',
      body: sanitized,
      token: session.accessToken,
    });

    return NextResponse.json(store);
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
