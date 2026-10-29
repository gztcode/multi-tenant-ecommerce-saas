import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 审批拒绝出款的中转：POST /api/billing/payouts/:id/reject。
 *
 * ⚠️ **请求体按白名单重建**：客户端传来的 body 是不受信任的输入，
 *    只取 `reason`，其余字段一律丢掉。**金额永远不在请求体里** ——
 *    拒绝不改金额，改的是单据的状态。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ message: '请求体不是合法 JSON' }, { status: 400 });
  }

  const body = raw as { reason?: unknown };

  // ⚠️ **原因必填**：没有原因的拒绝对商家毫无意义 —— 商家不知道该改什么。
  //    后端也会校验，但在这里就拦掉能给出更明确的提示。
  if (typeof body.reason !== 'string' || body.reason.trim() === '') {
    return NextResponse.json(
      { message: '拒绝出款必须填写原因' },
      { status: 400 },
    );
  }
  if (body.reason.length > 200) {
    return NextResponse.json(
      { message: '拒绝原因不能超过 200 字' },
      { status: 400 },
    );
  }

  try {
    const result = await apiFetch(`/platform/payouts/${id}/reject`, {
      method: 'POST',
      body: { reason: body.reason.trim() },
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
