/**
 * `pickClientIp`：三端 BFF 取真实客户端 IP 的唯一实现。
 *
 * ⚠️ 只取 XFF **最右**一项（网关追加的真实对端）；取最左等于把限流的
 *    钥匙交给客户端。取不到 / 形状不合法一律 null（调用方不发头）。
 */
import { describe, expect, it } from 'vitest';

import { IP_SHAPE, clientIpFromRequest, pickClientIp } from '../src/client-ip';

describe('pickClientIp', () => {
  it('没有头 → null', () => {
    expect(pickClientIp(null)).toBeNull();
    expect(pickClientIp(undefined)).toBeNull();
  });

  it('空白 → null（不发空串）', () => {
    expect(pickClientIp('')).toBeNull();
    expect(pickClientIp('   ')).toBeNull();
    expect(pickClientIp(' , , ')).toBeNull();
  });

  it('单值 → 原样返回（含 trim）', () => {
    expect(pickClientIp('203.0.113.7')).toBe('203.0.113.7');
    expect(pickClientIp('  203.0.113.7  ')).toBe('203.0.113.7');
  });

  it('多值 → 只取最右一项', () => {
    expect(pickClientIp('198.51.100.1, 198.51.100.2, 203.0.113.7')).toBe(
      '203.0.113.7',
    );
    expect(pickClientIp('198.51.100.1,  203.0.113.7 ')).toBe('203.0.113.7');
  });

  it('最右一项形状不合法 → null', () => {
    expect(pickClientIp('198.51.100.1, not-an-ip')).toBeNull();
    expect(pickClientIp('198.51.100.1, 1.2.3.4\r\nx-evil: 1')).toBeNull();
  });

  it('IP_SHAPE 允许 IPv6 与 IPv4', () => {
    expect(IP_SHAPE.test('2001:db8::1')).toBe(true);
    expect(IP_SHAPE.test('203.0.113.7')).toBe(true);
    expect(IP_SHAPE.test('; rm -rf /')).toBe(false);
  });
});

describe('clientIpFromRequest', () => {
  function request(xff?: string): Request {
    return new Request('https://admin.example.com/api/auth/callback/credentials', {
      headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
    });
  }

  it('没有入站请求 → null', () => {
    expect(clientIpFromRequest(undefined)).toBeNull();
    expect(clientIpFromRequest(null)).toBeNull();
  });

  it('请求没有 x-forwarded-for → null', () => {
    expect(clientIpFromRequest(request())).toBeNull();
  });

  it('单值 → 原样返回', () => {
    expect(clientIpFromRequest(request('203.0.113.7'))).toBe('203.0.113.7');
  });

  it('多值 → 只取最右一项并 trim（不拼整串）', () => {
    expect(
      clientIpFromRequest(request('198.51.100.1, 198.51.100.2, 203.0.113.7')),
    ).toBe('203.0.113.7');
  });

  it('空白 → null（不发空串）', () => {
    expect(clientIpFromRequest(request('  '))).toBeNull();
  });

  it('读头抛错 → null，不冒泡', () => {
    const broken = {
      headers: {
        get() {
          throw new Error('headers 不可用');
        },
      },
    } as unknown as Request;

    expect(clientIpFromRequest(broken)).toBeNull();
  });
});
