/**
 * 对账批量确认中转路由：**请求体白名单重建**（阶段 6a Task 7）。
 *
 * 断言的是 apiFetch 收到的**完整 body** —— 不是「某字段不在」，
 * 而是「后端收到的 body 就正好是白名单里的那几个键，多一个都没有」。
 *
 * 锁住四件容易改错的事：
 * 1. 未知字段（`tenantId` / `reconciliationId` / 后端将来新增的字段）一律丢弃；
 * 2. `IDS` 超过 200 条 → 400 且**不调后端**；`itemIds` 去重后才转发；
 * 3. `mode` 非法 / 缺失 → 400 且不调后端；
 * 4. `FILTER` 只放行 `cursor` / `limit`，夹进来的 `itemIds` 被丢弃。
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
import { POST } from '@/app/api/billing/reconciliations/[id]/items/batch-confirm/route';

import { postRequest, TEST_SESSION } from './helpers/route-harness';

const authMock = vi.mocked(auth);
const apiFetchMock = vi.mocked(apiFetch);

const RECONCILIATION_ID = '11111111-1111-4111-8111-111111111111';

/** 造一个 v4 UUID（`IsUUID('4')` 只认版本位与变体位） */
function uuid(n: number): string {
  const tail = String(n).padStart(12, '0');
  return `aaaaaaaa-aaaa-4aaa-8aaa-${tail}`;
}

/** 调路由的便捷入口 */
function call(body: unknown): Promise<Response> {
  return POST(
    postRequest(
      `http://localhost/api/billing/reconciliations/${RECONCILIATION_ID}/items/batch-confirm`,
      body,
    ),
    { params: Promise.resolve({ id: RECONCILIATION_ID }) },
  );
}

const OK_RESULT = { succeeded: [], failed: [], nextCursor: null };

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue(TEST_SESSION as never);
  apiFetchMock.mockResolvedValue(OK_RESULT as never);
});

describe('批量确认中转：请求体白名单', () => {
  it('IDS：只发 { mode, itemIds, note }，未知字段全部丢弃', async () => {
    const response = await call({
      mode: 'IDS',
      itemIds: [uuid(1), uuid(2)],
      note: '运营核对后确认',
      tenantId: 'other-tenant',
      reconciliationId: 'other-rec',
      source: 'API',
      extra: true,
    });

    expect(response.status).toBe(200);
    expect(apiFetchMock).toHaveBeenCalledWith(
      `/platform/payout-reconciliations/${RECONCILIATION_ID}/items/batch-confirm`,
      {
        method: 'POST',
        body: {
          mode: 'IDS',
          itemIds: [uuid(1), uuid(2)],
          note: '运营核对后确认',
        },
        token: TEST_SESSION.accessToken,
      },
    );
  });

  it('IDS：重复的 itemIds 去重后才转发', async () => {
    await call({
      mode: 'IDS',
      itemIds: [uuid(1), uuid(1), uuid(2), uuid(2)],
      note: '去重',
    });

    const [, options] = apiFetchMock.mock.calls[0];
    expect(options?.body).toEqual({
      mode: 'IDS',
      itemIds: [uuid(1), uuid(2)],
      note: '去重',
    });
  });

  it('FILTER：只发 { mode, cursor, limit, note }，夹带的 itemIds 被丢弃', async () => {
    await call({
      mode: 'FILTER',
      cursor: uuid(9),
      limit: 50,
      note: '全选确认',
      itemIds: [uuid(1)],
      tenantId: 'x',
    });

    const [, options] = apiFetchMock.mock.calls[0];
    expect(options?.body).toEqual({
      mode: 'FILTER',
      cursor: uuid(9),
      limit: 50,
      note: '全选确认',
    });
  });

  it('FILTER：不传 cursor / limit 时 body 里不带这两个键（后端用默认值）', async () => {
    await call({ mode: 'FILTER', note: '第一批' });

    const [, options] = apiFetchMock.mock.calls[0];
    expect(options?.body).toEqual({ mode: 'FILTER', note: '第一批' });
  });

  it('成功时把后端的响应透传给浏览器', async () => {
    const result = {
      succeeded: [uuid(1)],
      failed: [{ id: uuid(2), message: '该差异项已被处置' }],
      nextCursor: uuid(3),
    };
    apiFetchMock.mockResolvedValue(result as never);

    const response = await call({
      mode: 'IDS',
      itemIds: [uuid(1), uuid(2)],
      note: '部分成功',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
  });
});

describe('批量确认中转：非法请求 → 400 且不调后端', () => {
  it('IDS 超过 200 条 → 400', async () => {
    const itemIds = Array.from({ length: 201 }, (_, i) => uuid(i + 1));

    const response = await call({ mode: 'IDS', itemIds, note: '超限' });

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('IDS 刚好 200 条 → 放行', async () => {
    const itemIds = Array.from({ length: 200 }, (_, i) => uuid(i + 1));

    const response = await call({ mode: 'IDS', itemIds, note: '刚好上限' });

    expect(response.status).toBe(200);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it('IDS：itemIds 里有非字符串 → 400', async () => {
    const response = await call({
      mode: 'IDS',
      itemIds: [uuid(1), 42],
      note: '脏数据',
    });

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('IDS：itemIds 不是数组 / 为空 → 400', async () => {
    for (const itemIds of ['not-an-array', [], undefined]) {
      vi.clearAllMocks();
      authMock.mockResolvedValue(TEST_SESSION as never);
      const response = await call({ mode: 'IDS', itemIds, note: '缺清单' });
      expect(response.status).toBe(400);
      expect(apiFetchMock).not.toHaveBeenCalled();
    }
  });

  it('mode 非法 → 400', async () => {
    for (const mode of ['ALL', 'ids', '', 1, null, undefined]) {
      vi.clearAllMocks();
      authMock.mockResolvedValue(TEST_SESSION as never);
      const response = await call({ mode, note: '模式不对' });
      expect(response.status).toBe(400);
      expect(apiFetchMock).not.toHaveBeenCalled();
    }
  });

  it('note 缺失 / 空 / 超 200 字 → 400', async () => {
    for (const note of [undefined, '', '   ', 'n'.repeat(201)]) {
      vi.clearAllMocks();
      authMock.mockResolvedValue(TEST_SESSION as never);
      const response = await call({ mode: 'FILTER', note });
      expect(response.status).toBe(400);
      expect(apiFetchMock).not.toHaveBeenCalled();
    }
  });

  it('FILTER：limit 超出 1–200 → 400；cursor 不是 UUID → 400', async () => {
    for (const body of [
      { mode: 'FILTER', limit: 0, note: 'x' },
      { mode: 'FILTER', limit: 201, note: 'x' },
      { mode: 'FILTER', cursor: 'not-a-uuid', note: 'x' },
    ]) {
      vi.clearAllMocks();
      authMock.mockResolvedValue(TEST_SESSION as never);
      const response = await call(body);
      expect(response.status).toBe(400);
      expect(apiFetchMock).not.toHaveBeenCalled();
    }
  });

  it('请求体不是 JSON 对象 → 400', async () => {
    for (const payload of ['not-json', ['a'], 'string', null]) {
      vi.clearAllMocks();
      authMock.mockResolvedValue(TEST_SESSION as never);
      const response = await call(payload);
      expect(response.status).toBe(400);
      expect(apiFetchMock).not.toHaveBeenCalled();
    }
  });
});

describe('批量确认中转：未登录不碰后端', () => {
  it('POST → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await call({
      mode: 'FILTER',
      note: '未登录',
    });

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
