import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import {
  readJson,
  toErrorResponse,
  unauthorizedResponse,
} from '@/lib/route-helpers';
import { buildPlanBody } from '../plan-body';

/**
 * 单个套餐的中转：PATCH 改套餐、DELETE 下架套餐。
 *
 * ⚠️ **下架走 DELETE 而不是 PATCH 一个 `status`**：
 * 「下架」与「编辑」是两种语义。走专门的 DELETE 之后，后端能把它实现成
 * 别的动作（比如带保留期的软删）而不必担心与「改 status」混在一起。
 *
 * ⚠️ **白名单纪律**：PATCH 的请求体**按白名单重建**，不整体透传。
 * `status` / `sortOrder` / `tenantId` / `id` 都不放行——理由见
 * `../plan-body.ts`。
 */

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }
  const { id } = await params;

  const payload = (await readJson(request)) as Record<string, unknown>;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return NextResponse.json(
      { message: '请求体必须是 JSON 对象' },
      { status: 400 },
    );
  }

  // ⚠️ **PATCH 是部分更新**：全部可选，只放行给了的字段。
  const result = buildPlanBody(payload, true);
  if ('error' in result) {
    return NextResponse.json({ message: result.error }, { status: 400 });
  }

  try {
    const updated = await apiFetch(`/platform/plans/${id}`, {
      method: 'PATCH',
      body: result.body,
      token: session.accessToken,
    });
    return NextResponse.json(updated);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }
  const { id } = await params;

  try {
    await apiFetch(`/platform/plans/${id}`, {
      method: 'DELETE',
      token: session.accessToken,
    });
    // ⚠️ **下架返回 204（无内容）**，所以这里不能 `NextResponse.json(result)`
    // ——result 是 undefined，构造 JSON 响应会抛异常，
    // 界面只会看到一句没头没尾的「后端服务不可用」，
    // 而下架其实已经成功了。
    return new NextResponse(null, { status: 204 });
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
