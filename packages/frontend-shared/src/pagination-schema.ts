import { z } from 'zod';

/**
 * 7b 分页改造后的标准列表响应（items + total）。
 *
 * 供 apiFetch 的 `validate` 钩子用：后端返回结构与预期不符时
 * 在取数层就抛错，而不是把 undefined 糊到界面上。
 *
 * ⚠️ z.object 默认会**剥离**未声明的字段——只适合响应体恰好就是
 * `{ items, total }` 的接口。响应带自有字段（如佣金报表的 from/to）
 * 时用 `paginatedEntriesResponse`。
 */
export const paginatedResponse = z.object({
  items: z.array(z.unknown()),
  total: z.number().int().nonnegative(),
});

/**
 * 明细形态的分页响应（`entries + total`，目前是平台佣金报表）。
 * 用 looseObject：校验核心字段后**原样保留**其余自有字段
 * （from / to / byMerchant 等），不剥离。
 */
export const paginatedEntriesResponse = z.looseObject({
  entries: z.array(z.unknown()),
  total: z.number().int().nonnegative(),
});
