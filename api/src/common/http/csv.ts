/**
 * 极简 CSV 生成（阶段 9）。
 *
 * ⚠️ **公式注入防护**：`=`、`+`、`-`、`@` 开头的单元格会被 Excel/Sheets
 *    当成公式执行。即使数据来自自己的数据库，商家名与账目字段也可能是
 *    用户可控的，导出文件被运营打开时就可能执行。
 *
 * ⚠️ 负数的负号也会被前置单引号 —— 这是**刻意的取舍**：
 *    列含义比「能否直接求和」更重要，导入方应按文本处理。
 */
export function escapeCsvCell(value: unknown): string {
  // 导出字段只有字符串 / 数字 / 布尔；显式收窄，避免对象被转成 `[object Object]`。
  const raw =
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
      ? String(value)
      : '';
  const guarded = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;

  if (/[",\r\n]/.test(guarded)) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

/** 表头 + 数据行 → CSV 文本（CRLF 结尾） */
export function toCsv(
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
): string {
  const lines = [headers, ...rows].map((row) =>
    row.map(escapeCsvCell).join(','),
  );
  return `${lines.join('\r\n')}\r\n`;
}
