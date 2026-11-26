/**
 * 「元 ↔ 分」的换算。
 *
 * ⚠️ **这组测试守的是钱**：`parseFloat('9.9') * 100` 的真值是
 * `990.0000000000001`，少一次取整就少一分钱；正则放松一位小数，
 * 用户敲的 `9.999` 就会被悄悄进位成 `1000` 分。
 */
import { describe, expect, it } from 'vitest';

import { centsToYuan, formatPrice, yuanToCents } from '../src/money';

describe('yuanToCents：元 → 整数分', () => {
  it('整数元', () => {
    expect(yuanToCents('10')).toBe(1000);
    expect(yuanToCents('0')).toBe(0);
  });

  it('一位与两位小数', () => {
    expect(yuanToCents('9.9')).toBe(990);
    expect(yuanToCents('0.5')).toBe(50);
    expect(yuanToCents('0.01')).toBe(1);
    expect(yuanToCents('9.99')).toBe(999);
  });

  it('⚠️ 浮点尾数被收敛成整数（9.9 * 100 的真值是 990.0000000000001）', () => {
    expect(yuanToCents('9.9')).toBe(990);
    expect(yuanToCents('0.29')).toBe(29);
    expect(yuanToCents('0.07')).toBe(7);
    expect(Number.isInteger(yuanToCents('9.9'))).toBe(true);
  });

  it('分与分相加不引入浮点误差（0.1 元 + 0.2 元 = 0.3 元）', () => {
    const sum = (yuanToCents('0.1') ?? 0) + (yuanToCents('0.2') ?? 0);
    expect(sum).toBe(30);
    expect(sum / 100).toBe(0.3);
  });

  it('前后空格不影响', () => {
    expect(yuanToCents('  12.34  ')).toBe(1234);
  });

  it('⚠️ 半分（0.005 元）直接拒绝，不四舍五入', () => {
    // 后端只认整数分。把 0.005 元「舍」成 0 或「入」成 1 都是在替用户
    // 决定一笔钱，而用户看到的输入框里明明写着三位小数。
    expect(yuanToCents('0.005')).toBeNull();
    expect(yuanToCents('0.001')).toBeNull();
  });

  it('非法输入一律 null（不猜）', () => {
    expect(yuanToCents('')).toBeNull();
    expect(yuanToCents('   ')).toBeNull();
    expect(yuanToCents('abc')).toBeNull();
    expect(yuanToCents('NaN')).toBeNull();
    expect(yuanToCents('Infinity')).toBeNull();
    expect(yuanToCents('-5')).toBeNull();
    expect(yuanToCents('+5')).toBeNull();
    expect(yuanToCents('9.999')).toBeNull();
    expect(yuanToCents('1e3')).toBeNull();
    expect(yuanToCents('9.9abc')).toBeNull();
    expect(yuanToCents('.5')).toBeNull();
    expect(yuanToCents('5.')).toBeNull();
    expect(yuanToCents('1,000')).toBeNull();
    expect(yuanToCents('１２')).toBeNull();
  });

  it('⚠️ 超出安全整数范围的金额返回 null，不返回一个「大概对」的分', () => {
    // 分必须落在 Number.MAX_SAFE_INTEGER 内，否则加减会静默丢精度。
    expect(yuanToCents('9007199254740991')).toBeNull();
    expect(yuanToCents('999999999999999.99')).toBeNull();
  });
});

describe('centsToYuan：整数分 → 展示用的元', () => {
  it('固定两位小数（10.1 元也要显示成 10.10）', () => {
    expect(centsToYuan(1000)).toBe('10.00');
    expect(centsToYuan(990)).toBe('9.90');
    expect(centsToYuan(1010)).toBe('10.10');
    expect(centsToYuan(1)).toBe('0.01');
    expect(centsToYuan(0)).toBe('0.00');
  });

  it('负零显示成 0.00，不出现 -0.00', () => {
    expect(centsToYuan(-0)).toBe('0.00');
    // toFixed 不会把 -0 渲染成 -0.00，但这里钉住它，避免以后换成别的实现
    expect(centsToYuan(-0)).not.toContain('-');
  });

  it('大额金额不丢精度', () => {
    expect(centsToYuan(9007199254740991)).toBe('90071992547409.91');
  });

  it('null / undefined → —', () => {
    expect(centsToYuan(null)).toBe('—');
    expect(centsToYuan(undefined)).toBe('—');
  });
});

describe('formatPrice：分 → ¥xx.xx', () => {
  it('整数元带两位小数', () => {
    expect(formatPrice(5900)).toBe('¥59.00');
    expect(formatPrice(0)).toBe('¥0.00');
  });

  it('两位小数的分照实展示（口径以 centsToYuan 为准）', () => {
    expect(formatPrice(5955)).toBe('¥59.55');
  });

  it('不加千分位分隔符（展示层现状，改口径要有单独的决定）', () => {
    expect(formatPrice(123456789)).toBe('¥1234567.89');
  });

  it('负数把符号放在货币符号之后（价格本身应为非负）', () => {
    // 价格由后端保证非负；这里只钉住「不吞掉负号」——
    // 真出现负数时，界面上能看出不对，而不是显示成正数。
    expect(formatPrice(-100)).toBe('¥-1.00');
  });

  it('null / undefined → —（不带 ¥ 前缀）', () => {
    expect(formatPrice(null)).toBe('—');
    expect(formatPrice(undefined)).toBe('—');
  });
});
