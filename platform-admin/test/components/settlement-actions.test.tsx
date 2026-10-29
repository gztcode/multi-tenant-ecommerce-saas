// @vitest-environment jsdom
/**
 * 结算单客户端组件（生成 / 确认 / 取消确认 / 重算）的关键行为。
 *
 * ⚠️ **第一行必须写 `// @vitest-environment jsdom`**：
 * platform-admin 的 vitest 配置全局是 `node`（Route Handler 用 Web 标准的
 * Request / Response，不需要 DOM）。逐文件的环境注释**优先于全局配置**。
 *
 * ⚠️ **为什么这些护栏只能在 jsdom 里测**：客户端组件在 Server Component
 * 的元素树里是「还没渲染」的元素 —— 它的内部文字与事件处理都不在
 * `props.children` 里。页面级测试（`test/app/settlements-page.test.tsx`）
 * 锁的是「页面服务端渲染出来的文字」与「组件收到的 props」；
 * 「点下去会发生什么」只能在这里测。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  SettlementGenerateForm,
  SettlementRowActions,
} from '@/app/(dashboard)/settlements/settlement-actions';

const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

/**
 * 读出 fetch 调用参数（**不解析 body**）。
 *
 * ⚠️ **状态操作（确认 / 取消确认 / 重算）根本不带 body**，
 * 无条件 `JSON.parse(undefined)` 会抛「undefined is not valid JSON」。
 */
function callOf(fetchMock: ReturnType<typeof vi.fn>, index = 0) {
  const [url, options] = fetchMock.mock.calls[index] as [string, RequestInit];
  return { url, options };
}

