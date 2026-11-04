import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { API_BASE_URL } from '@/lib/api-client';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 上传渠道账单文件（multipart）的中转：POST /api/billing/reconciliations/import。
 *
 * ⚠️ **不能走 `apiFetch`** —— 它硬编码了 `content-type: application/json`
 *    且会 `JSON.stringify(body)`。multipart 必须让浏览器/运行时自己带 boundary，
 *    所以这里写一条**裸 fetch**，**不设 content-type**。
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.accessToken) {
    return unauthorizedResponse();
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { message: '请求不是合法的 multipart 表单' },
      { status: 400 },
    );
  }

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ message: '请上传账单文件' }, { status: 400 });
  }
  // ⚠️ **文件上限 5MB** —— 与后端 `FileInterceptor` 的 `limits` 一致。
  //    超限在后端会抛 `LIMIT_FILE_SIZE`，但那是一句「Unexpected field」
  //    式的通用错误，这里先拦下来能给出可读的提示。
  if (file.size > 5 * 1024 * 1024) {
    return NextResponse.json(
      { message: '账单文件不能超过 5MB' },
      { status: 400 },
    );
  }

  // ⚠️ **列映射必须是合法 JSON** —— 后端要 `JSON.parse(dto.columnMapping)`，
  //    解析失败抛的是「列映射不是合法的 JSON」。这里先拦一道，
  //    界面上给出的提示与后端一致（前端不自己写一套映射校验）。
  const columnMapping = formData.get('columnMapping');
  if (typeof columnMapping !== 'string' || columnMapping === '') {
    return NextResponse.json({ message: '必须指定列映射' }, { status: 400 });
  }
  try {
    JSON.parse(columnMapping);
  } catch {
    return NextResponse.json(
      { message: '列映射不是合法的 JSON' },
      { status: 400 },
    );
  }

  try {
    const response = await fetch(
      `${API_BASE_URL}/platform/payout-reconciliations/import`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${session.accessToken}` },
        // ⚠️ **不设 content-type** —— 让 fetch 自动带 boundary
        body: formData,
      },
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      return NextResponse.json(
        payload ?? { message: '上传失败' },
        { status: response.status },
      );
    }
    return NextResponse.json(payload);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
