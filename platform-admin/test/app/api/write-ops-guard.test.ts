/**
 * 平台超管后台的**写操作**中转路由护栏（审计 §九「三端 BFF 路由系统扫描」）。
 *
 * 这些路由已逐个读源码确认合规（无 body 透传缺陷），本文件是**钉子**——
 * 钉住三个护栏：
 * 1. 未登录 → 401 且不调后端（`apiFetch` 不被调用）。
 * 2. 已登录 → 打到正确的后端路径 + method。
 * 3. 读 body 的路由 → `toEqual` 完整 body（后端收到的 body 就正好是
 *    白名单那几个键，多一个都没有；不是断言「某个字段不在」）。
 *
 * 覆盖的路由（每条约对应一个后端目标）：
 * - billing/payouts/[id]/approve、confirm-paid、reject、retry、unstick
 * - billing/reconciliations、[id]/items/[itemId]/resolve、
 *   [id]/items/batch-confirm
 * - billing/settlements、[id]/confirm、[id]/recalculate、[id]/unconfirm
 * - settings/payout-channel
 * - tenants/[id]/status
 *
 * ⚠️ `billing/plans/[id]`（PATCH / DELETE）**不在这里**：它已由
 * `billing-whitelist.test.ts` 完整覆盖（路径、method、401、白名单、非法值），
 * 不重复。
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

import { POST as approvePayoutPost } from '@/app/api/billing/payouts/[id]/approve/route';
import { POST as confirmPaidPayoutPost } from '@/app/api/billing/payouts/[id]/confirm-paid/route';
import { POST as rejectPayoutPost } from '@/app/api/billing/payouts/[id]/reject/route';
import { POST as retryPayoutPost } from '@/app/api/billing/payouts/[id]/retry/route';
import { POST as unstickPayoutPost } from '@/app/api/billing/payouts/[id]/unstick/route';
import { POST as resolveReconPost } from '@/app/api/billing/reconciliations/[id]/items/[itemId]/resolve/route';
import { POST as batchConfirmPost } from '@/app/api/billing/reconciliations/[id]/items/batch-confirm/route';
import { POST as createReconPost } from '@/app/api/billing/reconciliations/route';
import { POST as confirmSettlementPost } from '@/app/api/billing/settlements/[id]/confirm/route';
import { POST as recalcSettlementPost } from '@/app/api/billing/settlements/[id]/recalculate/route';
import { POST as unconfirmSettlementPost } from '@/app/api/billing/settlements/[id]/unconfirm/route';
import { POST as createSettlementPost } from '@/app/api/billing/settlements/route';
import { PUT as putPayoutChannel } from '@/app/api/settings/payout-channel/route';
import { PATCH as patchTenantStatus } from '@/app/api/tenants/[id]/status/route';

import { TEST_SESSION, postRequest } from '../../helpers/route-harness';

const authMock = vi.mocked(auth);
const apiFetchMock = vi.mocked(apiFetch);

/** 动态路由的 params（Next.js 15 里是 Promise） */
const payoutParams = Promise.resolve({ id: 'payout-1' });
const recParams = Promise.resolve({ id: 'rec-1' });
const recItemParams = Promise.resolve({ id: 'rec-1', itemId: 'item-1' });
const settleParams = Promise.resolve({ id: 'settle-1' });
const tenantParams = Promise.resolve({ id: 'tenant-1' });

/** 合法的 v4 UUID（batch-confirm 的 FILTER 游标校验用） */
const UUID_V4 = '11111111-1111-4111-8111-111111111111';
/** 合法的 UUID（settlements 的 tenantId 校验只查格式，不查版本位） */
const UUID_ANY = '11111111-1111-1111-1111-111111111111';

