import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 平台订阅列表的中转：跨租户的订阅（谁订了什么套餐）。
 *
 * ⚠️ **路径不带 `merchant/` 前缀**：平台的订阅列表挂在
 * `@Controller('platform')` 的 `GET subscriptions` 上，
 * 商家侧那套是 `/billing/subscription`（只有「我的订阅」）。
 *
 * ⚠️ **这里只有 GET**：平台侧**不能**改订阅——换套餐要商家自己在
 * 商家后台操作（护栏 M3：商家能自己换套餐，平台不能替它换，
 * 否则平台就能绕过计费规则）。本阶段平台侧只有「看」。
 */
export async function GET() {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }

  try {
    const result = await apiFetch('/platform/subscriptions', {
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
