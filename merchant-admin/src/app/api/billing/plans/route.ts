import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 套餐列表的中转。
 *
 * ⚠️ **路径不带 `merchant/` 前缀**：计费模块的控制器直接挂在 `@Controller('billing')`，
 * 商家侧的鉴权由它自己的 `@Roles(MERCHANT_OWNER, MERCHANT_STAFF)` 承担。
 * 写成 `/merchant/billing/plans` 会 404。
 */
export async function GET() {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }

  try {
    const result = await apiFetch('/billing/plans', {
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
