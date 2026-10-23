import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 库存流水查询的中转。
 *
 * 流水表是 append-only 的，只有查询接口——没有修改与删除，这是审计要求。
 * 查询参数原样转发（skuId / page / pageSize），后端做了分页上限收敛。
 *
 * 租户身份由 accessToken 里的 tenantId 决定，不带 X-Tenant-Subdomain。
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }

  const query = new URL(request.url).searchParams.toString();

  try {
    const result = await apiFetch(
      `/inventory/movements${query ? `?${query}` : ''}`,
      { token: session.accessToken },
    );
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}