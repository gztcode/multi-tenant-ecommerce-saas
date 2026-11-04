import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 对账任务详情的中转：GET /api/billing/reconciliations/:id。
 *
 * ⚠️ **服务端组件直连后端、不走这里** —— 这个路由是给客户端组件
 *    刷新后重新取数的备用通道（见 `reconciliation-actions.tsx`）。
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.accessToken) {
    return unauthorizedResponse();
  }
  try {
    const result = await apiFetch(`/platform/payout-reconciliations/${id}`, {
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
