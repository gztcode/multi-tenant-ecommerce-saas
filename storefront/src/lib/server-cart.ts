import { cookies, headers } from 'next/headers';
import { auth } from '@/auth';
import { apiFetch, apiFetchWithSetCookie, type ApiFetchOptions } from './api-client';
import { resolveTenantSubdomain } from './tenant';

/**
 * 服务端调后端的公共封装。
 *
 * 两处用它：
 * - **中转路由**（`app/api/**`）：把请求转给后端并把 cookie 双向搬运
 * - **页面**（Server Component）：只读地取地址簿与订单
 *
 * 中转路由与页面都要处理 `cart_token` cookie，所以共用同一套逻辑。
 */

/** 游客购物车 cookie 的名字（与后端 api/src/modules/cart/cart.service.ts 一致） */
export const CART_COOKIE = 'cart_token';

/** 当前请求的店铺子域名 */
export async function currentSubdomain(): Promise<string> {
  const headerList = await headers();
  return resolveTenantSubdomain(headerList);
}

/**
 * 要转发给后端的 Cookie 头。
 *
 * 只转发 `cart_token`——浏览器的其它 cookie（NextAuth 的会话 cookie 等）
 * 不该被送到后端，那既没必要也不安全。
 */
export async function forwardableCookie(): Promise<string | undefined> {
  const store = await cookies();
  const token = store.get(CART_COOKIE);
  if (!token || token.value === '') {
    return undefined;
  }
  return `${CART_COOKIE}=${token.value}`;
}

/** 当前登录消费者的 accessToken；未登录（或会话已作废）返回 undefined */
export async function currentToken(): Promise<string | undefined> {
  const session = await auth();
  const token = session?.accessToken;
  // 空串不算「有令牌」——发 `Authorization: Bearer ` 过去，
  // 后端会当成「带了令牌」去验签，然后 401。
  // 不如当作游客，让后端走游客购物车那条路。
  return token && token.length > 0 ? token : undefined;
}

/**
 * 调后端并把 `Set-Cookie` 带回给调用方（由调用方写进响应头）。
 *
 * 游客第一次访问购物车时后端会种下 `cart_token`；不转写的话，
 * 浏览器下一次请求就没有游客车了。
 *
 * ⚠️ 这个函数**只能在 Route Handler 里用**——把 `Set-Cookie` 写进浏览器
 * 是 Route Handler 的活（Server Component 的渲染阶段写 cookie 会抛
 * `ReadonlyRequestCookiesError`）。
 */
export async function fetchWithCookie<T>(
  path: string,
  options: ApiFetchOptions,
): Promise<{ data: T; setCookie: string | null }> {
  return apiFetchWithSetCookie<T>(path, options);
}

/** 调后端（不带 cookie 回写） */
export async function fetchBackend<T>(
  path: string,
  options: ApiFetchOptions,
): Promise<T> {
  return apiFetch<T>(path, options);
}
