// @vitest-environment jsdom
/**
 * 订阅面板（客户端组件）的换套餐交互。
 *
 * ⚠️ **后端自 2026-11-27 起换套餐立即生效**（`changePlan()` 同一事务切
 * `planId`、重置周期起点、清空 `pendingPlanId`）：界面上任何「下个周期生效」
 * 「已预约」的说法都是错的，会把商家误导成「现在切了也不影响本周期」。
 *
 * 这里钉住三件事：
 * 1. 点击换套餐必须二次确认，且确认文案写清「立即生效 / 剩余天数作废 /
 *    不折算不退款 / 新周期从今天起算 N 天」（N 取目标套餐的 `periodDays`）；
 * 2. 取消确认不发请求；
 * 3. 历史数据里残留的 `pendingPlanId` 不再渲染「已预约切换」这类死分支。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

import { SubscriptionPanel } from '@/app/(dashboard)/billing/subscription-panel';
import type { Plan, Subscription } from '@/lib/billing';

const BASE_PLAN: Plan = {
  id: 'plan-basic',
  code: 'BASIC',
  name: '基础版',
  description: null,
  price: 9900,
  periodDays: 30,
  trialDays: 0,
  commissionBps: 500,
  maxProducts: 100,
  maxSkus: 500,
  maxStores: 1,
  features: {},
  status: 'ACTIVE',
  sortOrder: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

const PRO_PLAN: Plan = {
  ...BASE_PLAN,
  id: 'plan-pro',
  code: 'PRO',
  name: '专业版',
  price: 29900,
  periodDays: 60,
  sortOrder: 2,
};

const SUBSCRIPTION: Subscription = {
  id: 'sub-1',
  tenantId: 'tenant-1',
  planId: 'plan-basic',
  pendingPlanId: null,
  status: 'ACTIVE',
  startedAt: '2026-10-01T00:00:00.000Z',
  trialEndsAt: null,
  currentPeriodStart: '2026-10-01T00:00:00.000Z',
  currentPeriodEnd: '2026-10-31T00:00:00.000Z',
  cancelAtPeriodEnd: false,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

function renderPanel(subscription: Subscription = SUBSCRIPTION) {
  return render(
    <SubscriptionPanel
      plans={[BASE_PLAN, PRO_PLAN]}
      subscription={subscription}
      invoices={[]}
      paymentMethods={[]}
      errors={{}}
    />,
  );
}

/** 切到「套餐」标签页 */
function openPlansTab() {
  fireEvent.click(screen.getByRole('button', { name: '套餐' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('confirm', vi.fn(() => true));
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }),
  );
});

describe('订阅面板：换套餐的二次确认', () => {
  it('确认文案写明立即生效、剩余天数作废、不折算不退款，且带上目标套餐的周期天数', () => {
    renderPanel();
    openPlansTab();

    fireEvent.click(screen.getByRole('button', { name: '切换到这个套餐' }));

    const confirmMock = vi.mocked(globalThis.confirm);
    expect(confirmMock).toHaveBeenCalledTimes(1);
    const message = String(confirmMock.mock.calls[0][0]);
    expect(message).toContain('专业版');
    expect(message).toContain('立即生效');
    expect(message).toContain('剩余天数作废');
    expect(message).toContain('不折算');
    expect(message).toContain('不退款');
    // ⚠️ **N 取自目标套餐的 periodDays（60），不是当前套餐的 30**
    expect(message).toContain('60 天');
  });

  it('取消确认时不发请求', () => {
    vi.mocked(globalThis.confirm).mockReturnValue(false);
    renderPanel();
    openPlansTab();

    fireEvent.click(screen.getByRole('button', { name: '切换到这个套餐' }));

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('确认后走 PATCH，成功提示说明已立即生效', async () => {
    renderPanel();
    openPlansTab();

    fireEvent.click(screen.getByRole('button', { name: '切换到这个套餐' }));

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    const [url, options] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(url).toBe('/api/billing/subscription');
    expect(options?.method).toBe('PATCH');
    expect(JSON.parse(String(options?.body))).toEqual({ planId: 'plan-pro' });

    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('立即生效');
    // ⚠️ **不能再出现「预约 / 本周期结束后生效」这类旧语义**
    expect(status.textContent).not.toContain('预约');
    expect(status.textContent).not.toContain('本周期结束后');
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
  });
});

describe('订阅面板：历史 pendingPlanId 的死分支', () => {
  it('不再显示「已预约」提示，且该套餐按钮是「切换到这个套餐」而不是「已预约切换」', () => {
    renderPanel({ ...SUBSCRIPTION, pendingPlanId: 'plan-pro' });

    // 当前订阅块不再显示「已预约切换」
    expect(screen.queryByText(/已预约/)).toBeNull();

    openPlansTab();
    expect(
      screen.getByRole('button', { name: '切换到这个套餐' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '已预约切换' })).toBeNull();
  });
});
