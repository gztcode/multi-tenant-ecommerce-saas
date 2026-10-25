import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import {
  readJson,
  toErrorResponse,
  unauthorizedResponse,
} from '@/lib/route-helpers';

/**
 * 优惠券的中转：GET 券列表、POST 创建券。
 *
 * ⚠️ **商家侧的路径带 `merchant/` 前缀**——写成 `/coupons` 会打到消费者侧的
 * 路由上（那套要消费者登录，鉴权方式根本不同）。
 *
 * ⚠️ **白名单纪律**：请求体**按白名单重建**，不整体透传。
 * 整体透传等于把「哪些字段可以写」的判断交给后端的 forbidNonWhitelisted——
 * 后端 DTO 哪天加了个字段，它就会静默变成客户端可写。
 *
 * ⚠️ **`scope` 不由客户端传**（护栏 M7）：平台券只能由平台超管创建，
 * 作用域是创建时按登录身份在**服务端**推导的。
 * `claimedCount` / `reservedCount` / `usedCount` 是服务端的账，
 * 客户端传了就是伪造额度。`type` 本阶段固定 FIXED，也不放行。
 */

/** 金额字段必须是「非负整数分」——浮点金额从这里就断掉源头 */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export async function GET() {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }

  try {
    const result = await apiFetch('/merchant/coupons', {
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

  const code = payload.code;
  if (typeof code !== 'string' || code.trim() === '') {
    return NextResponse.json(
      { message: '券码必须是非空字符串' },
      { status: 400 },
    );
  }
  const name = payload.name;
  if (typeof name !== 'string' || name.trim() === '') {
    return NextResponse.json(
      { message: '券名称必须是非空字符串' },
      { status: 400 },
    );
  }

  // ⚠️ **面额至少 1 分**：0 元面额的券没有意义，后端 DTO 也是 `@Min(1)`。
  const value = payload.value;
  if (!isNonNegativeInteger(value) || value < 1) {
    return NextResponse.json(
      { message: '面额必须是不小于 1 的整数（单位：分）' },
      { status: 400 },
    );
  }
  const minAmount = payload.minAmount;
  if (!isNonNegativeInteger(minAmount)) {
    return NextResponse.json(
      { message: '使用门槛必须是非负整数（单位：分）' },
      { status: 400 },
    );
  }

  const startsAt = payload.startsAt;
  const endsAt = payload.endsAt;
  if (typeof startsAt !== 'string' || startsAt === '') {
    return NextResponse.json(
      { message: '生效开始时间必须是非空字符串' },
      { status: 400 },
    );
  }
  if (typeof endsAt !== 'string' || endsAt === '') {
    return NextResponse.json(
      { message: '生效结束时间必须是非空字符串' },
      { status: 400 },
    );
  }

  // 白名单重建：只保留这几个键，其余全部丢弃
  const body: Record<string, unknown> = {
    code: code.trim(),
    name: name.trim(),
    value,
    minAmount,
    startsAt,
    endsAt,
  };

  if (typeof payload.description === 'string') {
    body.description = payload.description;
  }
  if (payload.perUserLimit !== undefined) {
    if (!isNonNegativeInteger(payload.perUserLimit) || payload.perUserLimit < 1) {
      return NextResponse.json(
        { message: '每用户限领张数必须是大于等于 1 的整数' },
        { status: 400 },
      );
    }
    body.perUserLimit = payload.perUserLimit;
  }
  if (payload.totalLimit !== undefined) {
    if (!isNonNegativeInteger(payload.totalLimit) || payload.totalLimit < 1) {
      return NextResponse.json(
        { message: '总发放上限必须是大于等于 1 的整数' },
        { status: 400 },
      );
    }
    body.totalLimit = payload.totalLimit;
  }

  try {
    const result = await apiFetch('/merchant/coupons', {
      method: 'POST',
      body,
      token: session.accessToken,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
