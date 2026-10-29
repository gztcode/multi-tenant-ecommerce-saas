import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 撤回出款申请的中转（DELETE）。
 *
 * ⚠️ **撤回是幂等的语义由后端管**：只有「待审批」能撤，
 *    已审批的会拿到 409 —— 这里原样透传后端的文案。
 */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }

  // Next.js 15 起 params 是 Promise，必须 await。
  const { id } = await context.params;

  try {
    const result = await apiFetch(`/merchant/payouts/${id}`, {
      method: 'DELETE',
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
