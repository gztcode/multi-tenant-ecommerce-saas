import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { readJson, toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 退货入库的中转（阶段 11d）。
 *
 * 请求体按白名单重建：`orderId`（uuid）+ `items`（skuId/quantity）+ 可选 `reason`。
 * 后端做真正的闸：订单必须 REFUNDED、SKU 必须在订单里、
 * 入库量 ≤ 购买量 − 已入库量（RETURN 流水 SUM 校验）。
 *
 * ⚠️ **不接受库存字段**：库存数量由后端按入库明细计算并乐观锁写入，
 * 透传前端给的 stock 值是典型的越权面。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ orderNo: string }> },
) {
  await params; // 路由形参一致性：后端按 orderId 定位，orderNo 仅用于路由对齐

  const session = await auth();
  if (!session?.accessToken) {
    return unauthorizedResponse();
  }

  const parsed: unknown = await readJson(request);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return NextResponse.json({ message: '请求体必须是 JSON 对象' }, { status: 400 });
  }
  const payload = parsed as Record<string, unknown>;

  const orderId = payload.orderId;
  if (typeof orderId !== 'string' || orderId.trim() === '') {
    return NextResponse.json({ message: 'orderId 必须是非空字符串' }, { status: 400 });
  }

  const rawItems = payload.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return NextResponse.json({ message: 'items 必须是非空数组' }, { status: 400 });
  }
  const items: Array<{ skuId: string; quantity: number }> = [];
  for (const entry of rawItems) {
    if (typeof entry !== 'object' || entry === null) {
      return NextResponse.json({ message: 'items 元素必须是对象' }, { status: 400 });
    }
    const { skuId, quantity } = entry as Record<string, unknown>;
    if (typeof skuId !== 'string' || skuId.trim() === '') {
      return NextResponse.json({ message: 'skuId 必须是非空字符串' }, { status: 400 });
    }
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1) {
      return NextResponse.json({ message: 'quantity 必须是 ≥1 的整数' }, { status: 400 });
    }
    items.push({ skuId, quantity });
  }

  const body: Record<string, unknown> = {
    orderId: orderId.trim(),
    items,
  };
  if (typeof payload.reason === 'string' && payload.reason.trim() !== '') {
    body.reason = payload.reason.trim().slice(0, 200);
  }

  try {
    const result = await apiFetch('/inventory/returns', {
      method: 'POST',
      body,
      token: session.accessToken,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
