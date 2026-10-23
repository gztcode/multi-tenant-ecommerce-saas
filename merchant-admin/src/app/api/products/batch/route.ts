import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { readJson, toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 商品批量操作的中转（列表页的批量上架 / 下架 / 删除走这里）。
 *
 * 路由放在 /api/products/batch 而不是 /api/products/[id] 里：
 * Next.js 的静态路由 batch 优先于动态段 [id]，所以 /api/products/batch
 * 命中的是这个文件，不会被 [id] 拦走。完整单条操作留给 api/products/[id]。
 *
 * 批量在后端是单事务（要么全成功要么全不生效），业务提示原样透传给列表页。
 * 租户身份由 accessToken 里的 tenantId 决定，不带 X-Tenant-Subdomain。
 */

/**
 * 这里只放列表页真正会发的三个动作。
 *
 * 后端 BatchProductsDto 还接受 SET_CATEGORY 与 ADJUST_PRICE，但它们要额外带
 * categoryId / mode / value，且都不在本页面（也不在本小步）的范围内。
 * 在中转层就按白名单挡掉，比透过去让后端 400 好——界面上的错误提示更明确，
 * 也避免将来有人用这个中转顺手发出批量改价这种没有预览的不可逆操作。
 */
const ALLOWED_ACTIONS = ['PUBLISH', 'UNPUBLISH', 'DELETE'] as const;

export async function POST(request: Request) {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }

  // 客户端发来的请求体不受信任：数组 / 字符串 / null 都先挡掉，
  // 再按白名单重建，而不是整个透传给后端
  // （ValidationPipe 开了 forbidNonWhitelisted，多一个字段就是 400）。
  const parsed: unknown = await readJson(request);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return NextResponse.json({ message: '请求体必须是 JSON 对象' }, { status: 400 });
  }
  const body = parsed as { ids?: unknown; action?: unknown };

  const { ids, action } = body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ message: 'ids 必须是非空数组' }, { status: 400 });
  }
  // 后端 ArrayMaxSize(200)：这里先挡一次，错误信息直接指向上限。
  if (ids.length > 200) {
    return NextResponse.json({ message: 'ids 最多 200 个' }, { status: 400 });
  }
  if (!ids.every((id): id is string => typeof id === 'string' && id !== '')) {
    return NextResponse.json(
      { message: 'ids 里的每一项都必须是非空字符串' },
      { status: 400 },
    );
  }
  if (
    typeof action !== 'string' ||
    !(ALLOWED_ACTIONS as readonly string[]).includes(action)
  ) {
    return NextResponse.json(
      { message: `action 只能是 ${ALLOWED_ACTIONS.join(' / ')}` },
      { status: 400 },
    );
  }

  try {
    const result = await apiFetch('/catalog/products/batch', {
      method: 'POST',
      body: { ids, action },
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}