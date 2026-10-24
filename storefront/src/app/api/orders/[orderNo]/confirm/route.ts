import { NextResponse } from 'next/server';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';
import { currentSubdomain, currentToken, fetchBackend } from '@/lib/server-cart';
import type { Order } from '@/lib/cart';

/**
 * 确认收货的中转。
 *
 * 后端会校验归属与状态机（只有 `SHIPPED` 能转 `COMPLETED`）。
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ orderNo: string }> },
) {
  const { orderNo } = await params;
  const token = await currentToken();
  if (!token) {
    return unauthorizedResponse();
  }
  const subdomain = await currentSubdomain();

  try {
    const result = await fetchBackend<Order>(
      `/orders/${encodeURIComponent(orderNo)}/confirm`,
      { method: 'POST', body: {}, subdomain, token },
    );
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
