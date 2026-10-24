import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { readJson, toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 商品列表（GET）与创建（POST）的中转。
 *
 * 为什么必须中转：后端没开 CORS，客户端直连会被预检拦掉（Failed to fetch），
 * 而且 accessToken 不该进客户端、NextAuth 的 auth() 只能在服务端请求作用域调。
 * 详见 app/api/stores/me/route.ts 顶部的说明。
 *
 * 租户身份由 accessToken 里的 tenantId 决定，这里不带 X-Tenant-Subdomain——
 * 商家后台跑在中心域名 merchant.platform.test 上，没有「当前店铺」这回事。
 */

/** 后端商品列表支持的查询参数（见 ProductsController.list 的 @ApiQuery） */
const LIST_QUERY_KEYS = ['page', 'pageSize', 'keyword', 'categoryId', 'status'] as const;

/**
 * 查询串按白名单重建，而不是原样透传。
 *
 * 后端的 DTO 校验只管 body，@Query 参数没有 forbidNonWhitelisted，
 * 透传未知 query 不会被拒；但透传进来的东西一律丢掉可以让「这个页面到底支持
 * 哪些筛选」只有这一处定义，页面上拼错了也不会悄悄生效。
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }

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
    const result = await apiFetch(`/catalog/products${suffix ? `?${suffix}` : ''}`, {
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}

/**
 * 创建商品。
 *
 * 请求体按白名单重建，不整体透传：后端的 ValidationPipe 开了
 * forbidNonWhitelisted，客户端多传一个字段（minPrice / version / tenantId …）
 * 就会 400，而那种 400 在界面上只会显示一句没头没尾的校验失败。
 * 这里显式挡掉，也顺手把明显不合法的输入挡在本地，省一次往返。
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }

  const parsed: unknown = await readJson(request);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return NextResponse.json({ message: '请求体必须是 JSON 对象' }, { status: 400 });
  }
  const body = parsed as Record<string, unknown>;

  const name = body.name;
  if (typeof name !== 'string' || name.trim() === '') {
    return NextResponse.json({ message: 'name 必须是非空字符串' }, { status: 400 });
  }
  const slug = body.slug;
  if (
    typeof slug !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug.trim())
  ) {
    return NextResponse.json(
      { message: 'slug 只能包含小写字母、数字与连字符' },
      { status: 400 },
    );
  }

  const sanitized: Record<string, unknown> = { name: name.trim(), slug: slug.trim() };

  // 副标题、详情、描述性属性都是可选的，透传前逐个确认类型。
  if (body.subtitle !== undefined) {
    if (typeof body.subtitle !== 'string') {
      return NextResponse.json({ message: 'subtitle 必须是字符串' }, { status: 400 });
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

  try {
    const result = await apiFetch('/catalog/products', {
      method: 'POST',
      body: sanitized,
      token: session.accessToken,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (cause) {
    return toErrorResponse(cause);
  }
}

