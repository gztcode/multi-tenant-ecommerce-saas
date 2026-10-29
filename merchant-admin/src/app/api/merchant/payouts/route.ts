import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import {
  readJson,
  toErrorResponse,
  unauthorizedResponse,
} from '@/lib/route-helpers';

/**
 * 商家出款单的中转（列表 GET / 申请 POST）。
 *
 * ⚠️ **请求体按白名单重建**：客户端发来的 `amount`、`netAmount`
 * 之类的一律不往后传 —— 应结金额**全部由后端算**（护栏 P4）。
 * 客户端能传金额的话，改一行前端就能改平台打给商家多少钱。
 * （后端 ValidationPipe 开了 forbidNonWhitelisted，整体透传多传一个字段
 * 就是 400；更根本的是后端 DTO 哪天加个字段，它就会静默变成客户端可写。）
 */
export async function GET() {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }

  try {
    const result = await apiFetch('/merchant/payouts', {
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }

  const parsed: unknown = await readJson(request);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return NextResponse.json(
      { message: '请求体必须是 JSON 对象' },
      { status: 400 },
    );
  }
  const payload = parsed as Record<string, unknown>;

  const period = typeof payload.period === 'string' ? payload.period.trim() : '';

  if (!period) {
    return NextResponse.json({ message: '请选择结算周期' }, { status: 400 });
  }

  try {
    const result = await apiFetch('/merchant/payouts', {
      method: 'POST',
      // ⚠️ **body 里只有 `period` 一个键**：金额是后端算的，
      //    客户端多传什么都不该到后端。
      body: { period },
      token: session.accessToken,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
