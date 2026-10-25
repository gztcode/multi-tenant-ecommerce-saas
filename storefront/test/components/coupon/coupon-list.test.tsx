// @vitest-environment jsdom
/**
 * 领券中心的关键行为。
 *
 * ⚠️ **断言要具体**：只断言「点得动」或「不报错」都算恒真。
 * 这里断言的是**发出去的请求体**与**界面上真的显示了什么**。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CouponList } from '@/components/coupon/coupon-list';
import type { AvailableCoupon, MyCoupon } from '@/lib/coupon';

const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const AVAILABLE: AvailableCoupon = {
  id: 'c-1',
  code: 'CODE-1',
  name: '满 100 减 10',
  description: null,
  type: 'FIXED',
  value: 1000,
  minAmount: 10000,
  totalLimit: 100,
  claimedCount: 30,
  scope: 'SHOP',
  status: 'ACTIVE',
  startsAt: '2026-01-01T00:00:00.000Z',
  endsAt: '2026-12-31T00:00:00.000Z',
};

const MINE: MyCoupon = {
  ...AVAILABLE,
  id: 'c-2',
  name: '满 200 减 50',
  value: 5000,
  minAmount: 20000,
  used: false,
  claimedQuantity: 1,
};

const NOW = '2026-06-15T00:00:00.000Z';

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('领券中心', () => {
  it('列出可领取的券，并显示剩余张数', () => {
    render(<CouponList available={[AVAILABLE]} mine={[]} now={NOW} />);

    expect(screen.getByText('满 100 减 10')).toBeTruthy();
    // 100 - 30 = 70 张
    expect(screen.getByText(/剩余 70 张/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '立即领取' })).toBeTruthy();
  });

  it('不限量的券显示「不限量」而不是「剩余 0 张」', () => {
    render(
      <CouponList
        available={[{ ...AVAILABLE, totalLimit: null, claimedCount: 37 }]}
        mine={[]}
        now={NOW}
      />,
    );

    expect(screen.getByText(/不限量/)).toBeTruthy();
    expect(screen.queryByText(/剩余/)).toBeNull();
  });

  it('领完的券不能点（按钮禁用）', () => {
    render(
      <CouponList
        available={[{ ...AVAILABLE, totalLimit: 30, claimedCount: 30 }]}
        mine={[]}
        now={NOW}
      />,
    );

    const button = screen.getByRole('button', { name: '已领完' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('点「立即领取」只把 couponId 发给中转路由', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ couponId: 'c-1' }));
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<CouponList available={[AVAILABLE]} mine={[]} now={NOW} />);

    await user.click(screen.getByRole('button', { name: '立即领取' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/coupons/claim');
    expect(init.method).toBe('POST');
    // ⚠️ **请求体里只有 couponId**：面额与门槛一律由后端从库里读，
    // 客户端算的优惠额一律不信（护栏 M1 / M2）。
    expect(JSON.parse(String(init.body))).toEqual({ couponId: 'c-1' });
  });

  it('领取成功后提示用户并刷新列表', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ couponId: 'c-1' }));
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<CouponList available={[AVAILABLE]} mine={[]} now={NOW} />);

    await user.click(screen.getByRole('button', { name: '立即领取' }));

    await waitFor(() =>
      expect(screen.getByText(/领取成功/)).toBeTruthy(),
    );
    // ⚠️ 领完之后列表变了，要让 Server Component 重新取数
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('领取失败时显示后端给的文案（不谎报成功）', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ message: '该优惠券已被领完' }, 409));
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<CouponList available={[AVAILABLE]} mine={[]} now={NOW} />);

    await user.click(screen.getByRole('button', { name: '立即领取' }));

    await waitFor(() =>
      expect(screen.getByText('该优惠券已被领完')).toBeTruthy(),
    );
    expect(screen.queryByText(/领取成功/)).toBeNull();
    // 失败不刷新列表（列表没变）
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('「我的券」页签显示每张券的状态', async () => {
    const user = userEvent.setup();
    render(
      <CouponList
        available={[]}
        mine={[
          MINE,
          { ...MINE, id: 'c-3', name: '已用掉的券', used: true },
          {
            ...MINE,
            id: 'c-4',
            name: '过期的券',
            endsAt: '2026-01-01T00:00:00.000Z',
          },
        ]}
        now={NOW}
      />,
    );

    await user.click(screen.getByRole('button', { name: /我的券/ }));

    expect(screen.getByText('可用')).toBeTruthy();
    expect(screen.getByText('已用完')).toBeTruthy();
    expect(screen.getByText('已过期')).toBeTruthy();
  });

  it('没有可领取的券时如实说「暂时没有」，不谎报', () => {
    render(<CouponList available={[]} mine={[]} now={NOW} />);

    expect(screen.getByText('暂时没有可领取的优惠券。')).toBeTruthy();
  });
});
