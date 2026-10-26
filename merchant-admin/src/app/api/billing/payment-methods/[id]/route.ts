import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 解绑支付方式的中转。
 *
 * ⚠️ **id 来自 URL**，不是请求体——请求体里带一个别人的支付方式 id
 * 就是越权尝试。
 *
 * ⚠️ **后端返回 `{ removed: true }`（200，不是 204）**，所以照实透传即可
 * （不像删券那样要自己造 204 的空响应）。
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }
  const { id } = await params;

  try {
    const result = await apiFetch(`/billing/payment-methods/${id}`, {
      method: 'DELETE',
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
