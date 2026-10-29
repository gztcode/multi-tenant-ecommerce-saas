// @vitest-environment jsdom
/**
 * 撤回出款申请按钮（客户端组件）。
 *
 * ⚠️ **只有「待审批」能撤回**：已审批的金额已经锁定，撤回要走平台。
 * 组件在非 `REQUESTED` 状态**整个不渲染** —— 界面上根本没有那个按钮，
 * 商家点不到，也就没有「点了才发现不能撤」这回事。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';

const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

import { PayoutCancelButton } from '@/app/(dashboard)/settlements/payout-cancel-button';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('confirm', vi.fn(() => true));
});

describe('撤回按钮：只在待审批时出现', () => {
  it('待审批 → 有「撤回申请」按钮', () => {
    render(<PayoutCancelButton payoutId="p1" status="REQUESTED" />);

    expect(screen.getByRole('button', { name: '撤回申请' })).toBeInTheDocument();
  });

  it('⚠️ 已审批 → 整个按钮不渲染', () => {
    render(<PayoutCancelButton payoutId="p1" status="APPROVED" />);

    expect(screen.queryByRole('button', { name: '撤回申请' })).toBeNull();
  });

  it('⚠️ 已撤回 / 已拒绝 → 也不渲染', () => {
    for (const status of ['CANCELLED', 'REJECTED'] as const) {
      const { unmount } = render(
        <PayoutCancelButton payoutId="p1" status={status} />,
      );
      expect(screen.queryByRole('button', { name: '撤回申请' })).toBeNull();
      unmount();
    }
  });

  it('显示当前状态的中文文案，不显示裸枚举', () => {
    render(<PayoutCancelButton payoutId="p1" status="REQUESTED" />);

    expect(screen.getByText(/待审批/)).toBeInTheDocument();
    expect(screen.queryByText(/REQUESTED/)).toBeNull();
  });
});

describe('撤回按钮：提交', () => {
  it('⚠️ 撤回打到 /api/merchant/payouts/:id 并带 DELETE 方法', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<PayoutCancelButton payoutId="p1" status="REQUESTED" />);
    fireEvent.click(screen.getByRole('button', { name: '撤回申请' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/merchant/payouts/p1');
    expect(options.method).toBe('DELETE');
  });

  it('撤回成功后刷新页面', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<PayoutCancelButton payoutId="p1" status="REQUESTED" />);
    fireEvent.click(screen.getByRole('button', { name: '撤回申请' }));

    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
  });

  it('⚠️ 撤回失败 → 显示错误提示', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ message: '出款单当前是「已审批」状态，不能撤回' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<PayoutCancelButton payoutId="p1" status="REQUESTED" />);
    fireEvent.click(screen.getByRole('button', { name: '撤回申请' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('撤回失败');
  });

  it('⚠️ 取消确认框 → 根本不调后端', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(<PayoutCancelButton payoutId="p1" status="REQUESTED" />);
    fireEvent.click(screen.getByRole('button', { name: '撤回申请' }));

    await waitFor(() => expect(vi.mocked(confirm)).toHaveBeenCalled());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('撤回按钮：并发闸门', () => {
  it('⚠️ 连点两次只发一次请求（闸门读 ref 而不是 state）', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<PayoutCancelButton payoutId="p1" status="REQUESTED" />);

    const button = screen.getByRole('button', { name: '撤回申请' });

    // ⚠️ **两次点击必须在同一个 `act()` 里同步发出**：
    //    分成两次 `await user.click(...)` 时，React 在两次之间已经
    //    重渲染并把按钮置为 `disabled`，第二次点击压根不会触发 handler ——
    //    那样的话**闸门换成 state 也照样绿**，这条护栏就白写了。
    //
    //    同一个 `act()` 里 React 批量处理，两次点击之间不会重渲染，
    //    `disabled` 还没生效，于是 handler 真的被调用了两次。
    act(() => {
      button.click();
      button.click();
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // ⚠️ **闸门必须是「同步可读」的**：ref 在 `await fetch` 之前就写好了，
    //    第二次调用读到的是「正在处理中」→ 直接返回。
    //    如果换成 state，同一个 tick 里 `busy` 还是旧值 `false`，
    //    第二次调用会照样发请求 → 这里就会是 2 次。
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('⚠️ 闸门复位后可以再次操作（不是永久锁死）', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<PayoutCancelButton payoutId="p1" status="REQUESTED" />);

    await act(async () => {
      screen.getByRole('button', { name: '撤回申请' }).click();
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      screen.getByRole('button', { name: '撤回申请' }).click();
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
