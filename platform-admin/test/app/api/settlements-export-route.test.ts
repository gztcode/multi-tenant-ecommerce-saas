import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn() }));
vi.mock('@/lib/api-client', () => ({
  API_BASE_URL: 'http://api.test/api/v1',
}));

import { auth } from '@/auth';
import { GET } from '@/app/api/billing/settlements/export/route';

const authMock = vi.mocked(auth);

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('结算单 CSV 导出中转', () => {
  it('未登录 → 401 且不请求后端', async () => {
    authMock.mockResolvedValue(null as never);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await GET(
      new Request('http://localhost/api/billing/settlements/export'),
    );

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('非法周期 → 400 且不请求后端', async () => {
    authMock.mockResolvedValue({ accessToken: 'token' } as never);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await GET(
      new Request(
        'http://localhost/api/billing/settlements/export?period=2026-13',
      ),
    );

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('转发 Bearer 并把 text/csv 原样返回', async () => {
    authMock.mockResolvedValue({ accessToken: 'token' } as never);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('结算单号,商家\r\n', {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="settlements-2026-10.csv"',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await GET(
      new Request(
        'http://localhost/api/billing/settlements/export?period=2026-10',
      ),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/api/v1/platform/settlements/export?period=2026-10',
      { headers: { authorization: 'Bearer token' } },
    );
    expect(response.headers.get('content-type')).toBe(
      'text/csv; charset=utf-8',
    );
    expect(await response.text()).toContain('结算单号');
  });
});
