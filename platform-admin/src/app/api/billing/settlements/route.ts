import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 生成结算单的中转：POST /api/billing/settlements。
 *
 * ⚠️ **为什么不直接在客户端组件里 fetch 后端 API**：
 * ① 后端没开 CORS（前端与 API 同源，由 Nginx 反代）；
 * ② accessToken 不该进客户端代码。
 *
 * ⚠️ **请求体按白名单重建**：客户端传来的 body 是不受信任的输入，
 * 不能直接透传给后端。金额**永远不在请求体里** —— 结算单的金额只从流水算。
 */

/** 周期标识的格式 */
const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** uuid 的格式 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
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

  const body = raw as { period?: unknown; tenantId?: unknown };

  // ⚠️ **period 必须匹配 YYYY-MM**：后端也会校验，但在这里就拦掉
  //    能给出更明确的提示（界面上「周期格式非法」比「校验失败」有用）。
  if (typeof body.period !== 'string' || !PERIOD_PATTERN.test(body.period)) {
    return NextResponse.json(
      { message: '周期格式非法：必须是 YYYY-MM（如 2026-10）' },
      { status: 400 },
    );
  }

  const payload: { period: string; tenantId?: string } = {
    period: body.period,
  };
  if (body.tenantId !== undefined && body.tenantId !== null) {
    if (
      typeof body.tenantId !== 'string' ||
      !UUID_PATTERN.test(body.tenantId)
    ) {
      return NextResponse.json(
        { message: 'tenantId 必须是合法的 uuid' },
        { status: 400 },
      );
    }
    payload.tenantId = body.tenantId;
  }

  try {
    const result = await apiFetch('/platform/settlements', {
      method: 'POST',
      body: payload,
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
