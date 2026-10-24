import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/route-helpers';
import {
  currentSubdomain,
  currentToken,
  fetchBackend,
  fetchWithCookie,
  forwardableCookie,
} from '@/lib/server-cart';
import type { Cart } from '@/lib/cart';

/**
 * 购物车的中转：GET 读当前车、DELETE 清空。
 *
 * 游客的购物车靠 `cart_token` cookie 定位——请求时把浏览器的 cookie
 * 转发给后端，后端种下的 cookie 再转写回浏览器。
 */
export async function GET() {
  const subdomain = await currentSubdomain();
  const token = await currentToken();
  const cookie = await forwardableCookie();

  try {
    const { data, setCookie } = await fetchWithCookie<Cart>('/cart', {
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

export async function DELETE() {
  const subdomain = await currentSubdomain();
  const token = await currentToken();
  const cookie = await forwardableCookie();

  try {
    await fetchBackend('/cart', {
      method: 'DELETE',
      subdomain,
      token,
      cookie,
    });
    return new NextResponse(null, { status: 204 });
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
