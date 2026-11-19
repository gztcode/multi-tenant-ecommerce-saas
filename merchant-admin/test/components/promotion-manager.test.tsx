// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// 需要能断言 router.refresh 被调用，所以把 mock 提到 hoisted 里共享引用
const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

import { PromotionManager } from '@/components/marketing/promotion-manager';
import type { Promotion } from '@/lib/marketing';

/** ACTIVE 活动 fixture（description 为 null → 提交时 body 不带该字段） */
const PROMO: Promotion = {
  id: 'promo-1',
  name: '满200减30',
  description: null,
  minAmount: 20000,
  discountAmount: 3000,
  status: 'ACTIVE',
  startsAt: '2026-11-01T02:00:00.000Z',
  endsAt: '2026-12-01T02:00:00.000Z',
};

// 显式声明 fetch 签名：否则 vi.fn 推断成 `() => Promise<Response>`，
// mock.calls 被推断为空元组 `[]`，断言 `calls[0]` 时 tsc 直接报越界。
type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const okResponse: FetchImpl = () =>
  Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));

beforeEach(() => {
  refreshMock.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('满减活动管理', () => {
  it('新建促销：提交 POST /api/promotions，body 精确匹配且成功后关闭表单并刷新', async () => {
    const fetchMock = vi.fn(okResponse);
    vi.stubGlobal('fetch', fetchMock);

    render(<PromotionManager initial={[]} />);

    await userEvent.click(screen.getByText('新建满减活动'));
    await userEvent.type(screen.getByLabelText('活动名称'), '满200减30');
    await userEvent.type(screen.getByLabelText('门槛（元）'), '200');
    await userEvent.type(screen.getByLabelText('减免金额（元）'), '30');
    await userEvent.type(screen.getByLabelText('活动说明'), '测试说明');
    fireEvent.change(screen.getByLabelText('生效开始时间'), {
      target: { value: '2026-11-20T10:00' },
    });
    fireEvent.change(screen.getByLabelText('生效结束时间'), {
      target: { value: '2026-11-30T23:59' },
    });
    await userEvent.click(screen.getByText('保存'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/promotions');
    expect(options.method).toBe('POST');
    expect(options.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(options.body as string)).toEqual({
      name: '满200减30',
      minAmount: 20000,
      discountAmount: 3000,
      description: '测试说明',
      startsAt: new Date('2026-11-20T10:00').toISOString(),
      endsAt: new Date('2026-11-30T23:59').toISOString(),
    });

    // 成功后表单关闭（「新建满减活动」按钮回来），并刷新服务端列表
    await waitFor(() => {
      expect(screen.getByText('新建满减活动')).toBeTruthy();
    });
    expect(screen.queryByLabelText('活动名称')).toBeNull();
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('新建促销：减免金额非法 → 不发请求并提示文案', async () => {
    const fetchMock = vi.fn(okResponse);
    vi.stubGlobal('fetch', fetchMock);

    render(<PromotionManager initial={[]} />);
    await userEvent.click(screen.getByText('新建满减活动'));
    await userEvent.type(screen.getByLabelText('减免金额（元）'), 'abc');
    await userEvent.click(screen.getByText('保存'));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe(
      '减免金额必须是大于 0 的金额，最多两位小数',
    );
  });

  it('编辑促销：提交 PATCH /api/promotions/:id，body 精确匹配（description 为空则不携带）', async () => {
    const fetchMock = vi.fn(okResponse);
    vi.stubGlobal('fetch', fetchMock);

    render(<PromotionManager initial={[PROMO]} />);
    await userEvent.click(screen.getByText('编辑'));

    // 表单预填：金额按「元」展示
    expect(
      (screen.getByLabelText('活动名称') as HTMLInputElement).value,
    ).toBe('满200减30');
    expect((screen.getByLabelText('门槛（元）') as HTMLInputElement).value).toBe(
      '200.00',
    );
    expect(
      (screen.getByLabelText('减免金额（元）') as HTMLInputElement).value,
    ).toBe('30.00');

    const nameInput = screen.getByLabelText('活动名称');
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, '满300减50');
    await userEvent.click(screen.getByText('保存'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/promotions/promo-1');
    expect(options.method).toBe('PATCH');
    expect(JSON.parse(options.body as string)).toEqual({
      name: '满300减50',
      minAmount: 20000,
      discountAmount: 3000,
      // fixture 秒为 0，元/分往返与 datetime-local 往返均无损
      startsAt: '2026-11-01T02:00:00.000Z',
      endsAt: '2026-12-01T02:00:00.000Z',
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('暂停活动：PATCH /api/promotions/:id，body {status: PAUSED} 并刷新', async () => {
    const fetchMock = vi.fn(okResponse);
    vi.stubGlobal('fetch', fetchMock);

    render(<PromotionManager initial={[PROMO]} />);
    await userEvent.click(screen.getByText('暂停'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/promotions/promo-1');
    expect(options.method).toBe('PATCH');
    expect(JSON.parse(options.body as string)).toEqual({ status: 'PAUSED' });
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('启用活动：PATCH /api/promotions/:id，body {status: ACTIVE}', async () => {
    const fetchMock = vi.fn(okResponse);
    vi.stubGlobal('fetch', fetchMock);

    render(<PromotionManager initial={[{ ...PROMO, status: 'PAUSED' }]} />);
    await userEvent.click(screen.getByText('启用'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/promotions/promo-1');
    expect(JSON.parse(options.body as string)).toEqual({ status: 'ACTIVE' });
  });

  it('删除促销：确认后 DELETE /api/promotions/:id 并刷新', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchMock = vi.fn(okResponse);
    vi.stubGlobal('fetch', fetchMock);

    render(<PromotionManager initial={[PROMO]} />);
    await userEvent.click(screen.getByText('删除'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/promotions/promo-1');
    expect(options.method).toBe('DELETE');
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('删除促销：取消确认 → 不发请求', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const fetchMock = vi.fn(okResponse);
    vi.stubGlobal('fetch', fetchMock);

    render(<PromotionManager initial={[PROMO]} />);
    await userEvent.click(screen.getByText('删除'));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('服务端返回错误 → 显示 message，不刷新列表', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ message: '活动名称已存在' }), {
          status: 409,
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<PromotionManager initial={[]} />);
    await userEvent.click(screen.getByText('新建满减活动'));
    await userEvent.type(screen.getByLabelText('活动名称'), '满200减30');
    await userEvent.type(screen.getByLabelText('门槛（元）'), '200');
    await userEvent.type(screen.getByLabelText('减免金额（元）'), '30');
    fireEvent.change(screen.getByLabelText('生效开始时间'), {
      target: { value: '2026-11-20T10:00' },
    });
    fireEvent.change(screen.getByLabelText('生效结束时间'), {
      target: { value: '2026-11-30T23:59' },
    });
    await userEvent.click(screen.getByText('保存'));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('活动名称已存在');
    });
    expect(refreshMock).not.toHaveBeenCalled();
  });
});
