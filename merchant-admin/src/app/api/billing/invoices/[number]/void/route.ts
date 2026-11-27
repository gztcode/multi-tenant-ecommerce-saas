import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import {
  readJson,
  toErrorResponse,
  unauthorizedResponse,
} from '@/lib/route-helpers';

/**
 * 账单作废的中转：POST 把账单置为 `VOID`（**保留记录，不删行**）。
 *
 * ⚠️ **账单号来自 URL**，不是请求体——请求体里带一个别的账单号
 * 就是替别家作废账单的越权尝试。
 *
 * ⚠️ **作废人由后端从登录态取**，前端传不了；请求体只放可选的作废原因。
 *
 * ⚠️ **动态段名必须与同层的 `[number]/pay` 一致**：Next.js 不允许
 * 同一个动态路径下出现两个不同的 slug 名（`[number]` 与 `[id]`）。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ number: string }> },
) {
  const session = await auth();
  if (!session?.accessToken) {
    return unauthorizedResponse();
  }
  const { number } = await params;

  const payload = (await readJson(request)) as Record<string, unknown>;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return NextResponse.json(
      { message: '请求体必须是 JSON 对象' },
      { status: 400 },
    );
  }

  // 白名单重建：只放可选的作废原因（未知字段一律丢弃）
  const body: Record<string, unknown> = {};
  if (payload.reason !== undefined) {
    if (typeof payload.reason !== 'string') {
      return NextResponse.json(
        { message: '作废原因必须是字符串' },
        { status: 400 },
      );
    }
    const reason = payload.reason.trim();
    if (reason.length > 200) {
      return NextResponse.json(
        { message: '作废原因最多 200 字' },
        { status: 400 },
      );
    }
    if (reason !== '') {
      body.reason = reason;
    }
  }

  try {
    const result = await apiFetch(
      `/billing/invoices/${encodeURIComponent(number)}/void`,
      {
        method: 'POST',
        body,
        token: session.accessToken,
      },
    );
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
