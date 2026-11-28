import { NextResponse } from 'next/server';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';
import { currentSubdomain, currentToken, fetchBackend } from '@/lib/server-cart';
import { encodePathSegment } from '@ecom/frontend-shared/url';

/** 后端发起支付的响应 */
interface CreatedPayment {
  paymentId: string;
  orderNo: string;
  amount: number;
  channel: string;
  provider: string;
  status: string;
  providerTxnId: string | null;
  /** 支付页面 URL：相对路径（以 /api/v1 开头）或渠道给的绝对地址 */
  payUrl: string;
  rawResponse: unknown;
}

/**
 * 发起支付的中转。
 *
 * ⚠️ **后端返回的 payUrl 可能是相对路径**（`/api/v1/pay/fake/:paymentId`），
 * 那是**后端服务**自己的路由前缀。浏览器拿到后要访问的是**当前站点域名**
 * 下的同一个路径——网关会把店铺子域名下的 `/api/v1/` 转发给 api 服务。
 * 所以这里把它规整成**根相对路径**（带前导 `/`）交给浏览器，
 * 由浏览器按当前 origin 解析。
 *
 * ⚠️ **不能用服务端 `API_BASE_URL` 拼绝对地址**：compose 里那是容器内地址
 * （`http://api:3000/api/v1`），浏览器根本打不开。
 * ⚠️ **也不能返回不带前导 `/` 的相对路径**：浏览器会按**当前页面 URL**
 * 解析，从 `/orders/xxx` 跳到 `/orders/api/v1/...`，一样到不了支付页。
 *
 * 真实支付渠道的形态不同：微信给的是 `code_url`、支付宝给的是支付 URL，
 * 以及 `alipays://` / `weixin://` 这类唤起 scheme，都是**带 scheme 的绝对地址**，
 * 原样透传。
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
      `/orders/${encodePathSegment(orderNo)}/pay`,
      { method: 'POST', body: {}, subdomain, token },
    );

    return NextResponse.json({
      paymentId: payment.paymentId,
      orderNo: payment.orderNo,
      amount: payment.amount,
      channel: payment.channel,
      status: payment.status,
      payUrl: browserPayUrl(payment.payUrl),
    });
  } catch (cause) {
    return toErrorResponse(cause);
  }
}

/**
 * 带 scheme 的绝对 URL（`https://…`、`alipays://…`、`weixin://…`）。
 *
 * ⚠️ **不能只认 http/https**：支付宝/微信的唤起 scheme 不是 http(s)，
 * 按相对路径处理会拼成 `/alipays://…` 这种打不开的废串。
 * ⚠️ 协议相对地址 `//host` **不匹配**这条（它没有 scheme，以 `/` 开头），
 * 会落到下面的同源规整分支——这是刻意的。
 */
const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:/i;

/**
 * 危险 scheme：浏览器会把它们当成可执行/内联内容，绝不能交给导航。
 * 命中时不透传，按相对路径收敛成本站的普通路径。
 */
const DANGEROUS_SCHEME = /^(?:javascript|data|vbscript):/i;

/**
 * 把后端给的 payUrl 交给浏览器按**当前 origin** 解析。
 *
 * - 带 scheme 的绝对地址（真实渠道给的完整 URL 或唤起 scheme）原样返回，
 *   危险 scheme（`javascript:` / `data:` / `vbscript:`）除外。
 * - 其余补成**根相对**（以 `/` 开头）。顺带把 `//host` 这种
 *   **协议相对地址**收敛成同源路径——否则前导 `//` 会让浏览器跳到别的域名。
 */
function browserPayUrl(payUrl: string): string {
  if (ABSOLUTE_URL.test(payUrl) && !DANGEROUS_SCHEME.test(payUrl)) {
    return payUrl;
  }
  return `/${payUrl.replace(/^\/+/, '')}`;
}
