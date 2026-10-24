import { NextResponse } from 'next/server';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';
import { currentSubdomain, currentToken, fetchBackend } from '@/lib/server-cart';

/** 后端发起支付的响应 */
interface CreatedPayment {
  paymentId: string;
  orderNo: string;
  amount: number;
  channel: string;
  provider: string;
  status: string;
  providerTxnId: string | null;
  /** 支付页面 URL（**相对路径**，以 /api/v1 开头） */
  payUrl: string;
  rawResponse: unknown;
}

/**
 * 发起支付的中转。
 *
 * ⚠️ **后端返回的 payUrl 是相对路径**（`/api/v1/pay/fake/:paymentId`），
 * 那是**后端服务**自己的路由前缀，浏览器拿到后要访问的是 api 服务，
 * 不是 storefront。所以这里在服务端把它拼成绝对 URL 再返回给前端——
 * 否则浏览器会去 storefront 自己的 `/api/v1/pay/fake/...`，
 * 那里根本没有这个路由（404）。
 *
 * 真实支付渠道的形态一样：微信给的是 `code_url`、支付宝给的是支付 URL，
 * 都是渠道的地址，前端只负责跳过去。
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ orderNo: string }> },
) {
  const { orderNo } = await params;
  const token = await currentToken();
  if (!token) {
    return unauthorizedResponse();
  }
  const subdomain = await currentSubdomain();

  try {
    const payment = await fetchBackend<CreatedPayment>(
      `/orders/${encodeURIComponent(orderNo)}/pay`,
      { method: 'POST', body: {}, subdomain, token },
    );

    return NextResponse.json({
      paymentId: payment.paymentId,
      orderNo: payment.orderNo,
      amount: payment.amount,
      channel: payment.channel,
      status: payment.status,
      payUrl: absolutePayUrl(payment.payUrl),
    });
  } catch (cause) {
    return toErrorResponse(cause);
  }
}

/**
 * 把后端给的相对 payUrl 拼成绝对地址。
 *
 * 后端的 payUrl 以 `/api/v1` 开头，而 API_BASE_URL 本身就以 `/api/v1` 结尾，
 * 所以要**去掉重复的那一段**再拼。直接 `${API_BASE_URL}${payUrl}` 会得到
 * `http://localhost:3000/api/v1/api/v1/pay/fake/xxx`——404。
 */
function absolutePayUrl(payUrl: string): string {
  const base = (
    process.env.API_BASE_URL ?? 'http://localhost:3000/api/v1'
  ).replace(/\/+$/, '');

  // 已经是绝对地址（真实渠道给的可能是完整 URL）就直接用
  if (/^https?:\/\//i.test(payUrl)) {
    return payUrl;
  }

  const prefix = '/api/v1';
  const path = payUrl.startsWith(prefix) ? payUrl.slice(prefix.length) : payUrl;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}
