// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// 需要断言 router.refresh / router.push 被调用，所以把 mock 提到 hoisted 里共享引用
const { refreshMock, pushMock } = vi.hoisted(() => ({
  refreshMock: vi.fn(),
  pushMock: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshMock, push: pushMock }),
}));

import { CouponManager } from '@/components/marketing/coupon-manager';
import type { Coupon } from '@/lib/marketing';

/** 进行中的本店券 fixture（金额为整数分；秒为 0 保证元/分与 datetime-local 往返无损） */
const COUPON: Coupon = {
  id: 'coupon-1',
  code: 'SAVE10',
  name: '满100减10',
  description: null,
  type: 'FIXED',
  value: 1000,
  minAmount: 10000,
  perUserLimit: null,
  totalLimit: null,
  claimedCount: 3,
  reservedCount: 1,
  usedCount: 2,
  scope: 'SHOP',
  status: 'ACTIVE',
  startsAt: '2026-11-01T02:00:00.000Z',
  endsAt: '2026-12-01T02:00:00.000Z',
};

// 显式声明 fetch 签名：否则 vi.fn 推断成 `() => Promise<Response>`，
// mock.calls 被推断为空元组 `[]`，断言 `calls[0]` 时 tsc 直接报越界。
type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const okResponse: FetchImpl = () =>
  Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));

/** 新建表单：填满全部字段（选填也填），时间用 fireEvent.change 走 datetime-local */
async function fillCreateForm() {
  await userEvent.type(screen.getByLabelText('券码'), 'SAVE10');
  await userEvent.type(screen.getByLabelText('券名称'), '满100减10');
  await userEvent.type(screen.getByLabelText('面额（元）'), '10');
  await userEvent.type(screen.getByLabelText('使用门槛（元）'), '100');
  await userEvent.type(screen.getByLabelText('每用户限领张数'), '2');
  await userEvent.type(screen.getByLabelText('总发放上限'), '5');
  await userEvent.type(screen.getByLabelText('券说明'), '测试说明');
  fireEvent.change(screen.getByLabelText('生效开始时间'), {
    target: { value: '2026-11-20T10:00' },
  });
  fireEvent.change(screen.getByLabelText('生效结束时间'), {
    target: { value: '2026-11-30T23:59' },
  });
}

