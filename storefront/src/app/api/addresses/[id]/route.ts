import { NextResponse } from 'next/server';
import { readJson, toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';
import { currentSubdomain, currentToken, fetchBackend } from '@/lib/server-cart';
import { sanitizeAddressBody } from '@/lib/addresses';

/**
 * 单个地址的中转：PATCH 改地址、DELETE 删地址（软删）。
 *
 * 请求体按白名单重建（与新增地址同一套规则）。
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const token = await currentToken();
  if (!token) {
    return unauthorizedResponse();
  }
  const subdomain = await currentSubdomain();

  const parsed: unknown = await readJson(request);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return NextResponse.json({ message: '请求体必须是 JSON 对象' }, { status: 400 });
  }

  const sanitized = sanitizeAddressBody(parsed as Record<string, unknown>);
  if (!sanitized.ok) {
    return NextResponse.json({ message: sanitized.message }, { status: 400 });
  }
  if (Object.keys(sanitized.value).length === 0) {
    return NextResponse.json({ message: '没有要修改的字段' }, { status: 400 });
  }

  try {
    const result = await fetchBackend(
      `/addresses/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: sanitized.value, subdomain, token },
    );
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const token = await currentToken();
  if (!token) {
    return unauthorizedResponse();
  }
  const subdomain = await currentSubdomain();

  try {
    await fetchBackend(`/addresses/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      subdomain,
      token,
    });
    return new NextResponse(null, { status: 204 });
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
