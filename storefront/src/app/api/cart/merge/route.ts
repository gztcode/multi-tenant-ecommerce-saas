import { NextResponse } from 'next/server';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';
import {
  currentSubdomain,
  currentToken,
  fetchWithCookie,
  forwardableCookie,
} from '@/lib/server-cart';
import type { Cart } from '@/lib/cart';

/**
 * 登录后把游客购物车合并进账号购物车。
 *
 * 必须登录——没有 customerId 就没有账号车可合并。
 *
 * ⚠️ 后端合并完会 `Set-Cookie: cart_token=; …` 清掉游客车的 cookie。
 * 那个清 cookie 的头**要转写**：游客车已经被合并并删掉了，
 * 留着 token 只会让后端下次去找一个不存在的游客车（幂等，不会出错，
 * 但每次都白查一次库）。清掉更干净。
 */
export async function POST() {
  const token = await currentToken();
  if (!token) {
    return unauthorizedResponse();
  }
  const subdomain = await currentSubdomain();
  const cookie = await forwardableCookie();

  try {
    const { data, setCookie } = await fetchWithCookie<Cart>('/cart/merge', {
      method: 'POST',
      subdomain,
      token,
      cookie,
    });

    const response = NextResponse.json(data);
    if (setCookie) {
      response.headers.append('set-cookie', setCookie);
    }
    return response;
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
