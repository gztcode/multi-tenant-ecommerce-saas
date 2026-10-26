import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 设为默认支付方式的中转。
 *
 * ⚠️ **id 来自 URL**，不是请求体——同解绑路由，不给越权的口子。
 *
 * ⚠️ **后端返回 `{ updated: true }`（200）**，照实透传即可。
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }
  const { id } = await params;

  try {
    const result = await apiFetch(`/billing/payment-methods/${id}/default`, {
      method: 'POST',
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
