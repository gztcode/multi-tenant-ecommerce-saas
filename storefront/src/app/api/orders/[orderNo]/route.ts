import { NextResponse } from 'next/server';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';
import { currentSubdomain, currentToken, fetchBackend } from '@/lib/server-cart';
import type { Order } from '@/lib/cart';

/**
 * 订单详情的中转。
 *
 * 后端会校验归属（订单号不是秘密，出现在支付回调与商家后台的搜索框里），
 * 所以这里只负责转发，不做任何「按订单号找」的逻辑。
 */
export async function GET(
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
      `/orders/${encodeURIComponent(orderNo)}`,
      { subdomain, token },
    );
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
