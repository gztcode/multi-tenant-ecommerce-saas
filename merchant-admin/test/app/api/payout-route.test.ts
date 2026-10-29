/**
 * 护栏 P4 与白名单纪律：商家出款中转路由的**请求体白名单重建**。
 *
 * ⚠️ **出款是打钱**：请求体多透传一个字段，就可能意味着
 * 「商家自己决定平台打多少钱」。所以这里断言 apiFetch 收到的**完整 body**
 * —— 不是断言「某个字段不在」，而是断言「后端收到的 body 就正好是
 * 白名单里的那几个键，多一个都没有」。
 *
 * ⚠️ **后端 ValidationPipe 开了 forbidNonWhitelisted**：整体透传多传一个
 * 字段就是 400，而那种 400 在界面上只是一句没头没尾的校验失败。
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

import { GET as payoutsGet, POST as payoutsPost } from '@/app/api/merchant/payouts/route';
import { DELETE as payoutDelete } from '@/app/api/merchant/payouts/[id]/route';
import { GET as periodsGet } from '@/app/api/merchant/payouts/available-periods/route';

import {
  TEST_SESSION,
  postRequest,
} from '../../helpers/route-harness';

const authMock = vi.mocked(auth);
const apiFetchMock = vi.mocked(apiFetch);

/** 构造一个 DELETE 请求。 */
function deleteRequest(url: string): Request {
  return new Request(url, { method: 'DELETE' });
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue(TEST_SESSION as never);
  apiFetchMock.mockResolvedValue({ items: [], total: 0 } as never);
});

describe('出款中转：列表 GET', () => {
  it('打到 /merchant/payouts（商家侧，不是平台侧）', async () => {
    await payoutsGet();

    const [path, options] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/merchant/payouts');
    // ⚠️ **不传 method 就是 GET**（`apiFetch` 的缺省值），
    //    这里断言「没传」而不是断言 'GET'。
    expect(options?.method).toBeUndefined();
    expect(options?.token).toBe(TEST_SESSION.accessToken);
  });

  it('未登录 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await payoutsGet();

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe('出款中转：可申请周期 GET', () => {
  it('打到 /merchant/payouts/available-periods', async () => {
    await periodsGet();

    const [path, options] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/merchant/payouts/available-periods');
    expect(options?.token).toBe(TEST_SESSION.accessToken);
  });

  it('未登录 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await periodsGet();

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe('出款中转：申请 POST 的请求体白名单', () => {
  it('⚠️ body 里只有 period 一个键（金额绝不透传）', async () => {
    await payoutsPost(
      postRequest('http://localhost/api/merchant/payouts', {
        period: '2026-01',
        amount: 999999,
        netAmount: 999999,
        commissionAmount: 0,
        receiptAmount: 999999,
        tenantId: 'other-tenant',
        status: 'APPROVED',
      }),
    );

    const [, options] = apiFetchMock.mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    // ⚠️ **断言的是完整的键集合**：只断言「amount 不在」的话，
    //    将来有人加了个 `netAmount` 字段照样绿。
    expect(Object.keys(body).sort()).toEqual(['period']);
    expect(body.period).toBe('2026-01');
  });

  it('用 POST 方法打到 /merchant/payouts', async () => {
    await payoutsPost(
      postRequest('http://localhost/api/merchant/payouts', { period: '2026-01' }),
    );

    const [path, options] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/merchant/payouts');
    expect(options?.method).toBe('POST');
    expect(options?.token).toBe(TEST_SESSION.accessToken);
  });

  it('缺 period → 400 且不调后端', async () => {
    for (const payload of [
      {},
      { period: '' },
      { period: '   ' },
      { amount: 500 },
      { period: 202601 },
    ]) {
      const response = await payoutsPost(
        postRequest('http://localhost/api/merchant/payouts', payload),
      );

      expect(response.status).toBe(400);
    }
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('畸形请求体 → 400 且不调后端', async () => {
    for (const payload of [['a'], 'not-an-object', null]) {
      const response = await payoutsPost(
        postRequest('http://localhost/api/merchant/payouts', payload),
      );

      expect(response.status).toBe(400);
    }
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('非法 JSON → 400 且不调后端', async () => {
    const response = await payoutsPost(
      postRequest('http://localhost/api/merchant/payouts', 'not-json'),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('未登录 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await payoutsPost(
      postRequest('http://localhost/api/merchant/payouts', { period: '2026-01' }),
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe('出款中转：撤回 DELETE', () => {
  it('打到 /merchant/payouts/:id 并带 DELETE 方法', async () => {
    await payoutDelete(deleteRequest('http://localhost/api/merchant/payouts/p1'), {
      params: Promise.resolve({ id: 'p1' }),
    });

    const [path, options] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/merchant/payouts/p1');
    expect(options?.method).toBe('DELETE');
    expect(options?.token).toBe(TEST_SESSION.accessToken);
  });

  it('未登录 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await payoutDelete(
      deleteRequest('http://localhost/api/merchant/payouts/p1'),
      { params: Promise.resolve({ id: 'p1' }) },
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
