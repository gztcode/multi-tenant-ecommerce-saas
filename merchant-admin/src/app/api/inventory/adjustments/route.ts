import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { readJson, toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 库存调整的中转。
 *
 * 调整会同时改库存并写一条流水（后端在同一个事务里做），因此后端的业务提示
 * （如「库存不足：当前 3，要出库 10」）原样透传给 InventoryPanel 展示。
 *
 * 租户身份由 accessToken 里的 tenantId 决定，不带 X-Tenant-Subdomain。
 */
const ADJUSTMENT_TYPES = ['ADJUST_IN', 'ADJUST_OUT', 'CHECK'] as const;

export async function POST(request: Request) {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }

  const payload = (await readJson(request)) as {
    skuId?: unknown;
    type?: unknown;
    quantity?: unknown;
    reason?: unknown;
  };

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return NextResponse.json(
      { message: '请求体必须是 JSON 对象' },
      { status: 400 },
    );
  }

  // 白名单重建。quantity 的语义随 type 变（ADJUST_OUT 是减少量、
  // CHECK 是盘点后的绝对值），这里只做形状与类型枚举校验——
  // 语义规则由后端的 AdjustStockDto 与 InventoryService 负责。
  const type = ADJUSTMENT_TYPES.find((t) => t === payload.type);
  if (!type) {
    return NextResponse.json(
      { message: `type 必须是 ${ADJUSTMENT_TYPES.join('、')}` },
      { status: 400 },
    );
  }

  const body: Record<string, unknown> = { type };
  if (typeof payload.skuId === 'string') body.skuId = payload.skuId;
  if (
    typeof payload.quantity === 'number' &&
    Number.isFinite(payload.quantity)
  ) {
    body.quantity = payload.quantity;
  }
  if (typeof payload.reason === 'string') body.reason = payload.reason;

  try {
    const result = await apiFetch('/inventory/adjustments', {
      method: 'POST',
      body,
      token: session.accessToken,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (cause) {
    return toErrorResponse(cause);
  }
}