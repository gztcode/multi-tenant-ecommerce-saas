import { NextResponse } from 'next/server';
import { ApiError } from './api-client';

/**
 * 同源中转路由（`app/api` 下的各个 `route.ts`）的公共辅助。
 *
 * 中转路由的必要性见 `app/api/stores/me/route.ts` 的注释：
 * 后端没开 CORS、accessToken 不能进客户端、NextAuth 的 `auth()` 只能在
 * 服务端请求作用域里调用。所以客户端组件一律 fetch 同源的 `/api/**`，
 * 由这里的服务端路由用 session 里的 accessToken 去调后端。
 */

/** 读请求体；非法 JSON 返回 null */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * 把后端错误转成同源响应。内部细节不泄给浏览器。
 *
 * ApiError 来自 apiFetch：它的 message 是后端已脱敏的业务提示
 * （例如「该品类下还有子品类，请先删除子品类」），直接透传给页面上是可读的；
 * 而网络层错误（后端没起、反代返回 HTML 的 502）统一收敛成 502，
 * 不把堆栈或 fetch 的原始报错糊到界面上去。
 */
export function toErrorResponse(cause: unknown): NextResponse {
  if (cause instanceof ApiError) {
    return NextResponse.json(
      { message: cause.message, code: cause.code },
      { status: cause.status },
    );
  }
  return NextResponse.json({ message: '后端服务不可用' }, { status: 502 });
}

/** 未登录时的统一响应 */
export function unauthorizedResponse(): NextResponse {
  return NextResponse.json({ message: '未登录或登录已过期' }, { status: 401 });
}