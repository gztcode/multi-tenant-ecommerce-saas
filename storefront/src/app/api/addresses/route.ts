import { NextResponse } from 'next/server';
import { readJson, toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';
import { currentSubdomain, currentToken, fetchBackend } from '@/lib/server-cart';
import { sanitizeAddressBody } from '@/lib/addresses';
import type { Address } from '@/lib/cart';

/**
 * 地址簿的中转：GET 列表、POST 新增。
 *
 * 必须登录——后端整组挂 JwtAuthGuard，地址簿是登录消费者的私有数据。
 *
 * 请求体按白名单重建：收件人、电话、省市区、详情、是否默认。
 * ⚠️ **不接受 customerId**：地址的归属者是当前登录的消费者，由服务端推导。
 * 客户端传 customerId 只会打开一条「把地址挂到别人账号上」的路子。
 */

export async function GET() {
  const token = await currentToken();
  if (!token) {
    return unauthorizedResponse();
  }
  const subdomain = await currentSubdomain();

  try {
    const result = await fetchBackend<{ items: Address[] }>('/addresses', {
      subdomain,
      token,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}

export async function POST(request: Request) {
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
  // 必填字段缺一不可
  for (const required of ['receiver', 'phone', 'province', 'city', 'district', 'detail']) {
    if (!(required in sanitized.value)) {
      return NextResponse.json({ message: `${required} 是必填项` }, { status: 400 });
    }
  }

  try {
    const result = await fetchBackend<Address>('/addresses', {
      method: 'POST',
      body: sanitized.value,
      subdomain,
      token,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
