/**
 * 「元 ↔ 分」的转换。
 *
 * ⚠️ **这一条要测**：`parseFloat('9.9') * 100` 的真值是 `990.0000000000001`。
 * 不取整就会差一分钱——用户看到的金额与实际扣的不一样。
 */
import { describe, expect, it } from 'vitest';

import { centsToYuan, yuanToCents } from '@/lib/money';

describe('yuanToCents：元 → 整数分', () => {
  it('整数元', () => {
    expect(yuanToCents('10')).toBe(1000);
  });

  it('一位小数', () => {
    expect(yuanToCents('9.9')).toBe(990);
    expect(yuanToCents('0.5')).toBe(50);
  });

  it('两位小数', () => {
    expect(yuanToCents('9.99')).toBe(999);
    expect(yuanToCents('0.01')).toBe(1);
  });

  it('⚠️ 浮点尾数被收敛成整数（9.9 * 100 的真值是 990.0000000000001）', () => {
    const cents = yuanToCents('9.9');
    expect(cents).toBe(990);
    expect(Number.isInteger(cents)).toBe(true);
  });

  it('前后空格不影响', () => {
    expect(yuanToCents('  12.34  ')).toBe(1234);
  });

  it('0 元 → 0 分', () => {
    expect(yuanToCents('0')).toBe(0);
    expect(yuanToCents('0.00')).toBe(0);
  });

  it('非法输入一律 null（不猜）', () => {
    expect(yuanToCents('')).toBeNull();
    expect(yuanToCents('   ')).toBeNull();
    expect(yuanToCents('abc')).toBeNull();
    expect(yuanToCents('-5')).toBeNull();
    expect(yuanToCents('9.999')).toBeNull();
    expect(yuanToCents('1e3')).toBeNull();
    expect(yuanToCents('9.9abc')).toBeNull();
    expect(yuanToCents('.5')).toBeNull();
  });
});

describe('centsToYuan：整数分 → 展示用的元', () => {
  it('两位小数', () => {
    expect(centsToYuan(1000)).toBe('10.00');
    expect(centsToYuan(990)).toBe('9.90');
    expect(centsToYuan(1)).toBe('0.01');
  });

  it('null / undefined → —', () => {
    expect(centsToYuan(null)).toBe('—');
    expect(centsToYuan(undefined)).toBe('—');
  });
});
