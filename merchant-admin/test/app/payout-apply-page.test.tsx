/**
 * 商家侧「申请出款」页（Server Component）的页面级测试。
 *
 * ⚠️ **遍历元素树而不是渲染 HTML**：页面上有客户端组件，
 * 在 Next 运行时之外渲染它可能抛错。直接 `await PayoutApplyPage()`
 * 拿到元素树，只读 `props.children` 与**组件收到的 props**。
 *
 * ⚠️ **这一页最要紧的护栏是「商家不能自己填金额」**：
 * 页面上**没有金额输入框** —— 能选周期、能看到的金额全是后端算的。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ⚠️ **`@/auth` 必须 mock 掉**：`@/lib/api-client` 会 import 它，
// 而 `next-auth` 会间接 import `next/server` —— 那是 ESM 下的路径别名，
// 在 node 环境下直接 import 会抛 `ERR_MODULE_NOT_FOUND`。
vi.mock('@/auth', () => ({ auth: vi.fn() }));

const { apiFetchAuthedMock } = vi.hoisted(() => ({
  apiFetchAuthedMock: vi.fn(),
}));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>(
    '@/lib/api-client',
  );
  return {
    ...actual,
    apiFetchAuthed: apiFetchAuthedMock,
  };
});

import PayoutApplyPage from '@/app/(dashboard)/settlements/apply/page';
import { PayoutApplyForm } from '@/app/(dashboard)/settlements/apply/apply-form';
import type { AvailablePeriod, PayoutAccount } from '@/lib/payout';

import { collectComponentProps, collectText, hasText } from '../helpers/page-tree';

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
];

/**
 * 收款账户（阶段 5j 之后账号是密文，响应里只给掩码串）。
 *
 * ⚠️ **没有 `accountNo` 字段** —— 完整账号压根不进浏览器。
 */
const ACCOUNT: PayoutAccount = {
  accountName: '示例商户',
  bankName: '示例银行',
  maskedAccountNo: '6222 **** **** 1234',
  updatedAt: '2026-02-01T00:00:00.000Z',
};

/** 渲染页面并收集文字 */
async function renderPage(): Promise<string[]> {
  const element = await PayoutApplyPage();
  return collectText(element);
}

beforeEach(() => {
  vi.clearAllMocks();
  // ⚠️ **按路径分别返回**：页面现在打两个接口
  //    （可申请周期 + 收款账户）—— 都返回 `PERIODS` 的话，
  //    账户那一路的字段全是 `undefined`，测不出东西。
  apiFetchAuthedMock.mockImplementation(async (path: string) => {
    if (path === '/merchant/payout-account') return ACCOUNT;
    return PERIODS;
  });
});

describe('申请出款页：取数', () => {
  it('打到商家侧的 /merchant/payouts/available-periods', async () => {
    await renderPage();

    const paths = apiFetchAuthedMock.mock.calls.map(
      (call) => (call as [string])[0],
    );
    // ⚠️ **精确匹配而不是 `toContain`**：路径写歪了照样绿的写法。
    expect(paths).toContain('/merchant/payouts/available-periods');
  });

  it('⚠️ 也取当前收款账户（商家提交前得看出「钱会打到哪」）', async () => {
    await renderPage();

    const paths = apiFetchAuthedMock.mock.calls.map(
      (call) => (call as [string])[0],
    );
    expect(paths).toContain('/merchant/payout-account');
  });
});

describe('申请出款页：收款账户可见性（阶段 5j）', () => {
  it('⚠️ 显示「本次出款将打到…」并带上开户行与掩码账号', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '本次出款将打到')).toBe(true);
    expect(hasText(texts, '示例银行')).toBe(true);
    expect(hasText(texts, '6222 **** **** 1234')).toBe(true);
  });

  it('⚠️ 只显示掩码账号，绝不显示完整账号', async () => {
    const texts = await renderPage();

    // ⚠️ **完整账号压根不在响应里** —— 界面上更不能凭空拼一个出来。
    expect(hasText(texts, '完整账号')).toBe(false);
    expect(hasText(texts, '6222123412341234')).toBe(false);
  });
});

describe('申请出款页：金额全部由后端算', () => {
  it('⚠️ 把后端给的周期与金额原样传给表单（不自己算）', async () => {
    const element = await PayoutApplyPage();
    const propsList = collectComponentProps(element, PayoutApplyForm);

    expect(propsList).toHaveLength(1);
    const periods = propsList[0].periods as AvailablePeriod[];
    // ⚠️ **断言的是「后端给的原值」**：页面若自己把货款与佣金加总一遍，
    //    应结金额会从 900 分变成 200 分。
    expect(periods[0].netAmount).toBe(900);
    expect(periods[0].receiptAmount).toBe(500);
    expect(periods[0].commissionAmount).toBe(300);
  });

  it('⚠️ 页面上没有金额输入框（商家不能自己填金额）', async () => {
    const element = await PayoutApplyPage();
    const propsList = collectComponentProps(element, PayoutApplyForm);

    // ⚠️ **表单只收 `periods` 一个 prop**：多一个 `amount` 之类的 prop
    //    就说明「金额可以由前端决定」的入口开了。
    expect(Object.keys(propsList[0]).sort()).toEqual(['periods']);
  });
});

describe('申请出款页：取数失败', () => {
  it('⚠️ 取数失败时显示错误提示，且不崩', async () => {
    const { ApiError } = await vi.importActual<
      typeof import('@/lib/api-client')
    >('@/lib/api-client');
    apiFetchAuthedMock.mockRejectedValue(
      new ApiError(500, 'INTERNAL', '后端炸了'),
    );

    const texts = await renderPage();

    expect(hasText(texts, '加载可申请周期失败')).toBe(true);
    expect(hasText(texts, '后端炸了')).toBe(true);
  });

  it('⚠️ 取数失败（非 ApiError）时也有提示', async () => {
    apiFetchAuthedMock.mockRejectedValue(new Error('网络断了'));

    const texts = await renderPage();

    expect(hasText(texts, '网络断了')).toBe(true);
  });
});

describe('申请出款页：文案', () => {
  it('说明金额由平台算出来', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '申请出款')).toBe(true);
    expect(hasText(texts, '平台佣金')).toBe(true);
  });
});
