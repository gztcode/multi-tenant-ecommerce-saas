import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 商家侧订单详情的中转。
 *
 * ⚠️ 路径带 `merchant/` 前缀（见 app/api/orders/route.ts 的说明）。
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ orderNo: string }> },
) {
  const { orderNo } = await params;

  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }

  try {
    const result = await apiFetch(
      `/merchant/orders/${encodeURIComponent(orderNo)}`,
      { token: session.accessToken },
    );
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
