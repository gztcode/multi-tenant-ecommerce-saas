import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn() }));
vi.mock('@/lib/api-client', () => ({
  API_BASE_URL: 'http://api.test/api/v1',
}));

import { auth } from '@/auth';
import { POST } from '@/app/api/billing/reconciliations/import/route';

const authMock = vi.mocked(auth);

/**
 * 造一个 multipart 请求，字段集与前端表单 `import-csv-form.tsx` 实际
 * append 的一致：`file` / `columnMapping`，`channel` / `from` / `to` 仅当非空。
 * `extra` 是**前端并不发送的字段**，用于断言白名单重建会把它丢掉。
 */
function multipartRequest(
  overrides: Partial<{
    file: File | null;
    columnMapping: string | null;
    channel: string | null;
    from: string | null;
    to: string | null;
    extra: string | null;
  }> = {},
): Request {
  const formData = new FormData();
  if (overrides.file !== null) {
    formData.set(
      'file',
      overrides.file ?? new File(['a,b\n1,2'], 'bill.csv', { type: 'text/csv' }),
    );
  }
  if (overrides.columnMapping !== null) {
    formData.set(
      'columnMapping',
      overrides.columnMapping ?? JSON.stringify({ amountColumn: 'b' }),
    );
  }
  if (overrides.channel) formData.set('channel', overrides.channel);
  if (overrides.from) formData.set('from', overrides.from);
  if (overrides.to) formData.set('to', overrides.to);
  if (overrides.extra) formData.set('extra', overrides.extra);
  return new Request('http://localhost/api/billing/reconciliations/import', {
    method: 'POST',
    body: formData,
  });
}

/** 从 fetch mock 的第 index 次调用里取出转发的 FormData */
function sentFormData(
  fetchMock: ReturnType<typeof vi.fn>,
  index = 0,
): FormData {
  const init = fetchMock.mock.calls[index][1] as RequestInit;
  expect(init.body).toBeInstanceOf(FormData);
  return init.body as FormData;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('对账导入 multipart 中转', () => {
  it('未登录 → 401 且不请求后端', async () => {
    authMock.mockResolvedValue(null as never);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(multipartRequest());

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('缺文件 → 400 且不请求后端', async () => {
    authMock.mockResolvedValue({ accessToken: 'token' } as never);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(
      multipartRequest({ file: null, columnMapping: JSON.stringify({}) }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: '请上传账单文件' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('缺列映射 → 400 且不请求后端', async () => {
    authMock.mockResolvedValue({ accessToken: 'token' } as never);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(
      multipartRequest({ columnMapping: null, extra: 'x' }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: '必须指定列映射' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('列映射不是合法 JSON → 400 且不请求后端', async () => {
    authMock.mockResolvedValue({ accessToken: 'token' } as never);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(
      multipartRequest({ columnMapping: '{oops' }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: '列映射不是合法的 JSON' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('转发到后端并**重建白名单**：只放行 file/columnMapping/channel/from/to，多余字段被丢弃', async () => {
    authMock.mockResolvedValue({ accessToken: 'token' } as never);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ jobId: 'j1' }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(
      multipartRequest({
        channel: 'fake-payout',
        from: '2026-11-01',
        to: '2026-11-07',
        // ⚠️ 前端不发送的字段——必须被白名单丢掉
        extra: '不应透传',
      }),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'http://api.test/api/v1/platform/payout-reconciliations/import',
    );
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      authorization: 'Bearer token',
    });
    // ⚠️ multipart 必须让 fetch 自己带 boundary，**不设 content-type**
    expect(init.headers).not.toHaveProperty('content-type');

    const sent = sentFormData(fetchMock);
    // 白名单恰好 5 个键，extra 被丢弃
    expect(Array.from(sent.keys()).sort()).toEqual([
      'channel',
      'columnMapping',
      'file',
      'from',
      'to',
    ]);
    // 值原样保留
    expect(sent.get('channel')).toBe('fake-payout');
    expect(sent.get('from')).toBe('2026-11-01');
    expect(sent.get('to')).toBe('2026-11-07');
    expect(sent.get('file')).toBeInstanceOf(File);
    expect(JSON.parse(sent.get('columnMapping') as string)).toEqual({
      amountColumn: 'b',
    });
    expect(sent.get('extra')).toBeNull();
  });

  it('可选字段为空时不带对应键（channel/from/to 均缺省）', async () => {
    authMock.mockResolvedValue({ accessToken: 'token' } as never);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ jobId: 'j1' }));
    vi.stubGlobal('fetch', fetchMock);

    await POST(multipartRequest());

    const sent = sentFormData(fetchMock);
    expect(Array.from(sent.keys()).sort()).toEqual([
      'columnMapping',
      'file',
    ]);
  });

  it('后端失败 → 透传状态码与后端 message', async () => {
    authMock.mockResolvedValue({ accessToken: 'token' } as never);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ message: '列映射第 2 列不存在' }, 400)),
    );

    const response = await POST(multipartRequest());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: '列映射第 2 列不存在' });
  });

  it('后端返回非 JSON → 透传兜底 message', async () => {
    authMock.mockResolvedValue({ accessToken: 'token' } as never);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('bad gateway', { status: 502 })),
    );

    const response = await POST(multipartRequest());

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ message: '上传失败' });
  });
});
