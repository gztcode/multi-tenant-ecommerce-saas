/**
 * 平台设置中转路由：**请求体白名单重建**（阶段 6a Task 4）。
 *
 * 断言的是 apiFetch 收到的**完整 body** —— 不是「某字段不在」，
 * 而是「后端收到的 body 就正好是白名单里的那几个键，多一个都没有」。
 *
 * 锁住三件容易改错的事：
 * 1. 未知字段（`tenantId` / `id` / 后端将来新增的字段）一律丢弃；
 * 2. `channel` 非字符串 / 空串 / 超长 → 400 且**不调后端**；
 * 3. 未登录 → 401 且不调后端。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>(
    '@/lib/api-client',
  );
  return {
    ...actual,
    apiFetch: vi.fn(),
  };
});

import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { PUT } from '@/app/api/settings/payout-channel/route';

import { TEST_SESSION } from './helpers/route-harness';

const authMock = vi.mocked(auth);
const apiFetchMock = vi.mocked(apiFetch);

/** 构造一个 PUT 请求。body 传原始字符串以便构造非法 JSON。 */
function putRequest(url: string, body?: unknown): Request {
  return new Request(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue(TEST_SESSION as never);
  apiFetchMock.mockResolvedValue({
    channel: 'fake-payout',
    source: 'DATABASE',
  } as never);
});

describe('平台设置中转：请求体白名单', () => {
  it('只发 { channel }，未知字段全部丢弃', async () => {
    const response = await PUT(
      putRequest('http://localhost/api/settings/payout-channel', {
        channel: 'fake-payout',
        tenantId: 'other-tenant',
        id: 'row-owned-by-someone-else',
        source: 'ENV',
        secretFlag: true,
      }),
    );

    expect(response.status).toBe(200);
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/platform/settings/payout-channel',
      {
        method: 'PUT',
        body: { channel: 'fake-payout' },
        token: TEST_SESSION.accessToken,
      },
    );
  });

  it('channel 两端的空白会被 trim', async () => {
    await PUT(
      putRequest('http://localhost/api/settings/payout-channel', {
        channel: '  fake-payout  ',
      }),
    );

    const [, options] = apiFetchMock.mock.calls[0];
    expect(options?.body).toEqual({ channel: 'fake-payout' });
  });

  it('成功时把后端的响应透传给浏览器', async () => {
    const response = await PUT(
      putRequest('http://localhost/api/settings/payout-channel', {
        channel: 'fake-payout',
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      channel: 'fake-payout',
      source: 'DATABASE',
    });
  });
});

describe('平台设置中转：非法 channel → 400 且不调后端', () => {
  const invalid: Array<[string, unknown]> = [
    ['数字', 123],
    ['null', null],
    ['布尔', true],
    ['对象', { value: 'fake-payout' }],
    ['数组', ['fake-payout']],
    ['空串', ''],
    ['纯空白', '   '],
    ['超过 40 个字符', 'c'.repeat(41)],
  ];

  for (const [label, channel] of invalid) {
    it(`${label} → 400，且不调后端`, async () => {
      const response = await PUT(
        putRequest('http://localhost/api/settings/payout-channel', {
          channel,
        }),
      );

      expect(response.status).toBe(400);
      expect(apiFetchMock).not.toHaveBeenCalled();
    });
  }

  it('缺 channel 字段 → 400，且不调后端', async () => {
    const response = await PUT(
      putRequest('http://localhost/api/settings/payout-channel', {}),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('刚好 40 个字符 → 放行', async () => {
    const response = await PUT(
      putRequest('http://localhost/api/settings/payout-channel', {
        channel: 'c'.repeat(40),
      }),
    );

    expect(response.status).toBe(200);
  });
});

describe('平台设置中转：畸形请求体 → 400 且不调后端', () => {
  const malformed: Array<[string, unknown]> = [
    ['数组', ['a']],
    ['字符串', 'not-an-object'],
    ['null', null],
    ['非法 JSON', 'not-json'],
  ];

  for (const [label, payload] of malformed) {
    it(`${label} → 400，且不调后端`, async () => {
      const response = await PUT(
        putRequest('http://localhost/api/settings/payout-channel', payload),
      );

      expect(response.status).toBe(400);
      expect(apiFetchMock).not.toHaveBeenCalled();
    });
  }
});

describe('平台设置中转：未登录不碰后端', () => {
  it('PUT → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await PUT(
      putRequest('http://localhost/api/settings/payout-channel', {
        channel: 'fake-payout',
      }),
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
