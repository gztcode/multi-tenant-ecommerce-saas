import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import {
  readJson,
  toErrorResponse,
  unauthorizedResponse,
} from '@/lib/route-helpers';

/**
 * 支付方式的中转：GET 列出本店的支付方式、POST 绑定一个。
 *
 * ⚠️ **白名单纪律**：请求体**只接受 `type` 与 `channel`**，其余一律丢弃。
 *
 * ⚠️ **不接受 `token`**：token 必须由渠道给。客户端传 token 的话，
 * 商家就能绑一张「不属于自己的」卡，自动续费时扣的是别人的钱。
 *
 * ⚠️ **响应里也没有 token**（后端用 `select` 显式挑字段）——
 * 那是渠道给的扣款凭证，只能在服务端用。
 */

/** 支付方式的类型；与后端 DTO 的枚举保持一致 */
const PAYMENT_METHOD_TYPES = ['CARD', 'WECHAT', 'ALIPAY'];

export async function GET() {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }

  try {
    const result = await apiFetch('/billing/payment-methods', {
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

  const payload = (await readJson(request)) as Record<string, unknown>;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return NextResponse.json(
      { message: '请求体必须是 JSON 对象' },
      { status: 400 },
    );
  }

  const type = payload.type;
  if (typeof type !== 'string' || !PAYMENT_METHOD_TYPES.includes(type)) {
    return NextResponse.json(
      { message: '支付方式类型只能是 CARD、WECHAT 或 ALIPAY' },
      { status: 400 },
    );
  }

  const channel = payload.channel;
  if (typeof channel !== 'string' || channel.trim() === '') {
    return NextResponse.json(
      { message: '请选择支付渠道' },
      { status: 400 },
    );
  }

  // 白名单重建：body 里就这两个键，多一个都没有
  const body = { type, channel: channel.trim() };

  try {
    const result = await apiFetch('/billing/payment-methods', {
      method: 'POST',
      body,
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
