/**
 * 分页参数的解析与夹取。
 *
 * 放在 common 是因为**商品列表、订单列表、公开列表都要用同一套规则**——
 * 各写一份的话，迟早有一处漏掉上限，攻击者就能用 `pageSize=999999`
 * 把整个租户的数据拖出去。
 */

/** 每页条数上限 */
export const MAX_PAGE_SIZE = 100;

/** 默认每页条数 */
export const DEFAULT_PAGE_SIZE = 20;

/**
 * 把查询串安全地解析成整数。
 *
 * controller 的 `@Query('page') page?: string` 拿到的是裸字符串，而
 * `ValidationPipe` 只作用于带 DTO 的路由——没有 DTO 的列表接口拿到的
 * 就是字符串。
 *
 * ⚠️ 解析失败**必须落回默认值**，不能让它变成 NaN 一路传到 Prisma：
 * `skip: NaN` 会让整个查询抛错、接口返回 500。
 * 把畸形入参变成 500 是最容易被拿来刷错误日志、触发告警的形态。
 */
export function toIntOr(
  value: string | undefined,
  fallback: number | undefined,
): number | undefined {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.trunc(parsed);
}

/**
 * 把分页参数夹到合法区间。
 *
 * - `page` 至少为 1：`page=0` 会算出 `skip = -20`，Prisma 直接报错
 * - `pageSize` 在 1 到 `MAX_PAGE_SIZE` 之间
 * - 非有限数（NaN / Infinity）落回默认值
 *
 * ⚠️ **上限不是可选项**：`pageSize=999999` 一次就能把整个租户的订单
 * 拖出去，那是实打实的数据泄露。
 */
export function clampPagination(
  page?: number,
  pageSize?: number,
): { page: number; pageSize: number } {
  const safePage = page !== undefined && Number.isFinite(page) ? page : 1;
  const safePageSize =
    pageSize !== undefined && Number.isFinite(pageSize)
      ? pageSize
      : DEFAULT_PAGE_SIZE;

  return {
    page: Math.max(1, Math.trunc(safePage)),
    pageSize: Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(safePageSize))),
  };
}
