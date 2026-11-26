/**
 * `format-price` 只是 `money.ts` 的转发入口。
 *
 * ⚠️ 值得单独测：三端从前各自 import `@/lib/format`（storefront）或
 * `@/lib/money`（merchant-admin），统一到共享包后，**导错名字/导错文件**
 * 的后果是构建期就少一个符号。这里钉住「这个入口确实导出 formatPrice，
 * 且口径与 money.ts 一致」。
 */
import { describe, expect, it } from 'vitest';

import { formatPrice } from '../src/format-price';
import { formatPrice as formatPriceFromMoney } from '../src/money';

describe('format-price 入口', () => {
  it('导出的就是 money.ts 的同一个函数（不是第二份实现）', () => {
    expect(formatPrice).toBe(formatPriceFromMoney);
  });

  it('展示口径：¥ + 两位小数；空值 → —', () => {
    expect(formatPrice(5900)).toBe('¥59.00');
    expect(formatPrice(0)).toBe('¥0.00');
    expect(formatPrice(null)).toBe('—');
    expect(formatPrice(undefined)).toBe('—');
  });
});
