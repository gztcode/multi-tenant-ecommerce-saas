import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 商家侧订单列表的中转。
 *
 * ⚠️ **路径是 `/merchant/orders`**（不是 `/orders`）：
 * 消费者侧与商家侧的鉴权方式不同（消费者侧要登录消费者，商家侧要店主），
 * 同一条路径挂两套守卫时 NestJS 按注册顺序匹配，后注册的那整套会被完全遮住。
 * 详见 api/src/modules/order/merchant-order.controller.ts 的注释。
 *
 * 租户身份由 accessToken 里的 tenantId 决定，不带 X-Tenant-Subdomain。
 */

/** 后端订单列表支持的查询参数 */
const LIST_QUERY_KEYS = [
  'status',
  'from',
  'to',
  'page',
  'pageSize',
] as const;

export async function GET(request: Request) {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }

  // 查询串按白名单重建，不整体透传：后端的 @Query 参数没有
  // forbidNonWhitelisted，透传未知 query 不会被拒——但透传进来的东西一律丢掉
  // 可以让「这个页面到底支持哪些筛选」只有这一处定义。
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
    const result = await apiFetch(
      `/merchant/orders${suffix ? `?${suffix}` : ''}`,
      { token: session.accessToken },
    );
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
