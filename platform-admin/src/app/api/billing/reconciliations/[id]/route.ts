import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';
import {
  RECONCILIATION_DIFF_TYPE_VALUES,
  RECONCILIATION_RESOLUTION_VALUES,
  RECONCILIATION_SEVERITY_VALUES,
} from '@/lib/reconciliation';
import { encodePathSegment } from '@ecom/frontend-shared/url';

/**
 * 详情筛选参数的白名单：**只有这三个键会被转发**，其余 query 一律丢弃。
 *
 * ⚠️ **不做原样透传** —— 后端开了 `forbidNonWhitelisted`，透传一个多余参数
 *    就是 400；而如果哪天后端放宽了，透传又变成「前端能改后端见过的任何参数」。
 */
const DETAIL_FILTERS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['severity', RECONCILIATION_SEVERITY_VALUES],
  ['resolution', RECONCILIATION_RESOLUTION_VALUES],
  ['type', RECONCILIATION_DIFF_TYPE_VALUES],
];

/**
 * 对账任务详情的中转：GET /api/billing/reconciliations/:id。
 *
 * ⚠️ **服务端组件直连后端、不走这里** —— 这个路由是给客户端组件
 *    刷新后重新取数的备用通道（见 `reconciliation-actions.tsx`）。
 *
 * 可选筛选参数 `severity` / `resolution` / `type` 只作用于差异列表，
 * 白名单重建后再转发；非法值**当场 400、不打后端**（同 `settlements/export`）。
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await auth();
  if (!session?.accessToken) {
    return unauthorizedResponse();
  }

  const search = new URL(request.url).searchParams;
  const query = new URLSearchParams();
  for (const [key, allowed] of DETAIL_FILTERS) {
    // 空字符串 = 不筛：GET 表单会把没选的 `<select>` 也带上（`severity=`）
    const value = search.get(key)?.trim();
    if (!value) {
      continue;
    }
    if (!allowed.includes(value)) {
      return NextResponse.json(
        { message: `筛选参数 ${key} 非法：${value}` },
        { status: 400 },
      );
    }
    query.set(key, value);
  }

  const suffix = query.toString() ? `?${query.toString()}` : '';
  try {
    const result = await apiFetch(
      `/platform/payout-reconciliations/${encodePathSegment(id)}${suffix}`,
      { token: session.accessToken },
    );
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
