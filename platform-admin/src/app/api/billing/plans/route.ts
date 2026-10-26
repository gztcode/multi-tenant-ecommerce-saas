import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import {
  readJson,
  toErrorResponse,
  unauthorizedResponse,
} from '@/lib/route-helpers';
import { buildPlanBody } from './plan-body';

/**
 * 套餐的中转：GET 套餐列表、POST 创建套餐。
 *
 * ⚠️ **为什么要中转路由**（而不是前端直接 fetch 后端）：
 * - 后端**没开 CORS**，浏览器直连会被预检拦掉，界面上只剩一句
 *   没线索的 `Failed to fetch`；
 * - accessToken 因此可以**完全留在服务端**，不必为发一个 PATCH
 *   就把令牌下发到浏览器。
 *
 * ⚠️ **路径不带 `merchant/` 前缀**：平台的接口挂在 `@Controller('platform/plans')`
 * 与 `@Controller('platform')` 上，写成 `/merchant/plans` 会打到商家侧那套路由上
 * （那套要商家令牌，鉴权方式根本不同）。
 *
 * ⚠️ **白名单纪律**：请求体**按白名单重建**，不整体透传。
 * 规则见 `plan-body.ts`。
 */

export async function GET() {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }

  try {
    const result = await apiFetch('/platform/plans', {
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

  const payload = (await readJson(request)) as Record<string, unknown>;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return NextResponse.json(
      { message: '请求体必须是 JSON 对象' },
      { status: 400 },
    );
  }

  // ⚠️ **`status` / `sortOrder` / `tenantId` / `id` 都不放行**：
  // - 套餐是**平台**的数据，不带 tenantId；
  // - 上下架走专门的 DELETE（下架）与后端的状态流转，
  //   不靠客户端传 `status` 改。
  const result = buildPlanBody(payload, false);
  if ('error' in result) {
    return NextResponse.json({ message: result.error }, { status: 400 });
  }

  try {
    const created = await apiFetch('/platform/plans', {
      method: 'POST',
      body: result.body,
      token: session.accessToken,
    });
    return NextResponse.json(created, { status: 201 });
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
