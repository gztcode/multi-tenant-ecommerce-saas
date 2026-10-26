import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiAbsoluteUrl, apiFetch } from '@/lib/api-client';
import {
  readJson,
  toErrorResponse,
  unauthorizedResponse,
} from '@/lib/route-helpers';

/**
 * 手动续费的中转：POST 建订阅账单的支付单（返回渠道的支付页面 URL）。
 *
 * ⚠️ **金额只从账单读**，请求体不接受任何金额字段。
 * 带上金额就是「付 1 分钱把一年期的账结了」。
 *
 * ⚠️ **账单号来自 URL**，不是请求体——请求体里带一个别的账单号
 * 就是替别家付账的越权尝试。
 *
 * ⚠️ **这个控制器住在后端的 `payment` 模块**（不归 `billing`），
 * 但路径是 `billing/invoices/:number/pay`——与商家后台的订阅页同一组接口。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ number: string }> },
) {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }
  const { number } = await params;

  const payload = (await readJson(request)) as Record<string, unknown>;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return NextResponse.json(
      { message: '请求体必须是 JSON 对象' },
      { status: 400 },
    );
  }

  // 白名单重建：只放 channel，且只放可选的
  const body: Record<string, unknown> = {};
  if (payload.channel !== undefined) {
    if (typeof payload.channel !== 'string' || payload.channel.trim() === '') {
      return NextResponse.json(
        { message: '支付渠道必须是非空字符串' },
        { status: 400 },
      );
    }
    body.channel = payload.channel.trim();
  }

  try {
    const result = await apiFetch<{ payUrl?: string }>(
      `/billing/invoices/${number}/pay`,
      {
        method: 'POST',
        body,
        token: session.accessToken,
      },
    );
    // ⚠️ **把 `payUrl` 转成绝对地址再返回**：后端给的是相对路径
    // （`/api/v1/pay/fake/xxx`），浏览器拿它去请求会打到商家后台的
    // 域名上——404。支付页在**后端**上，所以要拼后端的 origin。
    const payUrl = result?.payUrl
      ? apiAbsoluteUrl(result.payUrl)
      : undefined;
    return NextResponse.json({ ...result, payUrl });
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
