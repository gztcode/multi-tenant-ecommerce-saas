import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { readJson, toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 商家整单退款的中转。
 *
 * 请求体按白名单重建：只接受可选的 `reason`。
 *
 * ⚠️ **不接受金额字段**——本阶段只支持**整单退款**（设计 §7.1），
 * 退款金额就是订单金额。接受金额字段的话，「退 1 分钱」会把整单
 * 标成 REFUNDED。
 *
 * ⚠️ **退款不回补库存**：货已经发出去了，退的是钱不是库存。
 * 「退货入库」是另一套流程（要有退货单、质检），不在本阶段。
 * 这个取舍要在商家后台的文案里说明——商家看到「库存在退款后没变」
 * 会以为系统坏了。
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
  // 客户端发来的请求体不受信任：数组 / 字符串 / null 都先挡掉，
  // 再按白名单重建，而不是整个透传给后端
  // （护栏 3：typeof [] === 'object' 为真，只判 typeof 会让数组溜进去）。
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return NextResponse.json({ message: '请求体必须是 JSON 对象' }, { status: 400 });
  }
  const payload = parsed as Record<string, unknown>;

  const body: Record<string, unknown> = {};
  if (typeof payload.reason === 'string' && payload.reason.trim() !== '') {
    body.reason = payload.reason.trim();
  }

  try {
    const result = await apiFetch(
      `/merchant/orders/${encodeURIComponent(orderNo)}/refund`,
      { method: 'POST', body, token: session.accessToken },
    );
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
