import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { readJson, toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 单个商品的中转：详情（GET）、更新（PATCH）、软删除（DELETE）。
 *
 * 为什么必须中转：后端没开 CORS，客户端直连会被预检拦掉（Failed to fetch），
 * 而且 accessToken 不该进客户端、NextAuth 的 auth() 只能在服务端请求作用域调。
 * 详见 app/api/stores/me/route.ts 顶部的说明。
 *
 * 租户身份由 accessToken 里的 tenantId 决定，这里不带 X-Tenant-Subdomain——
 * 商家后台跑在中心域名 merchant.platform.test 上，没有「当前店铺」这回事。
 *
 * ⚠️ 路由优先级：Next.js 里静态段 batch 优先于动态段 [id]，所以
 * /api/products/batch 命中的是 api/products/batch/route.ts，不会被这里拦走。
 */

/** 商品详情（含规格、SKU、媒体）。这里只做转发，不裁字段 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }
  const { id } = await params;

  try {
    const result = await apiFetch(`/catalog/products/${id}`, {
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}

/** 后端 UpdateProductDto 认识的状态值 */
const PRODUCT_STATUSES = ['DRAFT', 'PUBLISHED', 'UNPUBLISHED'] as const;

/**
 * 更新商品基本信息。
 *
 * 请求体按白名单重建，不整体透传：后端 ValidationPipe 开了 forbidNonWhitelisted，
 * 客户端多传一个字段（slug / minPrice / id / tenantId …）就会 400，
 * 而那种 400 在界面上只会显示一句没头没尾的校验失败。
 *
 * ⚠️ **不能提交 slug**：后端 UpdateProductDto 根本没有这个字段（改了旧链接失效，
 * 阶段 2 不做重定向），透传过去必然 400。
 * ⚠️ **不能提交 minPrice**：派生字段，由 SKU 价格推导。
 *
 * version 是乐观锁：传了才校验，不匹配返回 409「商品已被他人修改，请刷新后重试」。
 * 这里**强制要求传 version**——不传的话后端会跳过校验，并发编辑会静默覆盖，
 * 界面上就会出现「A 改的标题被 B 静默改回」的灵异现象。
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }
  const { id } = await params;

  // 客户端发来的请求体不受信任：先确认是个普通对象，再显式白名单字段，
  // 而不是整个透传给后端。数组、字符串、null 都在这里被挡掉。
  const parsed: unknown = await readJson(request);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return NextResponse.json({ message: '请求体必须是 JSON 对象' }, { status: 400 });
  }
  const body = parsed as Record<string, unknown>;

  // 先扣掉 version：它是并发控制参数，不属于要更新的字段，
  // 但必须在下面构造 sanitized 之前确认它合法，否则会被当成未知字段。
  const version = body.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return NextResponse.json(
      { message: 'version 必须是 ≥ 1 的整数（乐观锁必传）' },
      { status: 400 },
    );
  }
  const sanitized: Record<string, unknown> = { version };

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      return NextResponse.json({ message: 'name 必须是非空字符串' }, { status: 400 });
    }
    // 后端 MaxLength(120)：留出余量，别让用户填满 120 字才被后端拒绝。
    if (body.name.trim().length > 120) {
      return NextResponse.json({ message: 'name 最多 120 个字符' }, { status: 400 });
    }
    sanitized.name = body.name.trim();
  }
  if (body.subtitle !== undefined) {
    if (typeof body.subtitle !== 'string') {
      return NextResponse.json({ message: 'subtitle 必须是字符串' }, { status: 400 });
    }
    if (body.subtitle.length > 200) {
      return NextResponse.json({ message: 'subtitle 最多 200 个字符' }, { status: 400 });
    }
    sanitized.subtitle = body.subtitle;
  }
  if (body.description !== undefined) {
    if (typeof body.description !== 'string') {
      return NextResponse.json({ message: 'description 必须是字符串' }, { status: 400 });
    }
    sanitized.description = body.description;
  }
  if (body.categoryId !== undefined) {
    // 后端允许显式传 null 表示「挂到根」，所以这里 null 是合法值。
    if (body.categoryId !== null && typeof body.categoryId !== 'string') {
      return NextResponse.json(
        { message: 'categoryId 必须是字符串或 null' },
        { status: 400 },
      );
    }
    sanitized.categoryId = body.categoryId;
  }
  if (body.attributes !== undefined) {
    const attributes = body.attributes;
    if (
      typeof attributes !== 'object' ||
      attributes === null ||
      Array.isArray(attributes)
    ) {
      return NextResponse.json({ message: 'attributes 必须是对象' }, { status: 400 });
    }
    if (Object.values(attributes).some((v) => typeof v !== 'string')) {
      return NextResponse.json(
        { message: 'attributes 的值必须都是字符串' },
        { status: 400 },
      );
    }
    sanitized.attributes = attributes;
  }
  if (body.status !== undefined) {
    if (
      typeof body.status !== 'string' ||
      !(PRODUCT_STATUSES as readonly string[]).includes(body.status)
    ) {
      return NextResponse.json(
        { message: `status 只能是 ${PRODUCT_STATUSES.join(' / ')}` },
        { status: 400 },
      );
    }
    sanitized.status = body.status;
  }

  try {
    const result = await apiFetch(`/catalog/products/${id}`, {
      method: 'PATCH',
      body: sanitized,
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    // 后端的 409（并发冲突）与 409（slug 占用）文案都是已脱敏的业务提示，
    // toErrorResponse 原样透传给编辑页展示。
    return toErrorResponse(cause);
  }
}

/** 软删除商品（后端写 deletedAt，公开页面立刻不再展示） */
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
    await apiFetch(`/catalog/products/${id}`, {
      method: 'DELETE',
      token: session.accessToken,
    });
    return new NextResponse(null, { status: 204 });
  } catch (cause) {
    return toErrorResponse(cause);
  }
}