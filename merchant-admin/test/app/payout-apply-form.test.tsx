// @vitest-environment jsdom
/**
 * 「申请出款」表单（客户端组件）的关键行为。
 *
 * ⚠️ **第一行必须写 `// @vitest-environment jsdom`**：
 * merchant-admin 的 vitest 配置全局是 `node`（Route Handler 用 Web 标准的
 * Request / Response，不需要 DOM）。逐文件的环境注释**优先于全局配置**。
 *
 * ⚠️ **为什么必须有这一份测试**：`payout-apply-page.test.tsx` 只断言了
 * Server Component 传给 `PayoutApplyForm` 的 props，**从没真正 render 过
 * 这个组件** —— 整个写路径（下单）零覆盖：周期下拉框、金额显示、
 * 请求体、失败提示、刷新，全都可能被改坏而没人发现。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ⚠️ **`@/auth` 必须 mock 掉**：`@/lib/api-client` 会 import 它，
// 而 `next-auth` 会间接 import `next/server` —— 那是 ESM 下的路径别名，
// 在 node 环境下直接 import 会抛 `ERR_MODULE_NOT_FOUND`。
vi.mock('@/auth', () => ({ auth: vi.fn() }));

import { PayoutApplyForm } from '@/app/(dashboard)/settlements/apply/apply-form';
import type { AvailablePeriod } from '@/lib/payout';

const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

/**
 * ⚠️ **三个金额刻意用三个不同的数值**（货款 ¥5.00 / 佣金 ¥3.00 / 应结 ¥9.00）：
 * 三个都用同一个数时，「货款列显示的是佣金」这类错误测不出来。
 * 应结 ¥9.00 与「货款 − 佣金 = ¥2.00」不等 → 前端若自己加总能测出来。
 */
const PERIODS: AvailablePeriod[] = [
  {
    period: '2026-01',
    receiptAmount: 500,
    commissionAmount: 300,
    netAmount: 900,
    entryCount: 2,
    statementStatus: 'CONFIRMED',
    alreadyApplied: false,
    appliedKind: null,
    supplementAvailable: false,
    supplementAmount: null,
  },
  {
    period: '2026-02',
    receiptAmount: 1234,
    commissionAmount: 34,
    netAmount: 1200,
    entryCount: 7,
    statementStatus: 'CONFIRMED',
    alreadyApplied: true,
    appliedKind: 'NORMAL',
    supplementAvailable: false,
    supplementAmount: null,
  },
  {
    // ⚠️ **第三期：没申请过、也不能补差** —— 用来验证「换了周期就提交那个周期」。
    //    `2026-02` 那期已经有活跃单了，按钮是禁用的（阶段 5h-2 起，
    //    `alreadyApplied` 会真的禁用提交按钮），不能拿它测提交。
    period: '2026-03',
    receiptAmount: 2000,
    commissionAmount: 100,
    netAmount: 1900,
    entryCount: 4,
    statementStatus: 'CONFIRMED',
    alreadyApplied: false,
    appliedKind: null,
    supplementAvailable: false,
    supplementAmount: null,
  },
];

/**
 * 读出 fetch 调用参数，并**要求**它带了 JSON body。
 */
function callWithBody(fetchMock: ReturnType<typeof vi.fn>, index = 0) {
  const [url, options] = fetchMock.mock.calls[index] as [string, RequestInit];
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
  // ⚠️ **本项目的 `vitest.config.ts` 没开 `restoreMocks`**，
  //    所以 `mockResolvedValue` 必须写在 `restoreAllMocks` **之后**。
  vi.restoreAllMocks();
  vi.clearAllMocks();
  fetchMock = vi.fn(async () => jsonResponse({ id: 'payout-1' }));
  vi.stubGlobal('fetch', fetchMock);
});

