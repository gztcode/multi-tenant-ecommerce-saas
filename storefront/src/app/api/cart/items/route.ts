import { NextResponse } from 'next/server';
import { readJson, toErrorResponse } from '@/lib/route-helpers';
import {
  currentSubdomain,
  currentToken,
  fetchWithCookie,
  forwardableCookie,
} from '@/lib/server-cart';
import type { Cart } from '@/lib/cart';

/** 单个 SKU 的加购数量上限（与后端 AddCartItemDto 的 MAX_CART_QUANTITY 一致） */
const MAX_CART_QUANTITY = 99;

/**
 * 加购的中转。
 *
 * 请求体按白名单重建：`skuId` 与 `quantity` 两个字段。
 * 不整体透传——后端 ValidationPipe 开了 forbidNonWhitelisted，
 * 客户端多传一个字段就是 400，而那种 400 在界面上只是一句没头没尾的校验失败。
 */
export async function POST(request: Request) {
  const subdomain = await currentSubdomain();
  const token = await currentToken();
  const cookie = await forwardableCookie();

  const parsed: unknown = await readJson(request);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return NextResponse.json({ message: '请求体必须是 JSON 对象' }, { status: 400 });
  }
  const body = parsed as Record<string, unknown>;

  const skuId = body.skuId;
  if (typeof skuId !== 'string' || skuId === '') {
    return NextResponse.json({ message: 'skuId 必须是非空字符串' }, { status: 400 });
  }
  const quantity = body.quantity;
  if (
    typeof quantity !== 'number' ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > MAX_CART_QUANTITY
  ) {
    // ⚠️ 上限要与后端一致：超限的值放过去，后端会 400，
    // 而那种 400 在界面上只是一句没头没尾的校验失败。
    return NextResponse.json(
      { message: `quantity 必须是 1 到 ${MAX_CART_QUANTITY} 之间的整数` },
      { status: 400 },
    );
  }

  try {
    const { data, setCookie } = await fetchWithCookie<Cart>('/cart/items', {
      method: 'POST',
      body: { skuId, quantity },
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
