/**
 * 护栏：platform-admin 中转路由的动态段必须整体编码成一个后端路径段。
 *
 * 同 merchant-admin 的 `dynamic-segment-encoding.test.ts`：
 * Next.js 会把 `%2F` 解码后交给 `params`，裸拼模板串就能让 BFF
 * 拿超管令牌访问任意后端路径。这里覆盖单段、双段与「正常 id 不被误伤」。
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

import { POST as payoutApprove } from '@/app/api/billing/payouts/[id]/approve/route';
import { POST as resolveItem } from '@/app/api/billing/reconciliations/[id]/items/[itemId]/resolve/route';

const authMock = vi.mocked(auth);
const apiFetchMock = vi.mocked(apiFetch);

const TEST_SESSION = { accessToken: 'token-test', role: 'PLATFORM' } as const;

/** 攻击者可控的动态段：解码后带路径穿越 */
const NASTY = '../../billing/invoices/INV-1';

function sentPath(): string {
  return apiFetchMock.mock.calls[0][0] as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue(TEST_SESSION as never);
  apiFetchMock.mockResolvedValue({ id: 'x' } as never);
});

describe('动态段编码：platform-admin 中转路由', () => {
  it('POST /api/billing/payouts/[id]/approve 把穿越串编码成单段', async () => {
    const response = await payoutApprove(
      new Request('http://localhost/api/billing/payouts/nasty/approve', {
        method: 'POST',
      }),
      { params: Promise.resolve({ id: NASTY }) },
    );

    expect(response.status).toBe(200);
    expect(sentPath()).toBe(
      '/platform/payouts/..%2F..%2Fbilling%2Finvoices%2FINV-1/approve',
    );
    expect(sentPath()).not.toContain('/billing');
  });

  it('双动态段：两段各自编码，固定段 items / resolve 不编码', async () => {
    const response = await resolveItem(
      new Request('http://localhost/api/billing/reconciliations/n/items/i/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resolution: 'RESOLVED', note: '已人工核对' }),
      }),
      {
        params: Promise.resolve({
          id: '../../platform/settlements',
          itemId: '../..',
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(sentPath()).toBe(
      '/platform/payout-reconciliations/..%2F..%2Fplatform%2Fsettlements/items/..%2F../resolve',
    );
    expect(sentPath()).not.toContain('/platform/settlements');
  });

  it('正常 id 原样保留（编码不能误伤合法值）', async () => {
    await payoutApprove(
      new Request('http://localhost/api/billing/payouts/abc/approve', {
        method: 'POST',
      }),
      { params: Promise.resolve({ id: '3f2a9c1e-8b4d-4f6a-9c2e-1d7b5a0f3e21' }) },
    );

    expect(sentPath()).toBe(
      '/platform/payouts/3f2a9c1e-8b4d-4f6a-9c2e-1d7b5a0f3e21/approve',
    );
  });
});
