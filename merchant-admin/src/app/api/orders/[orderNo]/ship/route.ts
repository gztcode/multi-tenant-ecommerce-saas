import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { readJson, toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 商家发货的中转（填快递单号）。
 *
 * 请求体按白名单重建：`trackingNo`（必填）与可选的 `remark`。
 *
 * ⚠️ **不接受金额字段，也不接受状态字段**：发货只是把订单从 `PAID`
 * 转到 `SHIPPED`，金额、条目都不能改（要改得走退款重下）。
 * 后端 ValidationPipe 开了 forbidNonWhitelisted，透传多一个字段就是 400。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ orderNo: string }> },
) {
  const { orderNo } = await params;

  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }

  const parsed: unknown = await readJson(request);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return NextResponse.json({ message: '请求体必须是 JSON 对象' }, { status: 400 });
  }
  const payload = parsed as Record<string, unknown>;

  const trackingNo = payload.trackingNo;
  if (typeof trackingNo !== 'string' || trackingNo.trim() === '') {
    return NextResponse.json(
      { message: 'trackingNo 必须是非空字符串' },
      { status: 400 },
    );
  }

  const body: Record<string, unknown> = { trackingNo: trackingNo.trim() };
  if (typeof payload.remark === 'string') {
    body.remark = payload.remark;
  }

  try {
    const result = await apiFetch(
      `/merchant/orders/${encodeURIComponent(orderNo)}/ship`,
      { method: 'POST', body, token: session.accessToken },
    );
    return NextResponse.json(result, { status: 201 });
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
