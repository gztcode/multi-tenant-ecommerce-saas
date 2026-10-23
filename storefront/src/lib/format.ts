/** 金额：分 → 「¥59.00」 */
export function formatPrice(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  return `¥${(cents / 100).toFixed(2)}`;
}
