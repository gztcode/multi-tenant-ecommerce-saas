import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 人工确认「渠道已打款」的中转：POST /api/billing/payouts/:id/confirm-paid。
 *
 * ⚠️ **后端的真实路径是 `/platform/payout-reconciliations/payouts/:payoutId/confirm-paid`**
 *    —— 确认已付款是对账能力的一部分（要渠道核实的证据），
 *    所以它挂在对账控制器下，不在 `/platform/payouts` 下。
 *    这里的 `/api/billing/payouts/:id/confirm-paid` 只是**同源中转**的路径
 *    （与 `retry` / `unstick` 那几条同款），不是后端路径。
 *
 * ⚠️ **`reconciliationId` 必须透传** —— 后端把它写进
 *    `payout_operations.reconciliationId`，那一列存在的唯一理由就是
 *    「答得出『这次对账纠正了哪几张单』」。丢掉它，这次人工确认
 *    就与对账任务脱钩，事后查不出来。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.accessToken) {
    return unauthorizedResponse();
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ message: '请求体不是合法 JSON' }, { status: 400 });
  }

  const body = raw as { reason?: unknown; reconciliationId?: unknown };
  if (typeof body.reason !== 'string' || body.reason.trim() === '') {
    return NextResponse.json(
      { message: '必须填写操作原因' },
      { status: 400 },
    );
  }
  if (body.reason.length > 500) {
    return NextResponse.json(
      { message: '操作原因不能超过 500 字' },
      { status: 400 },
    );
  }

  const payload: { reason: string; reconciliationId?: string } = {
    reason: body.reason.trim(),
  };
  if (typeof body.reconciliationId === 'string' && body.reconciliationId !== '') {
    payload.reconciliationId = body.reconciliationId;
  }

  try {
    const result = await apiFetch(
      `/platform/payout-reconciliations/payouts/${id}/confirm-paid`,
      {
        method: 'POST',
        body: payload,
        token: session.accessToken,
      },
    );
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
