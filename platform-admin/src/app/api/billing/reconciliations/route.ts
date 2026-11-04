import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 手动触发对账的中转：POST /api/billing/reconciliations。
 *
 * ⚠️ **请求体按白名单重建**：只放行 `channel` / `from` / `to`，
 *    其余字段一律丢弃（整体透传等于把「哪些参数影响对账」
 *    交给后端的 forbidNonWhitelisted —— 那种 400 在界面上
 *    只是一句没头没尾的校验失败）。
 */
export async function POST(request: Request) {
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

  const body = raw as {
    channel?: unknown;
    from?: unknown;
    to?: unknown;
  };
  if (typeof body.channel !== 'string' || body.channel.trim() === '') {
    return NextResponse.json({ message: '必须指定渠道名' }, { status: 400 });
  }
  const payload: Record<string, string> = { channel: body.channel.trim() };
  if (typeof body.from === 'string' && body.from !== '') payload.from = body.from;
  if (typeof body.to === 'string' && body.to !== '') payload.to = body.to;

  try {
    const result = await apiFetch('/platform/payout-reconciliations', {
      method: 'POST',
      body: payload,
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
