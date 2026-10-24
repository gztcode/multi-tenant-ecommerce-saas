import { NextResponse } from 'next/server';
import { readJson, toErrorResponse } from '@/lib/route-helpers';
import {
  currentSubdomain,
  currentToken,
  fetchWithCookie,
  forwardableCookie,
} from '@/lib/server-cart';
import type { Cart } from '@/lib/cart';

/**
 * 改购物车条目数量的中转（PATCH）与删除条目（DELETE）。
 *
 * 请求体按白名单重建：PATCH 只接受 `quantity`。
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const subdomain = await currentSubdomain();
  const token = await currentToken();
  const cookie = await forwardableCookie();

  const parsed: unknown = await readJson(request);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return NextResponse.json({ message: '请求体必须是 JSON 对象' }, { status: 400 });
  }
  const body = parsed as Record<string, unknown>;

  const quantity = body.quantity;
  if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1) {
    return NextResponse.json(
      { message: 'quantity 必须是大于等于 1 的整数' },
      { status: 400 },
    );
  }

  try {
    const { data, setCookie } = await fetchWithCookie<Cart>(
      `/cart/items/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: { quantity },
        subdomain,
        token,
        cookie,
      },
    );

    const response = NextResponse.json(data);
    if (setCookie) {
      response.headers.append('set-cookie', setCookie);
    }
    return response;
  } catch (cause) {
    return toErrorResponse(cause);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const subdomain = await currentSubdomain();
  const token = await currentToken();
  const cookie = await forwardableCookie();

  try {
    await fetchWithCookie<Cart>(
      `/cart/items/${encodeURIComponent(id)}`,
      { method: 'DELETE', subdomain, token, cookie },
    );
    return new NextResponse(null, { status: 204 });
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