/**
 * 读出 fetch 调用参数，并**要求**它带了 JSON body。
 *
 * ⚠️ 单独拆一个出来：生成结算单一定带 body，而状态操作一定不带，
 * 把「一定带」和「一定不带」混在一个函数里，断言就永远说不清自己在验什么。
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
  fetchMock = vi.fn(
    async () => jsonResponse({ items: [], created: 1, skipped: 0 }),
  );
  vi.stubGlobal('fetch', fetchMock);
});

describe('SettlementGenerateForm：生成结算单', () => {
  it('提交时只发周期，不发任何金额', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<SettlementGenerateForm period="2026-01" />);
    await user.click(screen.getByRole('button', { name: '生成' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const { url, options, body } = callWithBody(fetchMock);
    expect(url).toBe('/api/billing/settlements');
    expect(options.method).toBe('POST');
    expect(body.period).toBe('2026-01');
    // ⚠️ **金额永远不在请求体里**：金额是后端按流水算出来的，
    // 前端传了它就等于允许前端改账。
    expect(body).not.toHaveProperty('grossAmount');
    expect(body).not.toHaveProperty('reversalAmount');
    expect(body).not.toHaveProperty('netAmount');
    expect(body).not.toHaveProperty('amount');
  });

  it('⚠️ 周期月份非法（13 月）时显示错误提示，且根本不发请求', async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<SettlementGenerateForm />);

    // ⚠️ **不能直接 `user.type(input, '2026-13')`**：
    //    input 是 `type="month"`，jsdom 会把非法值清洗成 `""`（实测如此），
    //    于是这条测的其实是「空值非法」—— 正则里 `1[0-2]` 那条
    //    **月份上界分支从未被执行过**。把组件里的正则改成 `^\d{4}-\d{2}$`
    //    让 13 月漏过去，这条测试仍然绿。
    //
    // ⚠️ **用 `Object.defineProperty` 绕过 jsdom 的 setter 清洗**，
    //    再派发 `change` 让 React 的 onChange 收到「2026-13」。
    //    （原生 setter 也会被 jsdom 清洗掉 —— 实测 value 仍是 `""`。）
    const input = screen.getByLabelText('结算周期') as HTMLInputElement;
    Object.defineProperty(input, 'value', {
      value: '2026-13',
      configurable: true,
    });
    fireEvent.change(input);
    expect(input.value).toBe('2026-13');

    await user.click(screen.getByRole('button', { name: '生成' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('周期格式非法');
    expect(fetchMock).not.toHaveBeenCalled();
    // ⚠️ **连确认框都不该弹**：格式都不对的东西没有资格问用户。
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('⚠️ 周期为空时也显示错误提示，且根本不发请求', async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<SettlementGenerateForm />);
    await user.click(screen.getByRole('button', { name: '生成' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('周期格式非法');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('⚠️ 用户取消确认 → 根本不发请求', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<SettlementGenerateForm period="2026-01" />);
    await user.click(screen.getByRole('button', { name: '生成' }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('⚠️ 生成前会弹确认框，且框里说清是哪个月', async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<SettlementGenerateForm period="2026-01" />);
    await user.click(screen.getByRole('button', { name: '生成' }));

    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalledTimes(1);
    });
    // ⚠️ **确认框必须写明周期**：超管一次点下去会建出一整批单据，
    // 不说清是哪个月就等于让他闭眼签字。
    expect(confirmSpy.mock.calls[0]?.[0]).toContain('2026-01');
  });

  it('⚠️ 成功后显示新建张数并刷新列表', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fetchMock.mockResolvedValue(
      jsonResponse({ items: [], created: 3, skipped: 2 }),
    );

    render(<SettlementGenerateForm period="2026-01" />);
    await user.click(screen.getByRole('button', { name: '生成' }));

    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('已新建 3 张结算单');
    expect(status.textContent).toContain('复用 2 张已有单据');
    // ⚠️ **成功后必须刷新**：列表是服务端渲染的，不刷新就看不到新单据。
    await waitFor(() => {
      expect(refreshMock).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('⚠️ 返回 conflicts 时显示「没能出单」的提示，并透出后端的消息', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fetchMock.mockResolvedValue(
      jsonResponse({
        items: [],
        created: 2,
        skipped: 1,
        conflicts: [
          {
            tenantId: 'abc',
            message: '这笔流水已经被另一张结算单结算过了（订单号 ORD-1）',
          },
        ],
      }),
    );

    render(<SettlementGenerateForm period="2026-01" />);
    await user.click(screen.getByRole('button', { name: '生成' }));

    const status = await screen.findByRole('status');
    // ⚠️ **数量与关键词都要断言**：只断言「有提示」的话，
    // 把它写成「有 1 个商家没能出单」或「有 99 个商家没能出单」都照样绿。
    expect(status.textContent).toContain('1 个商家没能出单');
    // ⚠️ **必须透出后端那条 message**：里面带订单号等排查线索，
    // 前端自己编一句「出单失败」等于把线索丢了。
    expect(status.textContent).toContain(
      '这笔流水已经被另一张结算单结算过了（订单号 ORD-1）',
    );
    // ⚠️ **部分成功 ≠ 整体失败**：其余商家的单已经建好了。
    expect(status.textContent).toContain('已新建 2 张结算单');
    expect(status.textContent).toContain('其余商家已出单成功');
    // ⚠️ **不能变成错误提示**：这是 HTTP 200 的正常响应。
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('⚠️ 返回 stale 时提示「缺笔 / 与当期流水对不上」并给出修正路径', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fetchMock.mockResolvedValue(
      jsonResponse({
        items: [],
        created: 0,
        skipped: 3,
        stale: ['def'],
      }),
    );

    render(<SettlementGenerateForm period="2026-01" />);
    await user.click(screen.getByRole('button', { name: '生成' }));

    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('1 个已有单据与当期流水对不上');
    expect(status.textContent).toContain('缺笔');
    // ⚠️ **必须说清唯一的修正路径**：后端只标记不改单据，
    // 不提示的话用户以为「本期已结清」，实际金额是错的。
    expect(status.textContent).toContain('取消确认');
    expect(status.textContent).toContain('重算');
    // ⚠️ **stale 是追加信息，原来的成功文案要留着。**
    expect(status.textContent).toContain('已新建 0 张结算单');
    expect(status.textContent).toContain('复用 3 张已有单据');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('⚠️ 旧响应形状（没有 conflicts / stale）时不崩，只显示原来的成功文案', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    // ⚠️ **后端某些路径不返回这两个字段**：前端不能因此崩，
    // 也不能凭空显示「0 个商家没能出单」这种噪音。
    fetchMock.mockResolvedValue(
      jsonResponse({ items: [], created: 2, skipped: 1 }),
    );

    render(<SettlementGenerateForm period="2026-01" />);
    await user.click(screen.getByRole('button', { name: '生成' }));

    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('已新建 2 张结算单');
    expect(status.textContent).toContain('复用 1 张已有单据');
    expect(status.textContent).not.toContain('没能出单');
    expect(status.textContent).not.toContain('缺笔');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('⚠️ 失败时显示错误提示，且不刷新', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fetchMock.mockResolvedValue(jsonResponse({ message: '周期还没结束' }, 409));

    render(<SettlementGenerateForm period="2026-01" />);
    await user.click(screen.getByRole('button', { name: '生成' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('操作失败');
    expect(alert.textContent).toContain('周期还没结束');
    // ⚠️ **失败就不该刷新**：刷新了会把错误提示冲掉。
    expect(refreshMock).not.toHaveBeenCalled();
    // ⚠️ **成功提示与失败提示必须分开**：同时出现两个框，
    // 超管根本分不清到底成没成。
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('⚠️ 失败后按钮恢复可点（闸门复位）', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fetchMock.mockResolvedValue(jsonResponse({ message: '炸了' }, 500));

    render(<SettlementGenerateForm period="2026-01" />);
    await user.click(screen.getByRole('button', { name: '生成' }));

    await screen.findByRole('alert');

    // ⚠️ **按钮必须回到可点状态**：`busyRef` / `busy` 没复位的话，
    // 按钮永远停在「生成中…」且再也点不动 —— 一次失败就把这个按钮废掉。
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '生成' })).not.toBeDisabled();
    });
  });
});

describe('SettlementRowActions：状态操作', () => {
  it('草稿单据给「确认」与「重算」两个按钮', async () => {
    render(<SettlementRowActions statementId="statement-1" status="DRAFT" />);

    expect(screen.getByRole('button', { name: '确认' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '重算' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '取消确认' })).toBeNull();
  });

  it('已确认的单据只给「取消确认」', async () => {
    render(
      <SettlementRowActions statementId="statement-1" status="CONFIRMED" />,
    );

    expect(screen.getByRole('button', { name: '取消确认' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '确认' })).toBeNull();
    expect(screen.queryByRole('button', { name: '重算' })).toBeNull();
  });

  it('已出款的单据不给任何操作按钮', async () => {
    render(<SettlementRowActions statementId="statement-1" status="PAID" />);

    expect(screen.queryByRole('button')).toBeNull();
  });

  it('⚠️ 确认走 confirm 端点，成功后刷新', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<SettlementRowActions statementId="statement-1" status="DRAFT" />);
    await user.click(screen.getByRole('button', { name: '确认' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const { url, options } = callOf(fetchMock);
    expect(url).toBe('/api/billing/settlements/statement-1/confirm');
    expect(options.method).toBe('POST');
    // ⚠️ **确认请求不带任何 body**：确认不改金额，改的是单据的状态。
    expect(options.body).toBeUndefined();
    await waitFor(() => {
      expect(refreshMock).toHaveBeenCalledTimes(1);
    });
  });

  it('⚠️ 取消确认走 unconfirm 端点', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(
      <SettlementRowActions statementId="statement-1" status="CONFIRMED" />,
    );
    await user.click(screen.getByRole('button', { name: '取消确认' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const { url, options } = callOf(fetchMock);
    expect(url).toBe('/api/billing/settlements/statement-1/unconfirm');
    // ⚠️ **必须断言 method**：中转路由只导出了 `POST`，
    //    改成 `GET` 会 405 —— 只查 URL 的话这条照样绿。
    expect(options.method).toBe('POST');
  });

  it('⚠️ 重算走 recalculate 端点', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<SettlementRowActions statementId="statement-1" status="DRAFT" />);
    await user.click(screen.getByRole('button', { name: '重算' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const { url, options } = callOf(fetchMock);
    expect(url).toBe('/api/billing/settlements/statement-1/recalculate');
    // ⚠️ **必须断言 method**：同上 —— 改成 `GET` 会被中转路由 405 掉。
    expect(options.method).toBe('POST');
  });

  it('⚠️ 用户取消确认 → 根本不发请求', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<SettlementRowActions statementId="statement-1" status="DRAFT" />);
    await user.click(screen.getByRole('button', { name: '确认' }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('⚠️ 失败时显示错误提示，且不刷新', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fetchMock.mockResolvedValue(jsonResponse({ message: '单据已确认' }, 409));

    render(<SettlementRowActions statementId="statement-1" status="DRAFT" />);
    await user.click(screen.getByRole('button', { name: '确认' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('操作失败');
    expect(alert.textContent).toContain('单据已确认');
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('⚠️ 失败后按钮恢复可点（闸门复位）', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fetchMock.mockResolvedValue(jsonResponse({ message: '炸了' }, 500));

    render(<SettlementRowActions statementId="statement-1" status="DRAFT" />);
    await user.click(screen.getByRole('button', { name: '确认' }));

    await screen.findByRole('alert');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '确认' })).not.toBeDisabled();
    });
  });
});
