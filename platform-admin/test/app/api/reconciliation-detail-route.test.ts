/**
 * 对账详情中转路由（`GET /api/billing/reconciliations/:id`）的筛选白名单。
 *
 * ⚠️ **只转发 `severity` / `resolution` / `type`** —— 其余 query 全部丢弃，
 *    不做原样透传。后端开了 `forbidNonWhitelisted`，透传多余参数就是 400。
 * ⚠️ **非法值当场 400、不打后端** —— 与 `settlements/export` 同一套做法：
 *    值的合法范围前端自己知道（`@/lib/reconciliation`），
 *    没必要让后端来回一趟才发现。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn() }));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>(
    '@/lib/api-client',
  );
  return { ...actual, apiFetch: vi.fn() };
});

import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { GET } from '@/app/api/billing/reconciliations/[id]/route';

import { TEST_SESSION, getRequest, readJson } from '../../helpers/route-harness';

const authMock = vi.mocked(auth);
const apiFetchMock = vi.mocked(apiFetch);
const params = Promise.resolve({ id: 'rec-1' });

beforeEach(() => {
  vi.clearAllMocks();
  apiFetchMock.mockResolvedValue({ id: 'rec-1', items: [] });
});

describe('对账详情中转的筛选参数', () => {
  it('未登录 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await GET(
      getRequest('http://localhost/api/billing/reconciliations/rec-1'),
      { params },
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('无筛选参数 → 路径不带问号（行为与改造前逐字一致）', async () => {
    authMock.mockResolvedValue(TEST_SESSION as never);

    const response = await GET(
      getRequest('http://localhost/api/billing/reconciliations/rec-1'),
      { params },
    );

    expect(response.status).toBe(200);
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/platform/payout-reconciliations/rec-1',
      { token: TEST_SESSION.accessToken },
    );
  });

  it('三个筛选参数按白名单转发，未知参数一律丢弃', async () => {
    authMock.mockResolvedValue(TEST_SESSION as never);

    const response = await GET(
      getRequest(
        'http://localhost/api/billing/reconciliations/rec-1' +
          '?severity=CRITICAL&resolution=PENDING&type=AMOUNT_MISMATCH' +
          '&pageSize=9999&tenantId=other',
      ),
      { params },
    );

    expect(response.status).toBe(200);
    // ⚠️ **完整字符串断言** —— 只断言「不含 pageSize」抓不到顺序错、
    //    也抓不到多转发一个白名单外的键
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/platform/payout-reconciliations/rec-1' +
        '?severity=CRITICAL&resolution=PENDING&type=AMOUNT_MISMATCH',
      { token: TEST_SESSION.accessToken },
    );
  });

  it('空串视为没选（GET 表单会带上空的 select）', async () => {
    authMock.mockResolvedValue(TEST_SESSION as never);

    await GET(
      getRequest(
        'http://localhost/api/billing/reconciliations/rec-1' +
          '?severity=&resolution=&type=',
      ),
      { params },
    );

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/platform/payout-reconciliations/rec-1',
      { token: TEST_SESSION.accessToken },
    );
  });

  it.each([
    ['severity', 'BOGUS'],
    ['resolution', 'DONE'],
    ['type', 'SOMETHING_ELSE'],
  ])('非法 %s=%s → 400 且不打后端', async (key, value) => {
    authMock.mockResolvedValue(TEST_SESSION as never);

    const response = await GET(
      getRequest(
        `http://localhost/api/billing/reconciliations/rec-1?${key}=${value}`,
      ),
      { params },
    );

    expect(response.status).toBe(400);
    const body = await readJson(response);
    expect(String(body.message)).toContain(key);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
