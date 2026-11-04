import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { API_BASE_URL } from '@/lib/api-client';
import { unauthorizedResponse } from '@/lib/route-helpers';

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * 结算单 CSV 导出的中转。
 *
 * ⚠️ 不能走 `apiFetch`：它把响应当 JSON 解析，而这里是 `text/csv`。
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.accessToken) {
    return unauthorizedResponse();
  }

  const period = new URL(request.url).searchParams.get('period');
  if (period !== null && !PERIOD_PATTERN.test(period)) {
    return NextResponse.json(
      { message: '周期格式非法：必须是 YYYY-MM（如 2026-10）' },
      { status: 400 },
    );
  }

  const query = period ? `?period=${encodeURIComponent(period)}` : '';
  const response = await fetch(
    `${API_BASE_URL}/platform/settlements/export${query}`,
    { headers: { authorization: `Bearer ${session.accessToken}` } },
  );

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { message?: string }
      | null;
    return NextResponse.json(
      { message: body?.message ?? '导出失败' },
      { status: response.status },
    );
  }

  return new NextResponse(await response.text(), {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition':
        response.headers.get('content-disposition') ??
        `attachment; filename="settlements-${period ?? 'all'}.csv"`,
    },
  });
}
