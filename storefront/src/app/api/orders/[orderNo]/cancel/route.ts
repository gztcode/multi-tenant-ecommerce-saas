import { NextResponse } from 'next/server';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';
import { currentSubdomain, currentToken, fetchBackend } from '@/lib/server-cart';
import type { Order } from '@/lib/cart';

/**
 * 取消订单的中转。
 *
 * 后端会校验归属（不然换个消费者拿订单号就能取消别人的订单）。
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
      `/orders/${encodeURIComponent(orderNo)}/cancel`,
      { method: 'POST', body: {}, subdomain, token },
    );
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
