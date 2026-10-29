import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import {
  readJson,
  toErrorResponse,
  unauthorizedResponse,
} from '@/lib/route-helpers';

/**
 * 商家收款账户的中转。
 *
 * ⚠️ **请求体按白名单重建**：客户端发来的 `tenantId`、`maskedAccountNo`
 * 之类的一律不往后传 —— 账号只认「开户人 / 开户行 / 账号」三个字段。
 * （后端 ValidationPipe 开了 forbidNonWhitelisted，整体透传多传一个字段
 * 就是 400；更根本的是后端 DTO 哪天加个字段，它就会静默变成客户端可写。）
 */
export async function GET() {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }

  try {
    const result = await apiFetch('/merchant/payout-account', {
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}

export async function PUT(request: Request) {
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

  const accountName =
    typeof payload.accountName === 'string' ? payload.accountName.trim() : '';
  const bankName =
    typeof payload.bankName === 'string' ? payload.bankName.trim() : '';
  const accountNo =
    typeof payload.accountNo === 'string' ? payload.accountNo.trim() : '';

  if (!accountName || !bankName) {
    return NextResponse.json(
      { message: '开户人、开户行都要填' },
      { status: 400 },
    );
  }

  try {
    const result = await apiFetch('/merchant/payout-account', {
      method: 'PUT',
      // ⚠️ **账号为空时不传这个键**（不是传空串）：
      //    后端只回脱敏值，商家改开户人姓名时手里没有原账号 ——
      //    留空表示「不修改这一项」。传空串会被当成「把账号清成空」。
      body: {
        accountName,
        bankName,
        ...(accountNo ? { accountNo } : {}),
      },
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
