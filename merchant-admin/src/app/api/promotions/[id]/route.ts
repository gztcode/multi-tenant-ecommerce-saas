import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import {
  readJson,
  toErrorResponse,
  unauthorizedResponse,
} from '@/lib/route-helpers';

/**
 * 单个满减活动的中转：PATCH 改活动（编辑 / 暂停 / 启用）、DELETE 删活动。
 *
 * ⚠️ **白名单纪律**：PATCH 的请求体**按白名单重建**，不整体透传。
 */

/** 金额字段必须是「非负整数分」 */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }
  const { id } = await params;

  const payload = (await readJson(request)) as Record<string, unknown>;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return NextResponse.json(
      { message: '请求体必须是 JSON 对象' },
      { status: 400 },
    );
  }

  const body: Record<string, unknown> = {};

  if (payload.name !== undefined) {
    if (typeof payload.name !== 'string' || payload.name.trim() === '') {
      return NextResponse.json(
        { message: '活动名称必须是非空字符串' },
        { status: 400 },
      );
    }
    body.name = payload.name.trim();
  }
  if (payload.description !== undefined) {
    if (typeof payload.description !== 'string') {
      return NextResponse.json(
        { message: '活动说明必须是字符串' },
        { status: 400 },
      );
    }
    body.description = payload.description;
  }
  if (payload.minAmount !== undefined) {
    if (!isNonNegativeInteger(payload.minAmount)) {
      return NextResponse.json(
        { message: '门槛必须是非负整数（单位：分）' },
        { status: 400 },
      );
    }
    body.minAmount = payload.minAmount;
  }
  if (payload.discountAmount !== undefined) {
    if (!isNonNegativeInteger(payload.discountAmount) || payload.discountAmount < 1) {
      return NextResponse.json(
        { message: '减免金额必须是不小于 1 的整数（单位：分）' },
        { status: 400 },
      );
    }
    body.discountAmount = payload.discountAmount;
  }
  if (payload.startsAt !== undefined) {
    if (typeof payload.startsAt !== 'string' || payload.startsAt === '') {
      return NextResponse.json(
        { message: '生效开始时间必须是非空字符串' },
        { status: 400 },
      );
    }
    body.startsAt = payload.startsAt;
  }
  if (payload.endsAt !== undefined) {
    if (typeof payload.endsAt !== 'string' || payload.endsAt === '') {
      return NextResponse.json(
        { message: '生效结束时间必须是非空字符串' },
        { status: 400 },
      );
    }
    body.endsAt = payload.endsAt;
  }
  if (payload.status !== undefined) {
    // ⚠️ **只允许 ACTIVE / PAUSED**：EXPIRED 是系统在过期时算出来的展示态。
    if (payload.status !== 'ACTIVE' && payload.status !== 'PAUSED') {
      return NextResponse.json(
        { message: '状态只能是 ACTIVE 或 PAUSED' },
        { status: 400 },
      );
    }
    body.status = payload.status;
  }

  try {
    const result = await apiFetch(`/merchant/promotions/${id}`, {
      method: 'PATCH',
      body,
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }
  const { id } = await params;

  try {
    // ⚠️ **删除走软删**（后端做的）：活动要保留历史订单里引用的可追溯性。
    await apiFetch(`/merchant/promotions/${id}`, {
      method: 'DELETE',
      token: session.accessToken,
    });
    // ⚠️ **后端删活动返回 204（无内容）**，所以这里不能
    // `NextResponse.json(result)`——result 是 undefined，构造 JSON 响应会抛异常，
    // 界面只会看到一句「后端服务不可用」，而删除其实已经成功了。
    // 与既有的 categories DELETE 路由同款。
    return new NextResponse(null, { status: 204 });
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
