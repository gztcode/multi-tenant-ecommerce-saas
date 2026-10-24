import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { readJson, toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 品类树查询与创建的中转。
 *
 * 为什么必须中转：后端没开 CORS，客户端直连会被预检拦掉（Failed to fetch），
 * 而且 accessToken 不该进客户端、NextAuth 的 auth() 只能在服务端请求作用域调。
 * 详见 app/api/stores/me/route.ts 顶部的说明。
 *
 * 租户身份由 accessToken 里的 tenantId 决定，这里不带 X-Tenant-Subdomain——
 * 商家后台跑在中心域名 merchant.platform.test 上，没有「当前店铺」这回事。
 */

/**
 * ⚠️ 白名单纪律：所有中转路由都必须**白名单重建**请求体，
 * 不能 `body = await readJson(request)` 之后整体透传。
 *
 * 整体透传等于把「哪些字段可以写」的判断交给后端的 forbidNonWhitelisted——
 * 后端 DTO 哪天加了个字段（哪怕只是内部用的），它就会静默变成客户端可写。
 * 本项目曾经有两条路由（categories 的 POST、inventory adjustments 的 POST）
 * 是整体透传的，安全审查时被抓出来补上。
 */
export async function GET() {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }

  try {
    const result = await apiFetch('/catalog/categories', {
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

  const payload = (await readJson(request)) as {
    name?: unknown;
    slug?: unknown;
    parentId?: unknown;
    sort?: unknown;
  };

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return NextResponse.json(
      { message: '请求体必须是 JSON 对象' },
      { status: 400 },
    );
  }

  // 白名单重建，不整体透传：客户端发来的 body 是不可信输入，
  // 透传等于把「哪些字段可以写」的判断交给后端的 forbidNonWhitelisted，
  // 一旦后端 DTO 加了字段就会静默变成可写。
  const body: Record<string, unknown> = {};
  if (typeof payload.name === 'string') body.name = payload.name;
  if (typeof payload.slug === 'string') body.slug = payload.slug;
  if (payload.parentId === null || typeof payload.parentId === 'string') {
    body.parentId = payload.parentId;
  }
  if (typeof payload.sort === 'number') body.sort = payload.sort;

  try {
    const result = await apiFetch('/catalog/categories', {
      method: 'POST',
      body,
      token: session.accessToken,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (cause) {
    return toErrorResponse(cause);
  }
}