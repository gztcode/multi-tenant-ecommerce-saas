// @vitest-environment jsdom
/**
 * 出款单审批组件（通过 / 拒绝）的关键行为。
 *
 * ⚠️ **第一行必须写 `// @vitest-environment jsdom`**：
 * platform-admin 的 vitest 配置全局是 `node`（Route Handler 用 Web 标准的
 * Request / Response，不需要 DOM）。逐文件的环境注释**优先于全局配置**。
 *
 * ⚠️ **为什么这些护栏只能在 jsdom 里测**：客户端组件在 Server Component
 * 的元素树里是「还没渲染」的元素 —— 它的内部文字与事件处理都不在
 * `props.children` 里。页面级测试锁的是「页面服务端渲染出来的文字」
 * 与「组件收到的 props」；「点下去会发生什么」只能在这里测。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { PayoutActions } from '@/app/(dashboard)/payouts/payout-actions';

const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

/**
 * 读出 fetch 调用参数（**不解析 body**）。
 *
 * ⚠️ **「通过」请求根本不带 body**，无条件 `JSON.parse(undefined)`
 * 会抛「undefined is not valid JSON」。
 */
function callOf(fetchMock: ReturnType<typeof vi.fn>, index = 0) {
  const [url, options] = fetchMock.mock.calls[index] as [string, RequestInit];
  return { url, options };
}

/**
 * 读出 fetch 调用参数，并**要求**它带了 JSON body。
 */
function callWithBody(fetchMock: ReturnType<typeof vi.fn>, index = 0) {
  const { url, options } = callOf(fetchMock, index);
  return {
    url,
    options,
    body: JSON.parse(String(options.body)) as Record<string, unknown>,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // ⚠️ **必须还原 spy**：`vi.spyOn(window, 'confirm')` 一旦某条用例
  //    `mockReturnValue(false)`，不还原就会**跨用例泄漏** ——
  //    后面某条忘了 spy 的用例会静默继承 `false`，
  //    表现成「点了按钮没反应」，极难查。
  //
  // ⚠️ **本项目的 `vitest.config.ts` 没开 `restoreMocks`**，
  //    `test/setup.ts` 也只做 `cleanup`，所以只能在这里手动还原。
  //
  // ⚠️ **`vi.mock` 注册的模块 mock 不受影响**（那是模块级的），
  //    但 `restoreAllMocks` 会清掉 `vi.fn()` 上用 `mockResolvedValue` 设的实现 ——
  //    所以 `mockResolvedValue` 必须写在 `restoreAllMocks` **之后**。
  vi.restoreAllMocks();
  vi.clearAllMocks();
  fetchMock = vi.fn(async () => jsonResponse({ id: 'payout-1' }));
  vi.stubGlobal('fetch', fetchMock);
});

describe('PayoutActions：按钮的显示条件', () => {
  it('待审批的单据给「通过」与「拒绝」两个按钮', () => {
    render(
      <PayoutActions
        payoutId="payout-1"
        status="REQUESTED"
        requestedAmount={1000}
      />,
    );

    expect(screen.getByRole('button', { name: '通过' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '拒绝' })).toBeTruthy();
  });

  it('⚠️ 已审批的单据不给任何操作按钮，但要说清为什么没有按钮', () => {
    render(
      <PayoutActions
        payoutId="payout-1"
        status="APPROVED"
        requestedAmount={1000}
      />,
    );

    expect(screen.queryByRole('button')).toBeNull();
    // ⚠️ **不能整块渲染成 `null`**：详情页上就是一片空白，
    //    超管会以为页面没加载出来，而不是「这单已经批过了」。
    expect(screen.getByText(/没有可执行的审批操作/)).toBeTruthy();
    expect(screen.getByText(/已审批/)).toBeTruthy();
  });

  it('⚠️ 已拒绝的单据不给任何操作按钮（商家要重新申请）', () => {
    render(
      <PayoutActions
        payoutId="payout-1"
        status="REJECTED"
        requestedAmount={1000}
      />,
    );

    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(/已拒绝/)).toBeTruthy();
  });

  it('⚠️ 已撤回 / 已出款的单据也不给按钮', () => {
    for (const status of ['CANCELLED', 'PAID', 'FAILED'] as const) {
      const { unmount } = render(
        <PayoutActions
          payoutId="payout-1"
          status={status}
          requestedAmount={1000}
        />,
      );
      expect(screen.queryByRole('button')).toBeNull();
      unmount();
    }
  });

  it('⚠️ 非「待审批」时不产生任何请求', () => {
    render(
      <PayoutActions
        payoutId="payout-1"
        status="APPROVED"
        requestedAmount={1000}
      />,
    );

    // ⚠️ **渲染出来的是一句说明，不是一堆能点的按钮** ——
    //    这块区域不该偷偷发任何请求。
    expect(fetchMock).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });
});

