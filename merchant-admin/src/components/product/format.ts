/**
 * 商品模块的展示格式化。
 *
 * 单独成文件而不是留在某个组件里：金额展示会同时出现在商品列表、
 * 商品编辑页与后续的 SKU 价格表三处，每处内联一份就会各自漂移
 * （有一处忘了除以 100，界面上就会出现「¥5900.00」这种数字）。
 * 有一处定义，改一次全局生效。
 */

/**
 * 金额：分 → 「¥59.00」。
 *
 * null（没有可用 SKU、拿不到价格）显示成「—」而不是「¥0.00」：
 * 两者含义不同，前者是「没有」，后者是「免费」。
 *
 * 两个前端项目不共享代码（设计文档 §4.1），所以 merchant-admin 与 storefront
 * 各有一份；改这里不影响 storefront。
 */
export function formatPrice(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  return `¥${(cents / 100).toFixed(2)}`;
}