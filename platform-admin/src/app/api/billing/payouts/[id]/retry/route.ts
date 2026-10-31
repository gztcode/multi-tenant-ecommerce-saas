import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 人工重试出款的中转：POST /api/billing/payouts/:id/retry。
 *
 * ⚠️ **请求体按白名单重建**：客户端传来的 body 是不受信任的输入，
 *    只取 `reason`，其余字段一律丢掉。
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
  // ⚠️ **原因必填** —— 涉及钱的操作不能没有理由（会记进操作留痕）
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
    const result = await apiFetch(`/platform/payouts/${id}/retry`, {
      method: 'POST',
      body: { reason: body.reason.trim() },
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
