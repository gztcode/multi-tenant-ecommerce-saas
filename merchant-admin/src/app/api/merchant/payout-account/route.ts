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
 *
 * ⚠️ **长度上限 40 与后端 DTO 的 `@MaxLength(40)` 逐字对齐**。
 */

const MAX_CHANNEL_LENGTH = 40;

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

  // ⚠️ **`preferredChannel` 三态**（阶段 6a Task 5）：
  //    键不存在 = 不修改；空串 = 清除（使用平台默认）；有值 = 设置。
  //    ⚠️ **非字符串一律 400，不静默丢弃**：把它当「不修改」会让商家
  //    以为自己改成功了，下次出款才发现还走着旧渠道。
  const rawPreferredChannel = payload.preferredChannel;
  if (
    rawPreferredChannel !== undefined &&
    typeof rawPreferredChannel !== 'string'
  ) {
    return NextResponse.json(
      { message: '默认出款渠道必须是字符串' },
      { status: 400 },
    );
  }
  const preferredChannel =
    typeof rawPreferredChannel === 'string'
      ? rawPreferredChannel.trim()
      : undefined;
  if (preferredChannel !== undefined && preferredChannel.length > MAX_CHANNEL_LENGTH) {
    return NextResponse.json(
      { message: `默认出款渠道不能超过 ${MAX_CHANNEL_LENGTH} 个字符` },
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
        // ⚠️ **没传这个键就不往后传**（不修改）；空串要**保留**为 `''`
        //    —— 那是「清除配置（改用平台默认）」的合法语义，不是缺省值。
        ...(preferredChannel !== undefined ? { preferredChannel } : {}),
      },
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
