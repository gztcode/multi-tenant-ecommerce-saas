/**
 * 租户子域名解析的单测。
 *
 * ⚠️ 为什么单独测它：中转路由的测试（`test/app/api/theme.test.ts`）把
 * `currentSubdomain` 整个 mock 掉了，所以**租户解析那一层根本没被测到**。
 * 匿名访客靠子域名定位租户——解析错了就是「串店」，必须有自己的测试。
 */
import { describe, expect, it } from 'vitest';

import { resolveTenantSubdomain } from '@/lib/tenant';

function headersOf(map: Record<string, string>): Headers {
  return new Headers(map);
}

describe('resolveTenantSubdomain', () => {
  it('优先用 x-tenant-subdomain 请求头（网关注入，客户端设的不可信）', () => {
    const result = resolveTenantSubdomain(
      headersOf({
        'x-tenant-subdomain': '  Shop-A ',
        host: 'other.example.com',
      }),
    );

    expect(result).toBe('shop-a');
  });

  it('没有该请求头时取 host 的第一段', () => {
    const result = resolveTenantSubdomain(
      headersOf({ host: 'demo.example.com' }),
    );

    expect(result).toBe('demo');
  });

  it('host 是 localhost / 裸 IP 时退回兜底值', () => {
    expect(
      resolveTenantSubdomain(headersOf({ host: 'localhost:3000' })),
    ).toBe('demo');
    expect(
      resolveTenantSubdomain(headersOf({ host: '127.0.0.1:3000' })),
    ).toBe('demo');
  });
});
