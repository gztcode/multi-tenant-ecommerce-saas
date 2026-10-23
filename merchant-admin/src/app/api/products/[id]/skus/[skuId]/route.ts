import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { readJson, toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 单个 SKU 的更新（PATCH）。
 *
 * 后续的 SKU 价格表（components/product/sku-price-table.tsx）走这个中转。
 *
 * 注意 URL 里的 [id] 是**商品 id**（对应后端的 productId），不是 skuId——
 * 后端的 findFirst 带 productId 条件，跨商品的 skuId 会落到 404，
 * 所以商品 id 不是冗余的，不能省。
 */

/** 后端 UpdateSkuDto 认识的 SKU 状态值 */
const SKU_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

/**
 * 更新单个 SKU 的价格、划线价、编码与启用状态。
 *
 * ⚠️ **不接受 stock**：库存只能通过库存调整接口改（设计文档 §四.8），
 * 多传一个 stock 会被后端的 forbidNonWhitelisted 挡成 400。
 * 中转这里显式只放行这四个字段，顺带把「误以为这里能改库存」的调用挡在门外。
 *
 * 与商品更新不同，SKU 更新**没有 version**：后端 UpdateSkuDto 里没有这个字段，
 * 也不做乐观锁——改价是高频操作，冲突了就后写覆盖，代价是可控的
 * （而商品标题被静默覆盖的代价大得多，所以那边有 version）。
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; skuId: string }> },
) {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }
  const { id, skuId } = await params;

  // 客户端发来的请求体不受信任：先确认是个普通对象，再显式白名单字段。
  // 数组、字符串、null 都在这里被挡掉。
  const parsed: unknown = await readJson(request);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return NextResponse.json({ message: '请求体必须是 JSON 对象' }, { status: 400 });
  }
  const body = parsed as Record<string, unknown>;

  const sanitized: Record<string, unknown> = {};

  // 价格单位是分（整数）。这里先挡负数与小数：后端也有 @IsInt @Min(0)，
  // 但那一条 400 在界面上只会显示一句没头没尾的校验失败。
  for (const key of ['price', 'comparePrice'] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      return NextResponse.json(
        { message: `${key} 必须是 ≥ 0 的整数（单位：分）` },
        { status: 400 },
      );
    }
    sanitized[key] = value;
  }

  if (body.code !== undefined) {
    if (typeof body.code !== 'string') {
      return NextResponse.json({ message: 'code 必须是字符串' }, { status: 400 });
    }
    // 后端 MaxLength(64)；空串是合法的（表示「没有商家编码」），
    // 所以这里只查长度，不查非空。
    if (body.code.length > 64) {
      return NextResponse.json({ message: 'code 最多 64 个字符' }, { status: 400 });
    }
    sanitized.code = body.code;
  }

  if (body.status !== undefined) {
    if (
      typeof body.status !== 'string' ||
      !(SKU_STATUSES as readonly string[]).includes(body.status)
    ) {
      return NextResponse.json(
        { message: `status 只能是 ${SKU_STATUSES.join(' / ')}` },
        { status: 400 },
      );
    }
    sanitized.status = body.status;
  }

  try {
    const result = await apiFetch(`/catalog/products/${id}/skus/${skuId}`, {
      method: 'PATCH',
      body: sanitized,
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}