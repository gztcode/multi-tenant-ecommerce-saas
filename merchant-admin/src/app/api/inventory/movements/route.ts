import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/** 后端库存流水查询支持的查询参数（见 InventoryMovementsQueryDto） */
const MOVEMENTS_QUERY_KEYS = ['skuId', 'page', 'pageSize'] as const;

/**
 * 库存流水查询的中转。
 *
 * 流水表是 append-only 的，只有查询接口——没有修改与删除，这是审计要求。
 * 查询参数按白名单重建（skuId / page / pageSize），后端做了分页上限收敛。
 *
 * 查询串按白名单重建而不是原样透传：后端的 ValidationPipe 开了
 * forbidNonWhitelisted，客户端多传任何一个参数就会直接 400，界面上只会显示
 * 一句没头没尾的校验失败。这里显式挡掉，也让「这个页面到底支持哪些筛选」
 * 只有这一处定义。
 *
 * 租户身份由 accessToken 里的 tenantId 决定，不带 X-Tenant-Subdomain。
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.accessToken) {
    return unauthorizedResponse();
  }

  const incoming = new URL(request.url).searchParams;
  const params = new URLSearchParams();
  for (const key of MOVEMENTS_QUERY_KEYS) {
    const value = incoming.get(key);
    if (value !== null && value !== '') {
      params.set(key, value);
    }
  }
  const suffix = params.toString();

  try {
    const result = await apiFetch(
      `/inventory/movements${suffix ? `?${suffix}` : ''}`,
      { token: session.accessToken },
    );
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}