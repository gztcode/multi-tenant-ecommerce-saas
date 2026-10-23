import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { readJson, toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 品类改名与删除的中转。
 *
 * 删除是软删除（后端写 deletedAt），且后端会拒绝「有子品类或有商品」的品类——
 * 错误提示原样透传给客户端的 CategoryManager 展示。
 *
 * 更新只提交 name / sort，**不能提交 slug 也不能提交 parentId**：
 * - slug 参与 URL，后端 UpdateCategoryDto 根本不接受这个字段
 *   （ValidationPipe 开了 forbidNonWhitelisted，透传过去直接 400）；
 * - 改挂父节点会连带触发后端一整套深度与环检测，
 *   而这个页面上的改名只需要改名字。
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
  // 客户端发来的请求体不受信任：先确认是个普通对象，再显式白名单字段，
  // 而不是整个透传给后端。数组、字符串、null 都在这里被挡掉。
  const parsed: unknown = await readJson(request);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return NextResponse.json({ message: '请求体必须是 JSON 对象' }, { status: 400 });
  }
  const body = parsed as { name?: unknown; sort?: unknown };

  if (typeof body.name !== 'string' || body.name.trim() === '') {
    return NextResponse.json({ message: 'name 必须是非空字符串' }, { status: 400 });
  }

  const sanitized: { name: string; sort?: number } = { name: body.name.trim() };
  if (body.sort !== undefined) {
    if (typeof body.sort !== 'number' || !Number.isInteger(body.sort)) {
      return NextResponse.json({ message: 'sort 必须是整数' }, { status: 400 });
    }
    sanitized.sort = body.sort;
  }

  try {
    const result = await apiFetch(`/catalog/categories/${id}`, {
      method: 'PATCH',
      body: sanitized,
      token: session.accessToken,
    });
    return NextResponse.json(result);
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
    await apiFetch(`/catalog/categories/${id}`, {
      method: 'DELETE',
      token: session.accessToken,
    });
    return new NextResponse(null, { status: 204 });
  } catch (cause) {
    return toErrorResponse(cause);
  }
}