/** 构造任意 method 的 JSON 请求（route-harness 只给了 POST / GET）。 */
function requestWithMethod(
  method: string,
  url: string,
  body?: unknown,
): Request {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** 取 apiFetch 第 0 次调用的 body */
function sentBody(): Record<string, unknown> {
  const [, options] = apiFetchMock.mock.calls[0];
  return (options?.body ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue(TEST_SESSION as never);
  apiFetchMock.mockResolvedValue({ id: 'x' } as never);
});

// ---------------------------------------------------------------------------
// 出款审批/重试/解卡（billing/payouts/[id]/*）
// ---------------------------------------------------------------------------

describe('出款审批中转（approve）', () => {
  it('未登录 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await approvePayoutPost(
      new Request('http://localhost/api/billing/payouts/payout-1/approve', {
        method: 'POST',
      }),
      { params: payoutParams },
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('已登录 → 打到 /platform/payouts/:id/approve，POST 且不带 body', async () => {
    await approvePayoutPost(
      new Request('http://localhost/api/billing/payouts/payout-1/approve', {
        method: 'POST',
      }),
      { params: payoutParams },
    );

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/platform/payouts/payout-1/approve',
      { method: 'POST', token: TEST_SESSION.accessToken },
    );
  });
});

describe('出款人工确认已打款中转（confirm-paid）', () => {
  it('未登录 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await confirmPaidPayoutPost(
      postRequest('http://localhost/api/billing/payouts/payout-1/confirm-paid', {
        reason: '渠道已打款',
      }),
      { params: payoutParams },
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('已登录 → 打到 /platform/payout-reconciliations/payouts/:id/confirm-paid', async () => {
    await confirmPaidPayoutPost(
      postRequest('http://localhost/api/billing/payouts/payout-1/confirm-paid', {
        reason: '  渠道已打款  ',
        reconciliationId: 'rec-9',
      }),
      { params: payoutParams },
    );

    // ⚠️ 后端真实路径挂在对账控制器下，不是 /platform/payouts。
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/platform/payout-reconciliations/payouts/payout-1/confirm-paid',
      {
        method: 'POST',
        body: { reason: '渠道已打款', reconciliationId: 'rec-9' },
        token: TEST_SESSION.accessToken,
      },
    );
  });

  it('⚠️ 白名单重建：金额与未知字段不进请求体', async () => {
    await confirmPaidPayoutPost(
      postRequest('http://localhost/api/billing/payouts/payout-1/confirm-paid', {
        reason: '渠道已打款',
        reconciliationId: 'rec-9',
        amount: 99999,
        secretFlag: true,
      }),
      { params: payoutParams },
    );

    expect(sentBody()).toEqual({
      reason: '渠道已打款',
      reconciliationId: 'rec-9',
    });
  });

  it('reason 为空 → 400 且不调后端', async () => {
    const response = await confirmPaidPayoutPost(
      postRequest('http://localhost/api/billing/payouts/payout-1/confirm-paid', {
        reason: '   ',
      }),
      { params: payoutParams },
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe('出款拒绝中转（reject）', () => {
  it('未登录 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await rejectPayoutPost(
      postRequest('http://localhost/api/billing/payouts/payout-1/reject', {
        reason: '信息有误',
      }),
      { params: payoutParams },
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('已登录 → 打到 /platform/payouts/:id/reject，body 只含 reason', async () => {
    await rejectPayoutPost(
      postRequest('http://localhost/api/billing/payouts/payout-1/reject', {
        reason: '  信息有误  ',
      }),
      { params: payoutParams },
    );

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/platform/payouts/payout-1/reject',
      {
        method: 'POST',
        body: { reason: '信息有误' },
        token: TEST_SESSION.accessToken,
      },
    );
  });

  it('⚠️ 白名单重建：金额永远不进请求体', async () => {
    await rejectPayoutPost(
      postRequest('http://localhost/api/billing/payouts/payout-1/reject', {
        reason: '信息有误',
        amount: 99999,
        status: 'PAID',
        secretFlag: true,
      }),
      { params: payoutParams },
    );

    expect(sentBody()).toEqual({ reason: '信息有误' });
  });
});

describe('出款人工重试中转（retry）', () => {
  it('未登录 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await retryPayoutPost(
      postRequest('http://localhost/api/billing/payouts/payout-1/retry', {
        reason: '银行线路恢复',
      }),
      { params: payoutParams },
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('已登录 → 打到 /platform/payouts/:id/retry，body 只含 reason', async () => {
    await retryPayoutPost(
      postRequest('http://localhost/api/billing/payouts/payout-1/retry', {
        reason: '  银行线路恢复  ',
      }),
      { params: payoutParams },
    );

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/platform/payouts/payout-1/retry',
      {
        method: 'POST',
        body: { reason: '银行线路恢复' },
        token: TEST_SESSION.accessToken,
      },
    );
  });

  it('⚠️ 白名单重建：未知字段不进请求体', async () => {
    await retryPayoutPost(
      postRequest('http://localhost/api/billing/payouts/payout-1/retry', {
        reason: '银行线路恢复',
        amount: 99999,
        secretFlag: true,
      }),
      { params: payoutParams },
    );

    expect(sentBody()).toEqual({ reason: '银行线路恢复' });
  });
});

describe('出款解除卡单中转（unstick）', () => {
  it('未登录 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await unstickPayoutPost(
      postRequest('http://localhost/api/billing/payouts/payout-1/unstick', {
        to: 'FAILED',
        reason: '银行退票',
      }),
      { params: payoutParams },
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('已登录 → 打到 /platform/payouts/:id/unstick，body 只含 to/reason', async () => {
    await unstickPayoutPost(
      postRequest('http://localhost/api/billing/payouts/payout-1/unstick', {
        to: 'FAILED',
        reason: '  银行退票  ',
      }),
      { params: payoutParams },
    );

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/platform/payouts/payout-1/unstick',
      {
        method: 'POST',
        body: { to: 'FAILED', reason: '银行退票' },
        token: TEST_SESSION.accessToken,
      },
    );
  });

  it('⚠️ 白名单重建：未知字段不进请求体', async () => {
    await unstickPayoutPost(
      postRequest('http://localhost/api/billing/payouts/payout-1/unstick', {
        to: 'APPROVED',
        reason: '回到待打款',
        amount: 99999,
        secretFlag: true,
      }),
      { params: payoutParams },
    );

    expect(sentBody()).toEqual({ to: 'APPROVED', reason: '回到待打款' });
  });

  it('to 不是 FAILED / APPROVED → 400 且不调后端', async () => {
    const response = await unstickPayoutPost(
      postRequest('http://localhost/api/billing/payouts/payout-1/unstick', {
        to: 'PENDING',
        reason: 'x',
      }),
      { params: payoutParams },
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 对账任务（billing/reconciliations）
// ---------------------------------------------------------------------------

describe('手动触发对账中转（reconciliations POST）', () => {
  it('未登录 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await createReconPost(
      postRequest('http://localhost/api/billing/reconciliations', {
        channel: 'fake-payout',
      }),
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('已登录 → 打到 /platform/payout-reconciliations，POST', async () => {
    await createReconPost(
      postRequest('http://localhost/api/billing/reconciliations', {
        channel: '  fake-payout  ',
        from: '2026-11-01',
        to: '2026-11-07',
      }),
    );

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/platform/payout-reconciliations',
      {
        method: 'POST',
        body: {
          channel: 'fake-payout',
          from: '2026-11-01',
          to: '2026-11-07',
        },
        token: TEST_SESSION.accessToken,
      },
    );
  });

  it('⚠️ 白名单重建：只有 channel/from/to，未知字段不进请求体', async () => {
    await createReconPost(
      postRequest('http://localhost/api/billing/reconciliations', {
        channel: 'fake-payout',
        from: '2026-11-01',
        to: '2026-11-07',
        tenantId: 'other-tenant',
        amount: 99999,
        secretFlag: true,
      }),
    );

    expect(sentBody()).toEqual({
      channel: 'fake-payout',
      from: '2026-11-01',
      to: '2026-11-07',
    });
  });

  it('channel 为空 → 400 且不调后端', async () => {
    const response = await createReconPost(
      postRequest('http://localhost/api/billing/reconciliations', {
        channel: '   ',
      }),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe('对账差异单条处置中转（items/[itemId]/resolve）', () => {
  it('未登录 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await resolveReconPost(
      postRequest(
        'http://localhost/api/billing/reconciliations/rec-1/items/item-1/resolve',
        { resolution: 'RESOLVED', note: '已核实' },
      ),
      { params: recItemParams },
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('已登录 → 打到 /platform/payout-reconciliations/:id/items/:itemId/resolve', async () => {
    await resolveReconPost(
      postRequest(
        'http://localhost/api/billing/reconciliations/rec-1/items/item-1/resolve',
        { resolution: 'RESOLVED', note: '  已核实  ' },
      ),
      { params: recItemParams },
    );

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/platform/payout-reconciliations/rec-1/items/item-1/resolve',
      {
        method: 'POST',
        body: { resolution: 'RESOLVED', note: '已核实' },
        token: TEST_SESSION.accessToken,
      },
    );
  });

  it('⚠️ 白名单重建：只有 resolution/note，未知字段不进请求体', async () => {
    await resolveReconPost(
      postRequest(
        'http://localhost/api/billing/reconciliations/rec-1/items/item-1/resolve',
        {
          resolution: 'IGNORED',
          note: '非本渠道流水',
          amount: 99999,
          secretFlag: true,
        },
      ),
      { params: recItemParams },
    );

    expect(sentBody()).toEqual({ resolution: 'IGNORED', note: '非本渠道流水' });
  });

  it('resolution 不是 RESOLVED / IGNORED → 400 且不调后端', async () => {
    const response = await resolveReconPost(
      postRequest(
        'http://localhost/api/billing/reconciliations/rec-1/items/item-1/resolve',
        { resolution: 'SKIP', note: 'x' },
      ),
      { params: recItemParams },
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe('对账差异批量确认中转（items/batch-confirm）', () => {
  const url =
    'http://localhost/api/billing/reconciliations/rec-1/items/batch-confirm';

  it('未登录 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await batchConfirmPost(
      postRequest(url, { mode: 'IDS', itemIds: ['a'], note: '已确认' }),
      { params: recParams },
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('IDS 模式 → 打到 /platform/payout-reconciliations/:id/items/batch-confirm', async () => {
    await batchConfirmPost(
      postRequest(url, {
        mode: 'IDS',
        itemIds: ['a', 'b'],
        note: '  已确认  ',
      }),
      { params: recParams },
    );

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/platform/payout-reconciliations/rec-1/items/batch-confirm',
      {
        method: 'POST',
        body: { mode: 'IDS', itemIds: ['a', 'b'], note: '已确认' },
        token: TEST_SESSION.accessToken,
      },
    );
  });

  it('⚠️ IDS 模式白名单重建：cursor/limit 与未知字段都不进请求体', async () => {
    await batchConfirmPost(
      postRequest(url, {
        mode: 'IDS',
        itemIds: ['a', 'b'],
        note: '已确认',
        cursor: UUID_V4,
        limit: 50,
        secretFlag: true,
      }),
      { params: recParams },
    );

    expect(sentBody()).toEqual({
      mode: 'IDS',
      itemIds: ['a', 'b'],
      note: '已确认',
    });
  });

  it('FILTER 模式 → 只放行 cursor/limit/note，itemIds 与未知字段不进请求体', async () => {
    await batchConfirmPost(
      postRequest(url, {
        mode: 'FILTER',
        cursor: UUID_V4,
        limit: 50,
        note: '已确认',
        itemIds: ['a'],
        secretFlag: true,
      }),
      { params: recParams },
    );

    expect(sentBody()).toEqual({
      mode: 'FILTER',
      cursor: UUID_V4,
      limit: 50,
      note: '已确认',
    });
  });

  it('itemIds 超过 200 条 → 400 且不调后端（重复也算超限）', async () => {
    const response = await batchConfirmPost(
      postRequest(url, {
        mode: 'IDS',
        itemIds: Array.from({ length: 201 }, (_, i) => `id-${i}`),
        note: '已确认',
      }),
      { params: recParams },
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('⚠️ IDS 先校验后去重：去重后 ≤ 200 但原值超限 → 400 且不调后端', async () => {
    // 201 条全部重复：去重后只剩 1 条，但「先校验后去重」看的是**原数组长度**。
    const response = await batchConfirmPost(
      postRequest(url, {
        mode: 'IDS',
        itemIds: Array.from({ length: 201 }, () => 'a'),
        note: '已确认',
      }),
      { params: recParams },
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('IDS 去重后转发：重复 id 只留一个', async () => {
    await batchConfirmPost(
      postRequest(url, {
        mode: 'IDS',
        itemIds: ['a', 'a', 'b'],
        note: '已确认',
      }),
      { params: recParams },
    );

    expect(sentBody()).toEqual({
      mode: 'IDS',
      itemIds: ['a', 'b'],
      note: '已确认',
    });
  });
});

// ---------------------------------------------------------------------------
// 结算单（billing/settlements）
// ---------------------------------------------------------------------------

describe('结算单确认/重算/取消确认中转（confirm / recalculate / unconfirm）', () => {
  it('confirm 未登录 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await confirmSettlementPost(
      new Request('http://localhost/api/billing/settlements/settle-1/confirm', {
        method: 'POST',
      }),
      { params: settleParams },
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('confirm 已登录 → 打到 /platform/settlements/:id/confirm，POST 且不带 body', async () => {
    await confirmSettlementPost(
      new Request('http://localhost/api/billing/settlements/settle-1/confirm', {
        method: 'POST',
      }),
      { params: settleParams },
    );

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/platform/settlements/settle-1/confirm',
      { method: 'POST', token: TEST_SESSION.accessToken },
    );
  });

  it('recalculate 未登录 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await recalcSettlementPost(
      new Request(
        'http://localhost/api/billing/settlements/settle-1/recalculate',
        { method: 'POST' },
      ),
      { params: settleParams },
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('recalculate 已登录 → 打到 /platform/settlements/:id/recalculate', async () => {
    await recalcSettlementPost(
      new Request(
        'http://localhost/api/billing/settlements/settle-1/recalculate',
        { method: 'POST' },
      ),
      { params: settleParams },
    );

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/platform/settlements/settle-1/recalculate',
      { method: 'POST', token: TEST_SESSION.accessToken },
    );
  });

  it('unconfirm 未登录 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await unconfirmSettlementPost(
      new Request('http://localhost/api/billing/settlements/settle-1/unconfirm', {
        method: 'POST',
      }),
      { params: settleParams },
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('unconfirm 已登录 → 打到 /platform/settlements/:id/unconfirm', async () => {
    await unconfirmSettlementPost(
      new Request('http://localhost/api/billing/settlements/settle-1/unconfirm', {
        method: 'POST',
      }),
      { params: settleParams },
    );

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/platform/settlements/settle-1/unconfirm',
      { method: 'POST', token: TEST_SESSION.accessToken },
    );
  });
});

describe('生成结算单中转（settlements POST）', () => {
  it('未登录 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await createSettlementPost(
      postRequest('http://localhost/api/billing/settlements', {
        period: '2026-10',
      }),
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('已登录 → 打到 /platform/settlements，POST', async () => {
    await createSettlementPost(
      postRequest('http://localhost/api/billing/settlements', {
        period: '2026-10',
        tenantId: UUID_ANY,
      }),
    );

    expect(apiFetchMock).toHaveBeenCalledWith('/platform/settlements', {
      method: 'POST',
      body: { period: '2026-10', tenantId: UUID_ANY },
      token: TEST_SESSION.accessToken,
    });
  });

  it('⚠️ 白名单重建：金额永远不在请求体里', async () => {
    await createSettlementPost(
      postRequest('http://localhost/api/billing/settlements', {
        period: '2026-10',
        amount: 99999,
        totalAmount: 99999,
        status: 'CONFIRMED',
        secretFlag: true,
      }),
    );

    expect(sentBody()).toEqual({ period: '2026-10' });
  });

  it('period 不是 YYYY-MM → 400 且不调后端', async () => {
    const response = await createSettlementPost(
      postRequest('http://localhost/api/billing/settlements', {
        period: '2026-10-01',
      }),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('tenantId 不是合法 uuid → 400 且不调后端', async () => {
    const response = await createSettlementPost(
      postRequest('http://localhost/api/billing/settlements', {
        period: '2026-10',
        tenantId: 'not-a-uuid',
      }),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 平台设置（settings/payout-channel）
// ---------------------------------------------------------------------------

describe('平台默认出款渠道中转（payout-channel PUT）', () => {
  const url = 'http://localhost/api/settings/payout-channel';

  it('未登录 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await putPayoutChannel(
      requestWithMethod('PUT', url, { channel: 'fake-payout' }),
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('已登录 → 打到 /platform/settings/payout-channel，PUT', async () => {
    await putPayoutChannel(
      requestWithMethod('PUT', url, { channel: '  fake-payout  ' }),
    );

    expect(apiFetchMock).toHaveBeenCalledWith(
      '/platform/settings/payout-channel',
      {
        method: 'PUT',
        body: { channel: 'fake-payout' },
        token: TEST_SESSION.accessToken,
      },
    );
  });

  it('⚠️ 白名单重建：只有 channel，未知字段不进请求体', async () => {
    await putPayoutChannel(
      requestWithMethod('PUT', url, {
        channel: 'fake-payout',
        tenantId: 'other-tenant',
        amount: 99999,
        secretFlag: true,
      }),
    );

    expect(sentBody()).toEqual({ channel: 'fake-payout' });
  });

  it('channel 为空 → 400 且不调后端', async () => {
    const response = await putPayoutChannel(
      requestWithMethod('PUT', url, { channel: '   ' }),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('channel 超过 40 个字符 → 400 且不调后端', async () => {
    const response = await putPayoutChannel(
      requestWithMethod('PUT', url, { channel: 'c'.repeat(41) }),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 商家状态（tenants/[id]/status）
// ---------------------------------------------------------------------------

describe('商家状态变更中转（tenants/[id]/status PATCH）', () => {
  const url = 'http://localhost/api/tenants/tenant-1/status';

  it('未登录 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await patchTenantStatus(
      requestWithMethod('PATCH', url, { status: 'ACTIVE' }),
      { params: tenantParams },
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('已登录 → 打到 /tenants/:id/status，PATCH', async () => {
    await patchTenantStatus(
      requestWithMethod('PATCH', url, { status: 'ACTIVE' }),
      { params: tenantParams },
    );

    expect(apiFetchMock).toHaveBeenCalledWith('/tenants/tenant-1/status', {
      method: 'PATCH',
      body: { status: 'ACTIVE' },
      token: TEST_SESSION.accessToken,
    });
  });

  it('⚠️ 白名单重建：只有 status，未知字段不进请求体', async () => {
    await patchTenantStatus(
      requestWithMethod('PATCH', url, {
        status: 'SUSPENDED',
        tenantId: 'other-tenant',
        amount: 99999,
        secretFlag: true,
      }),
      { params: tenantParams },
    );

    expect(sentBody()).toEqual({ status: 'SUSPENDED' });
  });

  it('status 不是 TRIAL / ACTIVE / SUSPENDED → 400 且不调后端', async () => {
    const response = await patchTenantStatus(
      requestWithMethod('PATCH', url, { status: 'PENDING' }),
      { params: tenantParams },
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