describe('申请出款表单：周期下拉框', () => {
  it('⚠️ 选项来自后端给的周期列表', () => {
    render(<PayoutApplyForm periods={PERIODS} />);

    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(3);
    expect(options[0]?.getAttribute('value')).toBe('2026-01');
    expect(options[1]?.getAttribute('value')).toBe('2026-02');
    // ⚠️ **选项文案里要带周期**：商家靠它认出自己要申请哪一期。
    expect(options[0]?.textContent).toContain('2026-01');
    expect(options[1]?.textContent).toContain('2026-02');
  });

  it('⚠️ 已申请过的周期标出来「已申请」', () => {
    render(<PayoutApplyForm periods={PERIODS} />);

    const options = screen.getAllByRole('option');
    expect(options[0]?.textContent).not.toContain('已申请');
    expect(options[1]?.textContent).toContain('已申请');
  });

  it('默认选中第一个周期', () => {
    render(<PayoutApplyForm periods={PERIODS} />);

    const select = screen.getByLabelText('结算周期') as HTMLSelectElement;
    expect(select.value).toBe('2026-01');
  });

  it('⚠️ 换个周期，显示的金额也跟着换', async () => {
    const user = userEvent.setup();
    render(<PayoutApplyForm periods={PERIODS} />);

    await user.selectOptions(screen.getByLabelText('结算周期'), '2026-02');

    // ⚠️ **第二个周期的三个金额与第一个都不同**：
    //    货款 ¥12.34 / 佣金 ¥0.34 / 应结 ¥12.00。
    //    用**整段匹配**（下拉框的选项文案里也有「应结 ¥12.00」，
    //    单个片段会撞成「多个元素」）。
    expect(
      screen.getByText(/货款净额 ¥12\.34 · 平台佣金 ¥0\.34 · 应结 ¥12\.00/),
    ).toBeInTheDocument();
  });
});

describe('申请出款表单：金额展示', () => {
  it('⚠️ 显示后端给的应结金额（货款 / 佣金 / 应结各一个不同的值）', () => {
    render(<PayoutApplyForm periods={PERIODS} />);

    // ⚠️ **三个金额用的是后端给的值**：前端若自己把货款减佣金加总一遍，
    //    应结金额会从 ¥9.00 变成 ¥2.00。
    //
    // ⚠️ **`应结 ¥9.00` 匹配不到 `getByText`**：下拉框的选项文案里
    //    也有「应结 ¥9.00」，会撞成「多个元素」。这里改用**整段匹配**
    //    「货款净额 ¥5.00 · 平台佣金 ¥3.00 · 应结 ¥9.00」，
    //    它只可能出现在明细那一行。
    expect(
      screen.getByText(/货款净额 ¥5\.00 · 平台佣金 ¥3\.00 · 应结 ¥9\.00/),
    ).toBeInTheDocument();
  });

  it('⚠️ 下拉框的选项文案里也带应结金额', () => {
    render(<PayoutApplyForm periods={PERIODS} />);

    const options = screen.getAllByRole('option');
    expect(options[0]?.textContent).toContain('¥9.00');
    expect(options[1]?.textContent).toContain('¥12.00');
  });

  it('⚠️ 页面上没有金额输入框（商家不能自己填金额）', () => {
    render(<PayoutApplyForm periods={PERIODS} />);

    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByLabelText(/金额/)).toBeNull();
  });
});

