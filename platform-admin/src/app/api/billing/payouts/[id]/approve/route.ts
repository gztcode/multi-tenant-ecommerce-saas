import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 审批通过出款的中转：POST /api/billing/payouts/:id/approve。
 *
 * ⚠️ **请求体为空**：审批通过不接受任何参数（金额由后端重算并锁定，
 *    不能由客户端指定）。
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }

  try {
    const result = await apiFetch(`/platform/payouts/${id}/approve`, {
      method: 'POST',
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
