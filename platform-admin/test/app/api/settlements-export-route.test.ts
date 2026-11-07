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

  it('转发 Bearer 并能补回被 text() 剥掉的 BOM', async () => {
    authMock.mockResolvedValue({ accessToken: 'token' } as never);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('\uFEFF结算单号,商家\r\n', {
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
    // 上游 CSV 的 BOM 被 text() 剥掉后，必须在 BFF 侧补回来。
    // 注意 response.text() 同样会剥掉 BOM，只能按原始字节断言。
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    // 且**只能有一个** BOM：只断言前 3 字节发现不了 `EF BB BF EF BB BF`，
    // 因为 TextDecoder 也会剥掉首个 BOM，后面的 toContain 照样通过。
    expect(Array.from(bytes.slice(3, 6))).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes[3]).toBe(0xe7); // 「结」的 UTF-8 首字节
    expect(new TextDecoder().decode(bytes)).toContain('结算单号');
  });
});
