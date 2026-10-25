import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import {
  readJson,
  toErrorResponse,
  unauthorizedResponse,
} from '@/lib/route-helpers';

/**
 * 满减活动的中转：GET 活动列表、POST 创建活动。
 *
 * ⚠️ **商家侧的路径带 `merchant/` 前缀**——写成 `/promotions` 会打到
 * 消费者侧的路由上。
 *
 * ⚠️ **白名单纪律**：请求体**按白名单重建**，不整体透传。
 * `status` 不在创建的白名单里——新活动一律 ACTIVE，要暂停用 PATCH。
 */

/** 金额字段必须是「非负整数分」 */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export async function GET() {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }

  try {
    const result = await apiFetch('/merchant/promotions', {
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

  const name = payload.name;
  if (typeof name !== 'string' || name.trim() === '') {
    return NextResponse.json(
      { message: '活动名称必须是非空字符串' },
      { status: 400 },
    );
  }
  const minAmount = payload.minAmount;
  if (!isNonNegativeInteger(minAmount)) {
    return NextResponse.json(
      { message: '门槛必须是非负整数（单位：分）' },
      { status: 400 },
    );
  }
  const discountAmount = payload.discountAmount;
  if (!isNonNegativeInteger(discountAmount) || discountAmount < 1) {
    return NextResponse.json(
      { message: '减免金额必须是不小于 1 的整数（单位：分）' },
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
    name: name.trim(),
    minAmount,
    discountAmount,
    startsAt,
    endsAt,
  };
  if (typeof payload.description === 'string') {
    body.description = payload.description;
  }

  try {
    const result = await apiFetch('/merchant/promotions', {
      method: 'POST',
      body,
      token: session.accessToken,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