describe('PayoutActions：通过', () => {
  it('⚠️ 通过走 approve 端点，成功后刷新', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(
      <PayoutActions
        payoutId="payout-1"
        status="REQUESTED"
        requestedAmount={1000}
      />,
    );
    await user.click(screen.getByRole('button', { name: '通过' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const { url, options } = callOf(fetchMock);
    expect(url).toBe('/api/billing/payouts/payout-1/approve');
    expect(options.method).toBe('POST');
    // ⚠️ **通过请求不带任何 body**：金额由后端重算并锁定，
    //    前端传了它就等于允许前端改账。
    expect(options.body).toBeUndefined();
    await waitFor(() => {
      expect(refreshMock).toHaveBeenCalledTimes(1);
    });
  });

  it('⚠️ 确认框里要说清「会重算并锁定」（与申请时的预估可能不同）', async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(
      <PayoutActions
        payoutId="payout-1"
        status="REQUESTED"
        requestedAmount={1000}
      />,
    );
    await user.click(screen.getByRole('button', { name: '通过' }));

    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalledTimes(1);
    });
    // ⚠️ **超管是在决定把哪笔钱打给谁**：不确认金额会被重算就直接签字，
    //    等于闭眼放款。
    expect(confirmSpy.mock.calls[0]?.[0]).toContain('重算');
  });

  it('⚠️ 用户取消确认 → 根本不发请求', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(
      <PayoutActions
        payoutId="payout-1"
        status="REQUESTED"
        requestedAmount={1000}
      />,
    );
    await user.click(screen.getByRole('button', { name: '通过' }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });
});

