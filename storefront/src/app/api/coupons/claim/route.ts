import { NextResponse } from 'next/server';
import { readJson, toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';
import { currentSubdomain, currentToken, fetchBackend } from '@/lib/server-cart';

/**
 * 领券的中转：POST /coupons/claim。
 *
 * 必须登录——后端的领券接口挂了 JwtAuthGuard（领取记录记的是 customerId，
 * 游客领了也没地方记）。
 *
 * ⚠️ **请求体按白名单重建**：只接受 `couponId` 或 `code`（二选一）。
 *
 * - 其余字段**全部丢弃**，绝不接受任何金额字段
 *   （`discountAmount` / `value` / `minAmount` …）：
 *   面额与门槛只能由后端从库里读（护栏 M1 / M2）。
 *   客户端多传一个 `discountAmount` 会被后端 400，而更根本的问题是
 *   「客户端算的优惠额一律不信」。
 * - `couponId` 与 `code` 都传时**只发 `couponId`**：
 *   后端的查找逻辑是「有 couponId 就按 id 查，否则按 code 查」，
 *   两个都发过去查找路径就有歧义。
 */
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
  const body = parsed as Record<string, unknown>;

  // ---- couponId / code 二选一 ----
  //
  // ⚠️ 两者都不给 → 400，且**不调后端**：后端也会 400，
  // 但在这里挡掉能少一次无谓的往返，也避免把「请求体形状不对」
  // 与「券不存在」这两类错误混在同一个响应里。
  const rawCouponId = body.couponId;
  const rawCode = body.code;

  const payload: Record<string, unknown> = {};

  if (rawCouponId !== undefined) {
    if (typeof rawCouponId !== 'string' || rawCouponId === '') {
      return NextResponse.json(
        { message: 'couponId 必须是非空字符串' },
        { status: 400 },
      );
    }
    payload.couponId = rawCouponId;
  } else if (rawCode !== undefined) {
    if (typeof rawCode !== 'string' || rawCode === '') {
      return NextResponse.json(
        { message: 'code 必须是非空字符串' },
        { status: 400 },
      );
    }
    payload.code = rawCode;
  } else {
    return NextResponse.json(
      { message: '必须提供 couponId 或 code' },
      { status: 400 },
    );
  }

  try {
    const result = await fetchBackend<{ couponId: string; quantity: number }>(
      '/coupons/claim',
      {
        method: 'POST',
        body: payload,
        subdomain,
        token,
      },
    );
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
