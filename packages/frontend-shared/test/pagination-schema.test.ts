/**
 * 分页响应体的形状校验（zod）。
 *
 * ⚠️ 校验的是**后端 JSON 响应**，不是用户输入；`total` 到前端时已经是 number，
 *    所以这里**不做字符串 → 数字的 coercion**（`'3'` 应当被拒，而不是悄悄变成 3）——
 *    后端哪天把 total 改成字符串，前端要立刻发现，而不是继续用着一个宽松的假设。
 *
 * ⚠️ 两个 schema 的差别只有一个：`paginatedResponse` 会**剥掉**未声明字段，
 *    `paginatedEntriesResponse` 会**保留**（`looseObject`）。用错哪一个都是线上缺陷：
 *    剥掉字段 → 页面拿不到后端新加的列；保留字段 → 该收紧的地方没收紧。
 */
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import {
  paginatedEntriesResponse,
  paginatedResponse,
} from '../src/pagination-schema';

describe('paginatedResponse（items + total）', () => {
  it('接受合法的分页响应', () => {
    expect(paginatedResponse.parse({ items: [{ id: 1 }, { id: 2 }], total: 2 })).toEqual({
      items: [{ id: 1 }, { id: 2 }],
      total: 2,
    });
  });

  it('空列表与 total = 0 合法（空页不是错误）', () => {
    expect(paginatedResponse.parse({ items: [], total: 0 })).toEqual({
      items: [],
      total: 0,
    });
  });

  it('items 的元素类型不限制（各模块自己再校验）', () => {
    const items = [1, 'a', null, { nested: true }, [1, 2]];
    expect(paginatedResponse.parse({ items, total: 5 }).items).toEqual(items);
  });

  it('⚠️ 未声明字段被剥掉（不是原样透传）', () => {
    expect(
      paginatedResponse.parse({ items: [], total: 1, page: 1, pageSize: 20 }),
    ).toEqual({ items: [], total: 1 });
  });

  it('total 必须是整数、非负', () => {
    expect(paginatedResponse.parse({ items: [], total: 3.0 }).total).toBe(3);

    for (const total of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => paginatedResponse.parse({ items: [], total })).toThrow(ZodError);
    }
  });

  it('⚠️ total 是字符串就拒绝（不做 coercion）', () => {
    const result = paginatedResponse.safeParse({ items: [], total: '3' });

    expect(result.success).toBe(false);
  });

  it('items 不是数组 / 缺字段 → 拒绝', () => {
    expect(() => paginatedResponse.parse({ items: {}, total: 0 })).toThrow(ZodError);
    expect(() => paginatedResponse.parse({ total: 0 })).toThrow(ZodError);
    expect(() => paginatedResponse.parse({ items: [] })).toThrow(ZodError);
  });

  it('null / 非对象 → 拒绝', () => {
    expect(() => paginatedResponse.parse(null)).toThrow(ZodError);
    expect(() => paginatedResponse.parse([])).toThrow(ZodError);
    expect(() => paginatedResponse.parse('{"items":[],"total":0}')).toThrow(ZodError);
  });
});

describe('paginatedEntriesResponse（entries + total，保留其它字段）', () => {
  it('接受 entries + total', () => {
    expect(paginatedEntriesResponse.parse({ entries: [{ id: 'a' }], total: 1 })).toEqual({
      entries: [{ id: 'a' }],
      total: 1,
    });
  });

  it('⚠️ 未声明字段被保留（与 paginatedResponse 相反）', () => {
    expect(
      paginatedEntriesResponse.parse({
        entries: [],
        total: 0,
        summary: { pending: 0 },
        page: 2,
      }),
    ).toEqual({ entries: [], total: 0, summary: { pending: 0 }, page: 2 });
  });

  it('total 仍然必须是整数、非负，字符串同样拒绝', () => {
    expect(() => paginatedEntriesResponse.parse({ entries: [], total: -1 })).toThrow(ZodError);
    expect(() => paginatedEntriesResponse.parse({ entries: [], total: 2.5 })).toThrow(ZodError);
    expect(paginatedEntriesResponse.safeParse({ entries: [], total: '2' }).success).toBe(false);
  });

  it('entries 不是数组 / 缺字段 → 拒绝', () => {
    expect(() => paginatedEntriesResponse.parse({ entries: null, total: 0 })).toThrow(ZodError);
    expect(() => paginatedEntriesResponse.parse({ items: [], total: 0 })).toThrow(ZodError);
    expect(() => paginatedEntriesResponse.parse({ entries: [] })).toThrow(ZodError);
  });
});
