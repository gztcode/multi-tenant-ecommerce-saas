/**
 * 地址请求体的白名单重建。
 *
 * ⚠️ **为什么不在 `app/api/addresses/route.ts` 里**：
 * Next.js 要求路由模块**只导出 HTTP 方法**（GET/POST/PATCH/DELETE…），
 * 多导出一个普通函数就会让 `next build` 的路由类型检查报
 * 「"sanitizeAddressBody" is not a valid Route export field」。
 * 这个报错平时不出现——它取决于 TypeScript 检查模块的顺序，
 * 别的文件一改就可能突然冒出来。
 *
 * 而且它本来就是个**纯函数**：不碰 request、不碰 cookies，
 * 与路由无关。放在 lib 里还能直接进单元测试。
 */

/**
 * 按白名单重建地址请求体。
 *
 * 逐个字段确认类型而不是整体透传：后端 ValidationPipe 开了
 * forbidNonWhitelisted，多传一个字段就是 400。
 */
export function sanitizeAddressBody(body: Record<string, unknown>): {
  ok: true;
  value: Record<string, unknown>;
} | {
  ok: false;
  message: string;
} {
  const sanitized: Record<string, unknown> = {};

  for (const field of ['receiver', 'phone', 'province', 'city', 'district', 'detail']) {
    const value = body[field];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.trim() === '') {
      return { ok: false, message: `${field} 必须是非空字符串` };
    }
    sanitized[field] = value.trim();
  }

  if (body.isDefault !== undefined) {
    if (typeof body.isDefault !== 'boolean') {
      return { ok: false, message: 'isDefault 必须是布尔值' };
    }
    sanitized.isDefault = body.isDefault;
  }

  return { ok: true, value: sanitized };
}