beforeEach(() => {
  refreshMock.mockClear();
  pushMock.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('优惠券管理', () => {
  it('新建优惠券：提交 POST /api/coupons，body 精确匹配（含选填字段），成功后关表单并刷新', async () => {
    const fetchMock = vi.fn(okResponse);
    vi.stubGlobal('fetch', fetchMock);

    render(<CouponManager initial={[]} page={1} pageSize={10} total={0} />);

    await userEvent.click(screen.getByText('新建优惠券'));
    await fillCreateForm();
    await userEvent.click(screen.getByText('保存'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/coupons');
    expect(options.method).toBe('POST');
    expect(options.headers).toEqual({ 'content-type': 'application/json' });
    // 金额在这里才从「元」转成「分」；空 = 不限/无门槛时键不携带
    expect(JSON.parse(options.body as string)).toEqual({
      code: 'SAVE10',
      name: '满100减10',
      value: 1000,
      minAmount: 10000,
      description: '测试说明',
      startsAt: new Date('2026-11-20T10:00').toISOString(),
      endsAt: new Date('2026-11-30T23:59').toISOString(),
      perUserLimit: 2,
      totalLimit: 5,
    });

    // 成功后表单关闭（「新建优惠券」按钮回来），并刷新服务端列表
    await waitFor(() => {
      expect(screen.getByText('新建优惠券')).toBeTruthy();
    });
    expect(screen.queryByLabelText('券码')).toBeNull();
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('新建优惠券：选填字段留空 → body 不携带 description / perUserLimit / totalLimit', async () => {
    const fetchMock = vi.fn(okResponse);
    vi.stubGlobal('fetch', fetchMock);

    render(<CouponManager initial={[]} page={1} pageSize={10} total={0} />);
    await userEvent.click(screen.getByText('新建优惠券'));
    await userEvent.type(screen.getByLabelText('券码'), 'SAVE10');
    await userEvent.type(screen.getByLabelText('券名称'), '满100减10');
    await userEvent.type(screen.getByLabelText('面额（元）'), '10');
    await userEvent.type(screen.getByLabelText('使用门槛（元）'), '100');
    fireEvent.change(screen.getByLabelText('生效开始时间'), {
      target: { value: '2026-11-20T10:00' },
    });
    fireEvent.change(screen.getByLabelText('生效结束时间'), {
      target: { value: '2026-11-30T23:59' },
    });
    await userEvent.click(screen.getByText('保存'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1]
      .body as string);
    expect(body).toEqual({
      code: 'SAVE10',
      name: '满100减10',
      value: 1000,
      minAmount: 10000,
      startsAt: new Date('2026-11-20T10:00').toISOString(),
      endsAt: new Date('2026-11-30T23:59').toISOString(),
    });
  });

  it('新建优惠券：面额非法 → 不发请求并提示文案', async () => {
    const fetchMock = vi.fn(okResponse);
    vi.stubGlobal('fetch', fetchMock);

    render(<CouponManager initial={[]} page={1} pageSize={10} total={0} />);
    await userEvent.click(screen.getByText('新建优惠券'));
    await userEvent.type(screen.getByLabelText('券码'), 'SAVE10');
    await userEvent.type(screen.getByLabelText('券名称'), '满100减10');
    await userEvent.type(screen.getByLabelText('面额（元）'), '9.999');
    await userEvent.type(screen.getByLabelText('使用门槛（元）'), '100');
    fireEvent.change(screen.getByLabelText('生效开始时间'), {
      target: { value: '2026-11-20T10:00' },
    });
    fireEvent.change(screen.getByLabelText('生效结束时间'), {
      target: { value: '2026-11-30T23:59' },
    });
    await userEvent.click(screen.getByText('保存'));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe(
      '面额必须是大于 0 的金额，最多两位小数',
    );
  });

  it('新建优惠券：服务端返回错误 → 显示 message，不刷新列表', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ message: '券码已存在' }), { status: 409 }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<CouponManager initial={[]} page={1} pageSize={10} total={0} />);
    await userEvent.click(screen.getByText('新建优惠券'));
    await fillCreateForm();
    await userEvent.click(screen.getByText('保存'));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('券码已存在');
    });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('暂停优惠券：PATCH /api/coupons/:id，body {status: PAUSED} 并刷新', async () => {
    const fetchMock = vi.fn(okResponse);
    vi.stubGlobal('fetch', fetchMock);

    render(<CouponManager initial={[COUPON]} page={1} pageSize={10} total={1} />);
    await userEvent.click(screen.getByText('暂停'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/coupons/coupon-1');
    expect(options.method).toBe('PATCH');
    expect(JSON.parse(options.body as string)).toEqual({ status: 'PAUSED' });
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('启用优惠券：PATCH /api/coupons/:id，body {status: ACTIVE}', async () => {
    const fetchMock = vi.fn(okResponse);
    vi.stubGlobal('fetch', fetchMock);

    render(
      <CouponManager
        initial={[{ ...COUPON, status: 'PAUSED' }]}
        page={1}
        pageSize={10}
        total={1}
      />,
    );
    await userEvent.click(screen.getByText('启用'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/coupons/coupon-1');
    expect(options.method).toBe('PATCH');
    expect(JSON.parse(options.body as string)).toEqual({ status: 'ACTIVE' });
  });

  it('删除优惠券：确认后 DELETE /api/coupons/:id 并刷新', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchMock = vi.fn(okResponse);
    vi.stubGlobal('fetch', fetchMock);

    render(<CouponManager initial={[COUPON]} page={1} pageSize={10} total={1} />);
    await userEvent.click(screen.getByText('删除'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/coupons/coupon-1');
    expect(options.method).toBe('DELETE');
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('删除优惠券：取消确认 → 不发请求', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const fetchMock = vi.fn(okResponse);
    vi.stubGlobal('fetch', fetchMock);

    render(<CouponManager initial={[COUPON]} page={1} pageSize={10} total={1} />);
    await userEvent.click(screen.getByText('删除'));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('翻页：第 1 页点「下一页」→ router.push 到 page=2，且「上一页」禁用', async () => {
    render(
      <CouponManager initial={[COUPON]} page={1} pageSize={10} total={25} />,
    );
    expect(screen.getByText('第 1 / 3 页')).toBeTruthy();
    expect((screen.getByText('上一页') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('下一页') as HTMLButtonElement).disabled).toBe(false);

    await userEvent.click(screen.getByText('下一页'));
    expect(pushMock).toHaveBeenCalledWith('/marketing?page=2');
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('翻页：最后一页点「上一页」→ router.push 到 page=2，且「下一页」禁用', async () => {
    render(
      <CouponManager initial={[COUPON]} page={3} pageSize={10} total={25} />,
    );
    expect(screen.getByText('第 3 / 3 页')).toBeTruthy();
    expect((screen.getByText('下一页') as HTMLButtonElement).disabled).toBe(true);

    await userEvent.click(screen.getByText('上一页'));
    expect(pushMock).toHaveBeenCalledWith('/marketing?page=2');
  });
});
