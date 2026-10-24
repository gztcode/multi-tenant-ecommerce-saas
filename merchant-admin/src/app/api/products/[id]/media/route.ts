import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { readJson, toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 设置商品媒体列表（整体替换）的中转。
 *
 * 数组顺序就是封面顺序，第一个是封面。后端在一个事务里做
 * 「校验归属 → 删掉不再引用的 → 补上新引用的 → 重排 sort」，
 * 与规格矩阵的整体替换是同一个思路。
 *
 * ⚠️ 白名单纪律：不整体透传请求体，理由见 api/categories/route.ts 顶部。
 * 这里尤其重要——mediaIds 之外的字段（tenantId / sort / status …）
 * 一旦被透传，就等于允许客户端直接写数据库里的派生状态。
 */

/** 与后端 SetProductMediaDto 的 @ArrayMaxSize 对齐 */
const MAX_MEDIA_COUNT = 20;

/** media id 是 cuid/uuid */
const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }
  const { id } = await params;

  if (!ID_PATTERN.test(id)) {
    return NextResponse.json({ message: '商品 id 不合法' }, { status: 400 });
  }

  const parsed: unknown = await readJson(request);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return NextResponse.json({ message: '请求体必须是 JSON 对象' }, { status: 400 });
  }
  const payload = parsed as Record<string, unknown>;

  const mediaIds = payload.mediaIds;
  if (!Array.isArray(mediaIds)) {
    return NextResponse.json(
      { message: 'mediaIds 必须是数组（顺序即封面顺序，第一个是封面）' },
      { status: 400 },
    );
  }
  if (mediaIds.length > MAX_MEDIA_COUNT) {
    return NextResponse.json(
      { message: `最多 ${MAX_MEDIA_COUNT} 张图片` },
      { status: 400 },
    );
  }
  // 逐项类型校验：Array.every 的类型收窄在 TS 里不会自动发生，
  // 显式声明成 string[] 后下面才能安全地转发。
  const invalidIndex = mediaIds.findIndex((value) => typeof value !== 'string' || !ID_PATTERN.test(value));
  if (invalidIndex !== -1) {
    return NextResponse.json(
      { message: `第 ${invalidIndex + 1} 个媒体 id 不合法` },
      { status: 400 },
    );
  }

  // 去重但**保留顺序**：同一个媒体传两次会让后端的 sort 重排结果与
  // 界面上看到的封面顺序不一致，而这不是商家想要表达的语义。
  const mediaIdsClean: string[] = [...new Set(mediaIds as string[])];

  try {
    const result = await apiFetch(`/catalog/products/${id}/media`, {
      method: 'PUT',
      // 白名单重建：只发 mediaIds。sort / status / key / url 一律由服务端维护。
      body: { mediaIds: mediaIdsClean },
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}