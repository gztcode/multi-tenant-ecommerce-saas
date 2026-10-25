import { NextResponse } from 'next/server';
import { readJson, toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';
import { currentSubdomain, currentToken, fetchBackend } from '@/lib/server-cart';
import type { Order, OrderListResponse } from '@/lib/cart';

/**
 * 订单的中转：GET 我的订单列表、POST 下单。
 *
 * 必须登录——后端整组挂 JwtAuthGuard（订单是「我的订单」这类归属自己的资源，
 * 订单号不是秘密：它出现在支付回调、商家后台的搜索框里）。
 */

/** 订单列表支持的查询参数 */
const LIST_QUERY_KEYS = ['status', 'page', 'pageSize'] as const;

export async function GET(request: Request) {
  const token = await currentToken();
  if (!token) {
    return unauthorizedResponse();
  }
  const subdomain = await currentSubdomain();

  // 查询串按白名单重建，不整体透传
  const incoming = new URL(request.url).searchParams;
  const params = new URLSearchParams();
  for (const key of LIST_QUERY_KEYS) {
    const value = incoming.get(key);
    if (value !== null && value !== '') {
      params.set(key, value);
    }
  }
  const suffix = params.toString();

  try {
    const result = await fetchBackend<OrderListResponse>(
      `/orders${suffix ? `?${suffix}` : ''}`,
      { subdomain, token },
    );
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}

/**
 * 下单。
 *
 * 请求体按白名单重建：`addressId`、`items`（skuId + quantity）、
 * `idempotencyKey`、可选 `remark`、可选 `couponId`。
 *
 * ⚠️ **绝不接受价格字段**——后端 ValidationPipe 开了 forbidNonWhitelisted，
 * 传了 price / unitPrice / totalAmount 都会 400；而更根本的是，
 * 金额只能由后端从 SKU 读（护栏 8：客户端传的价格一律不信）。
 *
 * ⚠️ **同样不接受任何优惠金额字段**（`discountAmount` / `couponValue` /
 * `couponMinAmount` / `promotionDiscountAmount`）：
 * 优惠金额只由服务端算出来。客户端只能传 `couponId`，
 * 面额与门槛一律从库里读（护栏 M1 / M2）。
 */
export async function POST(request: Request) {
  const token = await currentToken();
  if (!token) {
    return unauthorizedResponse();
  }
  const subdomain = await currentSubdomain();

  const parsed: unknown = await readJson(request);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return NextResponse.json({ message: '请求体必须是 JSON 对象' }, { status: 400 });
  }
  const body = parsed as Record<string, unknown>;

  const addressId = body.addressId;
  if (typeof addressId !== 'string' || addressId === '') {
    return NextResponse.json(
      { message: 'addressId 必须是非空字符串' },
      { status: 400 },
    );
  }

  const rawItems = body.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return NextResponse.json(
      { message: 'items 必须是非空数组' },
      { status: 400 },
    );
  }

  const items: Array<{ skuId: string; quantity: number }> = [];
  for (const raw of rawItems) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return NextResponse.json({ message: 'items 的每一项都必须是对象' }, { status: 400 });
    }
    const entry = raw as Record<string, unknown>;
    const skuId = entry.skuId;
    const quantity = entry.quantity;
    if (typeof skuId !== 'string' || skuId === '') {
      return NextResponse.json(
        { message: 'items 的 skuId 必须是非空字符串' },
        { status: 400 },
      );
    }
    if (
      typeof quantity !== 'number' ||
      !Number.isInteger(quantity) ||
      quantity < 1
    ) {
      return NextResponse.json(
        { message: 'items 的 quantity 必须是大于等于 1 的整数' },
        { status: 400 },
      );
    }
    items.push({ skuId, quantity });
  }

  const payload: Record<string, unknown> = { addressId, items };

  const idempotencyKey = body.idempotencyKey;
  if (idempotencyKey !== undefined) {
    if (typeof idempotencyKey !== 'string' || idempotencyKey === '') {
      return NextResponse.json(
        { message: 'idempotencyKey 必须是非空字符串' },
        { status: 400 },
      );
    }
    payload.idempotencyKey = idempotencyKey;
  }

  const remark = body.remark;
  if (remark !== undefined) {
    if (typeof remark !== 'string') {
      return NextResponse.json({ message: 'remark 必须是字符串' }, { status: 400 });
    }
    payload.remark = remark;
  }

  // ⚠️ **couponId 必须放进白名单**（护栏 M2）：
  // 结算页选了券，请求发到中转路由后 couponId 被**静默丢掉**的话，
  // 后端收不到券 → 用户选了券却完全不生效，而且没有任何报错。
  // 只传 id：面额与门槛一律由后端从库里读，绝不接受客户端算的减免额。
  const couponId = body.couponId;
  if (couponId !== undefined) {
    if (typeof couponId !== 'string' || couponId === '') {
      return NextResponse.json(
        { message: 'couponId 必须是非空字符串' },
        { status: 400 },
      );
    }
    payload.couponId = couponId;
  }

  try {
    const result = await fetchBackend<Order>('/orders', {
      method: 'POST',
      body: payload,
      subdomain,
      token,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
