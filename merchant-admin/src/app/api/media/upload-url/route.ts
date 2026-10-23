import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { readJson, toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 签发上传凭证（presigned PUT URL）的中转。
 *
 * 为什么必须中转：后端没开 CORS（MinIO 开了，但 API 没开），
 * 浏览器直连会被预检拦掉；而且 accessToken 不能进客户端、
 * NextAuth 的 auth() 只能在服务端请求作用域里调用。
 * 详见 app/api/stores/me/route.ts 顶部的说明。
 *
 * ⚠️ 白名单纪律：不整体透传请求体，理由见 api/categories/route.ts 顶部。
 */

/** 后端 UploadUrlDto 认识的字段（见 api/src/modules/media/dto/upload-url.dto.ts） */
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;

/** 本地预检：与后端的 MEDIA_MAX_SIZE 默认值一致，后端仍会复核（见 media.service.ts） */
const MAX_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * filename 的本地长度上限，与后端 @MaxLength(200) 对齐。
 *
 * 这里再挡一道是为了给出可读的错误：后端 400 的 message 是「filename must be
 * longer than or equal to ...」之类的校验文案（或者被统一错误处理覆盖），
 * 而文件名超长这种问题商家自己能看懂「文件名不能超过 200 个字符」。
 */
const MAX_FILENAME_LENGTH = 200;

export async function POST(request: Request) {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }

  const parsed: unknown = await readJson(request);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return NextResponse.json({ message: '请求体必须是 JSON 对象' }, { status: 400 });
  }
  const payload = parsed as Record<string, unknown>;

  const filename = payload.filename;
  if (typeof filename !== 'string' || filename.trim() === '') {
    return NextResponse.json({ message: 'filename 必须是非空字符串' }, { status: 400 });
  }
  if (filename.length > MAX_FILENAME_LENGTH) {
    return NextResponse.json(
      { message: `filename 不能超过 ${MAX_FILENAME_LENGTH} 个字符` },
      { status: 400 },
    );
  }

  const mime = payload.mime;
  if (
    typeof mime !== 'string' ||
    !(ALLOWED_MIME_TYPES as readonly string[]).includes(mime)
  ) {
    return NextResponse.json(
      {
        message: `不支持的图片类型：${typeof mime === 'string' ? mime : '（未提供）'}。只支持 ${ALLOWED_MIME_TYPES.join('、')}`,
      },
      { status: 400 },
    );
  }

  const size = payload.size;
  // 必须是整数：后端 UploadUrlDto 上是 @IsInt()，1.5 或 NaN 会被 400。
  // 这里先判掉，界面上的提示比后端的校验文案可读。
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 1) {
    return NextResponse.json(
      { message: 'size 必须是 ≥ 1 的整数（文件字节数）' },
      { status: 400 },
    );
  }
  if (size > MAX_SIZE_BYTES) {
    return NextResponse.json(
      { message: `文件超过 ${MAX_SIZE_BYTES / 1024 / 1024}MB 上限` },
      { status: 400 },
    );
  }

  // 白名单重建：只把上面三个确认过的字段发给后端。
  // ⚠️ 不转发 filename 之外的任何客户端字段（key / status / uploadedBy /
  // tenantId 之类），它们都是服务端自己算的。
  const body = { filename: filename.trim(), mime, size };

  try {
    const result = await apiFetch('/media/upload-url', {
      method: 'POST',
      body,
      token: session.accessToken,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (cause) {
    return toErrorResponse(cause);
  }
}