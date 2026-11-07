import { NextResponse } from 'next/server';
import { readJson, toErrorResponse } from '@/lib/route-helpers';
import { currentSubdomain, fetchBackend } from '@/lib/server-cart';

/**
 * 游客订单查询的中转（阶段 11）。
 *
 * 这是三端 BFF 路由里**唯一不需要 accessToken 的写型中转**：
 * 后端 `POST /api/v1/orders/guest-lookup` 用「订单号 + 收货手机号」
 * 双因子匹配，并只返回最小投影（无姓名/电话/地址）。
 * 这里的职责只有三条：
 * 1. 白名单化请求体（畸形请求 400，不透传给后端）；
 * 2. 附上店铺子域名（租户上下文由后端从它建立）；
 * 3. 错误透传（404/429 的业务文案原样给页面）。
 */
type GuestLookupResult = {
  orderNo: string;
  status: string;
  totalAmount: number;
  itemCount: number;
  createdAt: string;
  paidAt: string | null;
};

export async function POST(request: Request) {
  const body = await readJson(request);
  const { orderNo, phone } = (body ?? {}) as {
    orderNo?: unknown;
    phone?: unknown;
  };
  if (
    typeof orderNo !== 'string' ||
    typeof phone !== 'string' ||
    orderNo.length === 0 ||
    phone.length === 0
  ) {
    return NextResponse.json(
      { message: '请填写订单号与收货手机号' },
      { status: 400 },
    );
  }
  const subdomain = await currentSubdomain();

  try {
    const result = await fetchBackend<GuestLookupResult>(
      '/orders/guest-lookup',
      {
        subdomain,
        method: 'POST',
        body: { orderNo, phone },
      },
    );
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
