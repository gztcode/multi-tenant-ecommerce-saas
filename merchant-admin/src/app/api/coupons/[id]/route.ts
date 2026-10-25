import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import {
  readJson,
  toErrorResponse,
  unauthorizedResponse,
} from '@/lib/route-helpers';

/**
 * 单张券的中转：PATCH 改券（编辑 / 暂停 / 启用）、DELETE 删券（软删）。
 *
 * ⚠️ **白名单纪律**：PATCH 的请求体**按白名单重建**，不整体透传。
 * `scope` 依然不在白名单里（护栏 M7）——作用域是创建时定下的身份属性，
 * 改了就等于「先发店铺券，再改成平台券」，那正是 M7 要堵的越权路径。
 *
 * ⚠️ **计数（claimedCount / reservedCount / usedCount）不放行**：
 * 那是服务端的账，客户端传了就是伪造额度。
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

  // 白名单重建：空 body 也放行（改状态时可能只带 status）
  const body: Record<string, unknown> = {};

  if (payload.code !== undefined) {
    if (typeof payload.code !== 'string' || payload.code.trim() === '') {
      return NextResponse.json(
        { message: '券码必须是非空字符串' },
        { status: 400 },
      );
    }
    body.code = payload.code.trim();
  }
  if (payload.name !== undefined) {
    if (typeof payload.name !== 'string' || payload.name.trim() === '') {
      return NextResponse.json(
        { message: '券名称必须是非空字符串' },
        { status: 400 },
      );
    }
    body.name = payload.name.trim();
  }
  if (payload.description !== undefined) {
    if (typeof payload.description !== 'string') {
      return NextResponse.json(
        { message: '券说明必须是字符串' },
        { status: 400 },
      );
    }
    body.description = payload.description;
  }
  if (payload.value !== undefined) {
    if (!isNonNegativeInteger(payload.value) || payload.value < 1) {
      return NextResponse.json(
        { message: '面额必须是不小于 1 的整数（单位：分）' },
        { status: 400 },
      );
    }
    body.value = payload.value;
  }
  if (payload.minAmount !== undefined) {
    if (!isNonNegativeInteger(payload.minAmount)) {
      return NextResponse.json(
        { message: '使用门槛必须是非负整数（单位：分）' },
        { status: 400 },
      );
    }
    body.minAmount = payload.minAmount;
  }
  if (payload.perUserLimit !== undefined) {
    if (
      payload.perUserLimit !== null &&
      (!isNonNegativeInteger(payload.perUserLimit) || payload.perUserLimit < 1)
    ) {
      return NextResponse.json(
        { message: '每用户限领张数必须是大于等于 1 的整数' },
        { status: 400 },
      );
    }
    body.perUserLimit = payload.perUserLimit;
  }
  if (payload.totalLimit !== undefined) {
    if (
      payload.totalLimit !== null &&
      (!isNonNegativeInteger(payload.totalLimit) || payload.totalLimit < 1)
    ) {
      return NextResponse.json(
        { message: '总发放上限必须是大于等于 1 的整数' },
        { status: 400 },
      );
    }
    body.totalLimit = payload.totalLimit;
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
    // ⚠️ **只允许 ACTIVE / PAUSED**：EXPIRED 是系统在过期时算出来的展示态，
    // 本阶段的过期判定靠 endsAt 不靠 status，客户端设了也没意义。
    if (payload.status !== 'ACTIVE' && payload.status !== 'PAUSED') {
      return NextResponse.json(
        { message: '状态只能是 ACTIVE 或 PAUSED' },
        { status: 400 },
      );
    }
    body.status = payload.status;
  }

  try {
    const result = await apiFetch(`/merchant/coupons/${id}`, {
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
    // ⚠️ **删除走软删**（后端做的）：券要保留历史核销记录的可追溯性，
    // 所以不物理删除，只打上删除标记。
    await apiFetch(`/merchant/coupons/${id}`, {
      method: 'DELETE',
      token: session.accessToken,
    });
    // ⚠️ **后端删券返回 204（无内容）**，所以这里不能 `NextResponse.json(result)`
    // ——result 是 undefined，构造 JSON 响应会抛异常，界面只会看到
    // 一句没头没尾的「后端服务不可用」，而删除其实已经成功了。
    // 与既有的 categories DELETE 路由同款。
    return new NextResponse(null, { status: 204 });
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
