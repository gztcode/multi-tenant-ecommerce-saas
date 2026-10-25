/**
 * 地址请求体的白名单重建。
 *
 * 这个函数原先住在 `app/api/addresses/route.ts` 里，被 `[id]/route.ts` 导入。
 * Next.js 要求路由模块**只导出 HTTP 方法**，多导出一个普通函数就会让
 * `next build` 的路由类型检查报错——而且那个报错**平时不出现**，
 * 它取决于 TypeScript 检查模块的顺序，别的文件一改就可能突然冒出来。
 *
 * 搬到这里之后，顺带能直接进单元测试。
 */
import { describe, expect, it } from 'vitest';

import { sanitizeAddressBody } from '@/lib/addresses';

describe('sanitizeAddressBody：地址请求体的白名单重建', () => {
  it('六个字段都收下并去掉首尾空白', () => {
    const result = sanitizeAddressBody({
      receiver: ' 张三 ',
      phone: '13800000000',
      province: '浙江省',
      city: '杭州市',
      district: '西湖区',
      detail: '文一西路 100 号',
    });
    expect(result).toEqual({
      ok: true,
      value: {
        receiver: '张三',
        phone: '13800000000',
        province: '浙江省',
        city: '杭州市',
        district: '西湖区',
        detail: '文一西路 100 号',
      },
    });
  });

  it('只带部分字段时，其余字段不出现（不补空串）', () => {
    const result = sanitizeAddressBody({ receiver: '张三', phone: '13800000000' });
    expect(result).toEqual({
      ok: true,
      value: { receiver: '张三', phone: '13800000000' },
    });
  });

  it('不认识的字段被丢掉——不整体透传', () => {
    const result = sanitizeAddressBody({
      receiver: '张三',
      phone: '13800000000',
      customerId: 'someone-else',
    });
    expect(result).toEqual({
      ok: true,
      value: { receiver: '张三', phone: '13800000000' },
    });
  });

  it('空串的字段被拒，并说清是哪个字段', () => {
    const result = sanitizeAddressBody({ receiver: '   ', phone: '13800000000' });
    expect(result).toEqual({ ok: false, message: 'receiver 必须是非空字符串' });
  });

  it('非字符串的字段被拒', () => {
    const result = sanitizeAddressBody({ receiver: 123 });
    expect(result).toEqual({ ok: false, message: 'receiver 必须是非空字符串' });
  });

  it('isDefault 是布尔值时收下', () => {
    const result = sanitizeAddressBody({ receiver: '张三', isDefault: true });
    expect(result).toEqual({ ok: true, value: { receiver: '张三', isDefault: true } });
  });

  it('isDefault 不是布尔值时被拒', () => {
    const result = sanitizeAddressBody({ receiver: '张三', isDefault: 'yes' });
    expect(result).toEqual({ ok: false, message: 'isDefault 必须是布尔值' });
  });
});