describe('申请出款表单：提交', () => {
  it('⚠️ 发到 /api/merchant/payouts，且请求体里只有 period', async () => {
    const user = userEvent.setup();
    render(<PayoutApplyForm periods={PERIODS} />);

    await user.click(screen.getByRole('button', { name: '提交申请' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const { url, options, body } = callWithBody(fetchMock);
    expect(url).toBe('/api/merchant/payouts');
    expect(options.method).toBe('POST');
    // ⚠️ **请求体里只有周期**：金额是后端算的，
    //    客户端多传一个 `amount` 就等于允许前端改账。
    expect(Object.keys(body)).toEqual(['period']);
    expect(body.period).toBe('2026-01');
  });

  it('⚠️ 选了别的周期就提交那个周期', async () => {
    const user = userEvent.setup();
    render(<PayoutApplyForm periods={PERIODS} />);

    // ⚠️ **选 `2026-03`（没申请过的那期）**：`2026-02` 已有活跃单，
    //    阶段 5h-2 起按钮会禁用它 —— 用它测提交会点不动。
    await user.selectOptions(screen.getByLabelText('结算周期'), '2026-03');
    await user.click(screen.getByRole('button', { name: '提交申请' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const { body } = callWithBody(fetchMock);
    expect(body.period).toBe('2026-03');
  });

  it('⚠️ 已有活跃单的周期提交按钮禁用（点不动）', async () => {
    const user = userEvent.setup();
    render(<PayoutApplyForm periods={PERIODS} />);

    // ⚠️ **`alreadyApplied` 必须真的禁用按钮**：同一期再来一张单，
    //    后端会撞唯一索引 —— 前端不能让商家点了才收报错。
    //
    // ⚠️ **必须先切到 `2026-02` 再断言**：初始选中的是 `periods[0]`
    //    （`2026-01`，未申请），按钮本来就是可点的 —— 不切换就断言
    //    禁用，验的是别的周期，不是用例名承诺的那一期。
    await user.selectOptions(screen.getByLabelText('结算周期'), '2026-02');

    // ⚠️ **选项文案也要标出来**：商家得知道这期为什么点不动。
    const options = screen.getAllByRole('option');
    expect(options[1]?.textContent).toContain('已申请');

    expect(screen.getByRole('button', { name: '提交申请' })).toBeDisabled();
  });

  it('⚠️ 未申请的周期提交按钮可点（不能误伤）', () => {
    render(<PayoutApplyForm periods={PERIODS} />);

    // ⚠️ **必须有一条对照**：只验「禁用了」不验「没误伤」，
    //    一个「永远禁用」的 bug 也能过。
    //    默认选中 `2026-01`（未申请）→ 按钮必须可点。
    expect(screen.getByRole('button', { name: '提交申请' })).not.toBeDisabled();
  });

  it('⚠️ 成功后刷新页面', async () => {
    const user = userEvent.setup();
    render(<PayoutApplyForm periods={PERIODS} />);

    await user.click(screen.getByRole('button', { name: '提交申请' }));

    await waitFor(() => {
      expect(refreshMock).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByRole('status').textContent).toContain('申请已提交');
  });
});

describe('申请出款表单：失败处理', () => {
  it('⚠️ 失败时显示错误提示，且不刷新', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ message: '该周期已申请过' }, 409));

    render(<PayoutApplyForm periods={PERIODS} />);
    await user.click(screen.getByRole('button', { name: '提交申请' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('申请失败');
    expect(alert.textContent).toContain('该周期已申请过');
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('⚠️ 失败后按钮恢复可点（闸门复位）', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ message: '炸了' }, 500));

    render(<PayoutApplyForm periods={PERIODS} />);
    await user.click(screen.getByRole('button', { name: '提交申请' }));

    await screen.findByRole('alert');

    // ⚠️ **按钮必须回到可点状态**：闸门没复位的话，按钮永远停在
    //    「提交中…」且再也点不动 —— 一次失败就把这个按钮废掉。
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '提交申请' })).not.toBeDisabled();
    });
  });
});

