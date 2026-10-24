import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 确认上传完成的中转。
 *
 * 后端会 HEAD 对象核对存在与大小，只信客户端说「传完了」是不够的。
 * 详见 api/src/modules/media/media.service.ts 的 confirm。
 *
 * 这条路由**没有请求体**，所以不存在白名单问题：连 readJson 都不调用，
 * 客户端发来的任何 body 一律忽略（后端方法上也没有 @Body()）。
 */

/** media id 是 cuid/uuid，挡住明显不是 id 的东西省一次往返 */
const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }
  const { id } = await params;

  if (!ID_PATTERN.test(id)) {
    return NextResponse.json({ message: '媒体 id 不合法' }, { status: 400 });
  }

  try {
    const result = await apiFetch(`/media/${id}/confirm`, {
      method: 'POST',
      token: session.accessToken,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (cause) {
    return toErrorResponse(cause);
  }
}