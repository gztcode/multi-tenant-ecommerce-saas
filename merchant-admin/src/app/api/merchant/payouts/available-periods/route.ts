import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 可申请周期的中转。
 *
 * ⚠️ **静态段优先于动态段**：Next.js 里 `available-periods/route.ts`
 * 与 `[id]/route.ts` **不冲突**（与 NestJS 的「注册顺序」要求不同）——
 * Next.js 路由匹配时静态段优先于动态段。
 */
export async function GET() {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }

  try {
    const result = await apiFetch('/merchant/payouts/available-periods', {
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