describe('PayoutActions：拒绝', () => {
  it('⚠️ 不填原因 → 根本不发请求，并给出提示', async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(
      <PayoutActions
        payoutId="payout-1"
        status="REQUESTED"
        requestedAmount={1000}
      />,
    );
    await user.click(screen.getByRole('button', { name: '拒绝' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('拒绝出款必须填写原因');
    expect(fetchMock).not.toHaveBeenCalled();
    // ⚠️ **连确认框都不该弹**：没有原因的拒绝不该走到确认那一步。
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('⚠️ 只填空白字符也算没填', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(
      <PayoutActions
        payoutId="payout-1"
        status="REQUESTED"
        requestedAmount={1000}
      />,
    );
    await user.type(screen.getByLabelText('拒绝原因'), '   ');
    await user.click(screen.getByRole('button', { name: '拒绝' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('拒绝出款必须填写原因');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('⚠️ 填了原因 → 发请求到 reject 端点，且只带 reason', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(
      <PayoutActions
        payoutId="payout-1"
        status="REQUESTED"
        requestedAmount={1000}
      />,
    );
    await user.type(screen.getByLabelText('拒绝原因'), '该期结算单尚未确认');
    await user.click(screen.getByRole('button', { name: '拒绝' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const { url, options, body } = callWithBody(fetchMock);
    expect(url).toBe('/api/billing/payouts/payout-1/reject');
    expect(options.method).toBe('POST');
    expect(body.reason).toBe('该期结算单尚未确认');
    // ⚠️ **金额永远不在请求体里**：拒绝不改金额，改的是单据的状态。
    expect(body).not.toHaveProperty('netAmount');
    expect(body).not.toHaveProperty('amount');
    await waitFor(() => {
      expect(refreshMock).toHaveBeenCalledTimes(1);
    });
  });

  it('⚠️ 用户取消确认 → 根本不发请求', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(
      <PayoutActions
        payoutId="payout-1"
        status="REQUESTED"
        requestedAmount={1000}
      />,
    );
    await user.type(screen.getByLabelText('拒绝原因'), '随便写个原因');
    await user.click(screen.getByRole('button', { name: '拒绝' }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });
});

describe('PayoutActions：并发闸门', () => {
  it('⚠️ 连点两次只发一次请求（闸门读 ref 而不是 state）', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(
      <PayoutActions
        payoutId="payout-1"
        status="REQUESTED"
        requestedAmount={1000}
      />,
    );

    const button = screen.getByRole('button', { name: '通过' });

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
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(
      <PayoutActions
        payoutId="payout-1"
        status="REQUESTED"
        requestedAmount={1000}
      />,
    );

    await user.click(screen.getByRole('button', { name: '通过' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    await user.click(screen.getByRole('button', { name: '通过' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});

describe('平台端出款的人工处置（阶段 5l）', () => {
  it('⚠️ FAILED 且确定没打 → 显示「重试」按钮', () => {
    render(
      <PayoutActions
        payoutId="payout-1"
        status="FAILED"
        requestedAmount={95000}
        failedBeforePayout
      />,
    );

    expect(screen.getByRole('button', { name: /重试/ })).toBeTruthy();
  });

  it('⚠️ FAILED 但可能已打 → **不显示**「重试」按钮', () => {
    // ⚠️ **这条是护栏** —— 钱可能已经打出去，重试 = 重复打款
    render(
      <PayoutActions
        payoutId="payout-1"
        status="FAILED"
        requestedAmount={95000}
      />,
    );

    expect(screen.queryByRole('button', { name: /重试/ })).toBeNull();
  });

  it('⚠️ 卡在 PROCESSING → 显示两个解卡按钮，且「重新打款」带警示', () => {
    render(
      <PayoutActions
        payoutId="payout-1"
        status="PROCESSING"
        requestedAmount={95000}
      />,
    );

    expect(screen.getByRole('button', { name: /标记为失败/ })).toBeTruthy();
    const redo = screen.getByRole('button', { name: /重新打款/ });
    expect(redo).toBeTruthy();
    // ⚠️ **警示必须出现在按钮附近** —— 运营点之前要看到这句话
    expect(screen.getByText(/可能已打款/)).toBeTruthy();
  });
});

describe('PayoutActions：失败处理', () => {
  it('⚠️ 失败时显示错误提示，且不刷新', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fetchMock.mockResolvedValue(jsonResponse({ message: '出款单已被审批' }, 409));

    render(
      <PayoutActions
        payoutId="payout-1"
        status="REQUESTED"
        requestedAmount={1000}
      />,
    );
    await user.click(screen.getByRole('button', { name: '通过' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('操作失败');
    expect(alert.textContent).toContain('出款单已被审批');
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('⚠️ 失败后按钮恢复可点（闸门复位）', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fetchMock.mockResolvedValue(jsonResponse({ message: '炸了' }, 500));

    render(
      <PayoutActions
        payoutId="payout-1"
        status="REQUESTED"
        requestedAmount={1000}
      />,
    );
    await user.click(screen.getByRole('button', { name: '通过' }));

    await screen.findByRole('alert');

    // ⚠️ **按钮必须回到可点状态**：`busyRef` / `busy` 没复位的话，
    //    按钮永远停在「处理中…」且再也点不动 —— 一次失败就把这个按钮废掉。
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '通过' })).not.toBeDisabled();
    });
  });
});
