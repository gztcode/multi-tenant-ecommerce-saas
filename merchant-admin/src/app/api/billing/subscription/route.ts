import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import {
  readJson,
  toErrorResponse,
  unauthorizedResponse,
} from '@/lib/route-helpers';

/**
 * 当前订阅的中转：GET 看当前订阅、POST 开通、PATCH 换套餐。
 *
 * ⚠️ **白名单纪律**：请求体**只接受 `planId`**，其余一律丢弃。
 * 价格、周期、抽佣率、额度、功能开关全部从库里读——
 * 客户端传了就是「自己给自己打折」，那正是护栏 M1 / M2 / M9 要堵的路。
 */
export async function GET() {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }

  try {
    const result = await apiFetch('/billing/subscription', {
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

  const planId = payload.planId;
  if (typeof planId !== 'string' || planId.trim() === '') {
    return NextResponse.json(
      { message: '请选择要开通的套餐' },
      { status: 400 },
    );
  }

  // 白名单重建：body 里就一个键，多一个都没有
  const body = { planId: planId.trim() };

  try {
    const result = await apiFetch('/billing/subscription', {
      method: 'POST',
      body,
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}

/**
 * 换套餐的中转。
 *
 * ⚠️ **与 POST 用同一套白名单**（只收 `planId`）：换套餐同样是「客户端
 * 只能指定要哪个套餐」，价格与额度仍然从库里读。
 *
 * ⚠️ **语义是「下个周期生效」**：后端写的是 `pendingPlanId`，
 * 当前套餐不变。
 */
export async function PATCH(request: Request) {
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

  const planId = payload.planId;
  if (typeof planId !== 'string' || planId.trim() === '') {
    return NextResponse.json(
      { message: '请选择要切换的套餐' },
      { status: 400 },
    );
  }

  const body = { planId: planId.trim() };

  try {
    const result = await apiFetch('/billing/subscription', {
      method: 'PATCH',
      body,
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
