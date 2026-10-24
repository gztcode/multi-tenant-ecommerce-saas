import { NextResponse } from 'next/server';
import { ApiError } from './api-client';

/**
 * 同源中转路由（`app/api` 下）的公共辅助。
 *
 * ## 为什么 storefront 也要中转
 *
 * 1. **后端没开 CORS**：浏览器直连后端会被预检拦掉（Failed to fetch）。
 * 2. **accessToken 不能进客户端**：NextAuth 的 `auth()` 只能在服务端请求作用域里调。
 * 3. **游客购物车靠 cookie**：后端定位游客车要 `cart_token` cookie，
 *    中转路由在同一台服务器上转发 cookie 最省事。
 *
 * 所以客户端组件一律 fetch 同源的 `/api/**`，由这里的服务端路由用
 * session 里的 accessToken 与浏览器 cookie 去调后端。
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
 * 把后端的错误码翻成**人能看懂**的中文提示。
 *
 * ⚠️ 只翻「后端的通用兜底文案」，不翻业务文案：
 * 后端自己的 message（如「同一商品的加购总量不能超过 99」）
 * 已经写得很清楚，原样透传即可——硬翻反而会丢掉精度。
 *
 * 后端认证失败时抛的是 Nest 默认的 `UnauthorizedException('Unauthorized')`，
 * 那是英文的框架默认文案，直接显示在页面上对消费者毫无意义。
 */
function readableMessage(error: ApiError): string {
  if (error.status === 401 && error.message === 'Unauthorized') {
    return '登录已过期，请重新登录';
  }
  return error.message;
}

/**
 * 把后端错误转成同源响应。内部细节不泄给浏览器。
 *
 * ApiError 的 message 是后端已脱敏的业务提示，直接透传给页面上是可读的；
 * 网络层错误（后端没起、反代返回 HTML 的 502）统一收敛成 502，
 * 不把堆栈或 fetch 的原始报错糊到界面上。
 */
export function toErrorResponse(cause: unknown): NextResponse {
  if (cause instanceof ApiError) {
    return NextResponse.json(
      { message: readableMessage(cause), code: cause.code },
      { status: cause.status },
    );
  }
  return NextResponse.json({ message: '后端服务不可用' }, { status: 502 });
}

/** 未登录时的统一响应 */
export function unauthorizedResponse(): NextResponse {
  return NextResponse.json({ message: '未登录或登录已过期' }, { status: 401 });
}