describe('申请出款表单：并发闸门', () => {
  it('⚠️ 连点两次只发一次请求（闸门读 ref 而不是 state）', async () => {
    render(<PayoutApplyForm periods={PERIODS} />);

    const button = screen.getByRole('button', { name: '提交申请' });

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
    render(<PayoutApplyForm periods={PERIODS} />);

    await user.click(screen.getByRole('button', { name: '提交申请' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    await user.click(screen.getByRole('button', { name: '提交申请' }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});

describe('申请出款表单：没有可申请的周期', () => {
  it('周期列表为空时显示提示，不渲染提交按钮', () => {
    render(<PayoutApplyForm periods={[]} />);

    expect(screen.getByText('暂无可申请的周期。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '提交申请' })).toBeNull();
  });
});

describe('申请出款表单：补差入口（阶段 5h-2）', () => {
  it('⚠️ supplementAvailable → 显示「申请补差」按钮且可点', () => {
    render(
      <PayoutApplyForm
        periods={[
          {
            period: '2025-07',
            receiptAmount: 10000,
            commissionAmount: 2000,
            netAmount: 8000,
            entryCount: 1,
            statementStatus: 'PAID',
            // ⚠️ **alreadyApplied = true 同时 supplementAvailable = true**：
            //    这是正常单已出款、但还有新流水回填的典型形状。
            alreadyApplied: true,
            appliedKind: 'NORMAL',
            supplementAvailable: true,
            supplementAmount: 5000,
          },
        ]}
      />,
    );

    const button = screen.getByRole('button', { name: '申请补差' });
    // ⚠️ **必须可点**：只看 `alreadyApplied` 就禁用的话，
    //    正常单出款后补差入口就永远消失，商家再也申请不了补差。
    expect(button).not.toBeDisabled();
    // ⚠️ **补差金额要显示** —— 商家要看到能再拿多少。
    //    ⚠️ 用 `getAllByText`：下拉框的选项文案里也有「可申请补差」。
    expect(screen.getAllByText(/可申请补差/).length).toBeGreaterThan(0);
  });

  it('⚠️ alreadyApplied 且不能补差 → 按钮禁用', () => {
    render(
      <PayoutApplyForm
        periods={[
          {
            period: '2025-07',
            receiptAmount: 10000,
            commissionAmount: 2000,
            netAmount: 8000,
            entryCount: 1,
            statementStatus: 'CONFIRMED',
            alreadyApplied: true,
            appliedKind: 'NORMAL',
            supplementAvailable: false,
            supplementAmount: null,
          },
        ]}
      />,
    );

    expect(screen.getByRole('button', { name: '提交申请' })).toBeDisabled();
  });

  it('⚠️ 补差金额与整期应结金额分开显示（混在一起商家会以为重复了）', () => {
    render(
      <PayoutApplyForm
        periods={[
          {
            period: '2025-07',
            receiptAmount: 10000,
            commissionAmount: 2000,
            netAmount: 8000,
            entryCount: 1,
            statementStatus: 'PAID',
            alreadyApplied: true,
            appliedKind: 'NORMAL',
            supplementAvailable: true,
            supplementAmount: 5000,
          },
        ]}
      />,
    );

    // ⚠️ **整期应结 ¥80.00 与补差 ¥50.00 是两个不同的数**：
    //    前者是「这一期总共应结多少」，后者是「还能再拿多少」。
    expect(
      screen.getByText(/货款净额 ¥100\.00 · 平台佣金 ¥20\.00 · 应结 ¥80\.00/),
    ).toBeInTheDocument();
    // ⚠️ **整段匹配**：下拉框的选项文案里也有「可申请补差 ¥50.00」，
    //    单个片段会撞成「多个元素」。
    expect(
      screen.getByText(/可申请补差 ¥50\.00（原结算单已结清，补差按零佣金结算）/),
    ).toBeInTheDocument();
  });

  it('⚠️ 补差单本身不给出第二个补差入口（选项文案说明已补差出款）', () => {
    render(
      <PayoutApplyForm
        periods={[
          {
            period: '2025-07',
            receiptAmount: 10000,
            commissionAmount: 2000,
            netAmount: 8000,
            entryCount: 1,
            statementStatus: 'PAID',
            alreadyApplied: true,
            appliedKind: 'SUPPLEMENT',
            supplementAvailable: false,
            supplementAmount: null,
          },
        ]}
      />,
    );

    const options = screen.getAllByRole('option');
    expect(options[0]?.textContent).toContain('已补差出款');
    expect(screen.getByRole('button', { name: '提交申请' })).toBeDisabled();
  });

  it('⚠️ 补差入口提交时请求体里仍然只有 period（前端不传 kind）', async () => {
    const user = userEvent.setup();
    render(
      <PayoutApplyForm
        periods={[
          {
            period: '2025-07',
            receiptAmount: 10000,
            commissionAmount: 2000,
            netAmount: 8000,
            entryCount: 1,
            statementStatus: 'PAID',
            alreadyApplied: true,
            appliedKind: 'NORMAL',
            supplementAvailable: true,
            supplementAmount: 5000,
          },
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: '申请补差' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // ⚠️ **请求体里只有 `period`**：后端自己判断走正常单还是补差单，
    //    前端传 `kind` 也会被中转路由的白名单丢掉。
    const { body } = callWithBody(fetchMock);
    expect(Object.keys(body)).toEqual(['period']);
    expect(body.period).toBe('2025-07');
  });
});
