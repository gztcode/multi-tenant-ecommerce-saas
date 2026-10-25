/**
 * 「元」与「分」之间的转换。
 *
 * ⚠️ **后端一律用整数分**（全局约定），界面上用「元」。
 * 转换**只在表单的边界做**——用户输入 `9.9` 元 → 提交 `990` 分。
 *
 * ⚠️ **「元 → 分」必须取整**：`parseFloat('9.9') * 100` 的真值是
 * `990.0000000000001`，不取整会差一分钱，用户看到的与实际扣的不一样。
 * `Math.round` 把它收敛成 `990`。
 *
 * 单独成文件是因为它要被单测断言（`test/lib/money.test.ts`）——
 * 塞在组件里就没法单独测了。
 */

/**
 * 「元」的输入 → 整数分。
 *
 * ⚠️ **只接受最多两位小数的非负数**：`'9.999'`、`'1e3'`、`'-5'`、`'abc'`
 * 一律返回 null（调用方据此提示用户重填），不做「尽量解析」——
 * 猜出来的金额比没有金额更危险。
 *
 * @returns 整数分；输入不合法时返回 null
 */
export function yuanToCents(input: string): number | null {
  const trimmed = input.trim();
  // ⚠️ 用正则而不是 parseFloat：parseFloat('9.9abc') 会解析出 9.9，
  // parseFloat('1e3') 会解析出 1000 —— 用户敲错的东西被悄悄当成合法金额。
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return null;
  }
  const cents = Math.round(Number(trimmed) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

/**
 * 整数分 → 「元」的展示字符串（两位小数）。
 *
 * ⚠️ 这是**展示层**的换算，不参与任何计算。
 */
export function centsToYuan(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  return (cents / 100).toFixed(2);
}
