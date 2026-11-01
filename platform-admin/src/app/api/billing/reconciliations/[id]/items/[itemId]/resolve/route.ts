import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 处置一条对账差异的中转：POST /api/billing/reconciliations/:id/items/:itemId/resolve。
 *
 * ⚠️ **请求体按白名单重建**：只放行 `resolution` 与 `note`。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; itemId: string }> },
) {
  const { id, itemId } = await params;
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

  const body = raw as { resolution?: unknown; note?: unknown };
  // ⚠️ **处置结果必须白名单校验** —— 后端也校验（`@IsIn`），
  //    但后端拒掉时返回的是一句「校验失败」，界面上看不出哪里填错了。
  if (body.resolution !== 'RESOLVED' && body.resolution !== 'IGNORED') {
    return NextResponse.json(
      { message: '处置结果只能是「已处置」或「已忽略」' },
      { status: 400 },
    );
  }
  if (typeof body.note !== 'string' || body.note.trim() === '') {
    return NextResponse.json(
      { message: '必须填写处置说明' },
      { status: 400 },
    );
  }
  if (body.note.length > 500) {
    return NextResponse.json(
      { message: '处置说明不能超过 500 字' },
      { status: 400 },
    );
  }

  try {
    const result = await apiFetch(
      `/platform/payout-reconciliations/${id}/items/${itemId}/resolve`,
      {
        method: 'POST',
        body: { resolution: body.resolution, note: body.note.trim() },
        token: session.accessToken,
      },
    );
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
