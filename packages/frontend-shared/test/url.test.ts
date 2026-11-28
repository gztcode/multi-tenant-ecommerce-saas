import { describe, expect, it } from 'vitest';

import { encodePathSegment } from '../src/url';

/**
 * `encodePathSegment` 的用例。
 *
 * 这个函数存在的唯一目的：把 Next.js 交给我们的动态段（`[id]` / `[orderNo]`）
 * 变成**一个**后端路径段。Next 会把 `%2F` 解码成 `/` 再塞进 `params`，
 * 裸拼模板串就能让 `/api/products/..%2F..%2Fbilling%2Finvoices` 变成
 * 「拿调用者令牌访问任意后端路径」。所以下面每个「危险字符」都要钉死。
 */
describe('encodePathSegment：动态路径段编码', () => {
  it('合法的 UUID / slug 原样保留（不误伤正常 id）', () => {
    expect(encodePathSegment('3f2a9c1e-8b4d-4f6a-9c2e-1d7b5a0f3e21')).toBe(
      '3f2a9c1e-8b4d-4f6a-9c2e-1d7b5a0f3e21',
    );
    expect(encodePathSegment('mens-tshirt_2026')).toBe('mens-tshirt_2026');
  });

  it('把 / 编成 %2F，路径穿越串整体只占一个段', () => {
    expect(encodePathSegment('a/b')).toBe('a%2Fb');
    expect(encodePathSegment('../../billing/invoices/INV-1')).toBe(
      '..%2F..%2Fbilling%2Finvoices%2FINV-1',
    );
    // 编码结果里不能残留裸 `/`，否则拼进 URL 后仍会被当成段分隔符
    expect(encodePathSegment('../../billing/invoices/INV-1')).not.toContain('/');
  });

  it('? 与 # 被编码，不会被当成 query / fragment 的分隔符', () => {
    expect(encodePathSegment('INV-1?x=1')).toBe('INV-1%3Fx%3D1');
    expect(encodePathSegment('INV-1#frag')).toBe('INV-1%23frag');
  });

  it('& 与 = 被编码，避免拼进查询串时改写参数', () => {
    expect(encodePathSegment('a&b=c')).toBe('a%26b%3Dc');
  });

  it('中文按 UTF-8 百分号编码', () => {
    expect(encodePathSegment('商品')).toBe('%E5%95%86%E5%93%81');
  });

  it('空格编码成 %20（不是 +，+ 在路径段里是字面量）', () => {
    expect(encodePathSegment('a b')).toBe('a%20b');
  });

  it('已编码的 %2F 不再解码：% 本身编码成 %25，不会还原成 /', () => {
    // 关键：不要先 decodeURIComponent 再编码。
    // 否则客户端传来的 `%2F` 会被还原成 `/`，编码后仍是 `%2F`——
    // 看起来「幂等」，实际把字面量 %2F 变成了路径分隔符。
    expect(encodePathSegment('%2F')).toBe('%252F');
    expect(encodePathSegment('a%2Fb')).toBe('a%252Fb');
  });

  it('空串编码后仍是空串（由调用方决定空段如何处理）', () => {
    expect(encodePathSegment('')).toBe('');
  });
});
