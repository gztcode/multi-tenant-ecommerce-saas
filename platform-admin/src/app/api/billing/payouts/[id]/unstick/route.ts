import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 解除卡单的中转：POST /api/billing/payouts/:id/unstick。
 *
 * ⚠️ **请求体按白名单重建**：只取 `to` 与 `reason`。
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

  const body = raw as { to?: unknown; reason?: unknown };
  // ⚠️ **「重新打款」的 `to` 绝不能有默认值** —— 默认成 `FAILED` 的话，
  //    运营漏传就会**静默走错方向**（把「重打」变成「标记失败」）。
  if (body.to !== 'FAILED' && body.to !== 'APPROVED') {
    return NextResponse.json(
      { message: '必须指定目标状态（FAILED 或 APPROVED）' },
      { status: 400 },
    );
  }
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

  try {
    const result = await apiFetch(`/platform/payouts/${id}/unstick`, {
      method: 'POST',
      body: { to: body.to, reason: body.reason.trim() },
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
