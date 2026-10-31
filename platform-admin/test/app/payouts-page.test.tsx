/**
 * 平台出款单列表页（Server Component）的页面级测试。
 *
 * ⚠️ **遍历元素树而不是渲染 HTML**：页面上有 `next/link`，
 * 在 Next 运行时之外渲染它可能抛错。直接 `await PayoutsPage(...)`
 * 拿到元素树，只读 `props.children`，**不执行任何组件函数**。
 *
 * ⚠️ **这一页最要紧的护栏是「前端不自己算金额」**：
 * 把 `payout.netAmount` 换成「把货款净额与佣金加总一遍」时，
 * 应结金额会从 ¥999.99 变成 ¥-2.00 —— 而那笔账是错的。
 * 所以这里构造**故意对不上**的数据来锁住它。
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

import PayoutsPage from '@/app/(dashboard)/payouts/page';
import type { PayoutListResult } from '@/lib/payout';

import {
  collectClassNames,
  collectHrefs,
  collectText,
  hasText,
} from '../helpers/page-tree';

/**
 * ⚠️ **故意对不上**：
 * 单据的应结金额是 99999 分 = ¥999.99；
 * 货款净额 100 分、佣金 300 分 → 差 = -200 分 = ¥-2.00。
 * 页面若自己加总，应结金额格显示的就是 ¥-2.00。
 */
const LIST: PayoutListResult = {
  items: [
    {
      id: 'payout-1',
      payoutNo: 'PAY202601010000001234',
      periodLabel: '2026-01',
      receiptAmount: 100,
      commissionAmount: 300,
      netAmount: 99999,
      entryCount: 2,
      status: 'REQUESTED',
      requestedAmount: 88888,
      requestedAt: '2026-02-01T00:00:00.000Z',
      approvedAt: null,
      cancelledAt: null,
      rejectedReason: null,
      kind: 'NORMAL',
      attemptCount: 0,
      failureReason: null,
      payoutChannel: null,
      processingAt: null,
      paidAt: null,
      failedAt: null,
      tenantId: 'tenant-1',
      tenantName: '示例店铺',
      subdomain: 'demo',
      // ⚠️ **收款账户快照（阶段 5j 补强）**：后端每条视图都带这三个字段，
      //    列表页不渲染它们，但类型上它们是必填的。
      snapshotAccountName: '张三',
      snapshotBankName: '招商银行',
      maskedSnapshotAccountNo: '************1234',
    },
  ],
  total: 1,
};

/** 渲染页面并收集文字 */
async function renderPage(
  params: { period?: string; page?: string; pageSize?: string } = {},
): Promise<string[]> {
  const element = await PayoutsPage({
    searchParams: Promise.resolve(params),
  });
  return collectText(element);
}

/** 渲染页面并收集链接地址 */
async function renderHrefs(
  params: { period?: string; page?: string; pageSize?: string } = {},
): Promise<string[]> {
  const element = await PayoutsPage({
    searchParams: Promise.resolve(params),
  });
  return collectHrefs(element);
}

beforeEach(() => {
  vi.clearAllMocks();
  apiFetchAuthedMock.mockResolvedValue(LIST);
});

describe('出款单列表页：周期来自 URL', () => {
  it('不给周期 → 路径里没有 period（列出全部）', async () => {
    await renderPage();

    expect(apiFetchAuthedMock).toHaveBeenCalledTimes(1);
    const [path] = apiFetchAuthedMock.mock.calls[0] as [string];
    // ⚠️ **精确匹配而不是 `toContain`**：`toContain('/platform/payouts')`
    //    连 `/platform/payoutsXYZ` 也放得过，路径写歪了照样绿。
    expect(path).toBe('/platform/payouts?page=1&pageSize=100');
  });

  it('给了周期 → 路径里带 period', async () => {
    await renderPage({ period: '2026-01' });

    const [path] = apiFetchAuthedMock.mock.calls[0] as [string];
    // ⚠️ **精确匹配**：参数顺序与编码方式都锁死。
    expect(path).toBe('/platform/payouts?period=2026-01&page=1&pageSize=100');
  });

  it('⚠️ 两种路径都带 pageSize=100（后端 clampPagination 的上限就是 100）', async () => {
    // ⚠️ 少了这个参数 → 后端退回默认页大小 → 单据多时被静默截断，
    //    页面看上去「只有这些单据」→ 平台据此打款会漏打。
    await renderPage();
    const [withoutPeriod] = apiFetchAuthedMock.mock.calls[0] as [string];
    expect(withoutPeriod).toBe('/platform/payouts?page=1&pageSize=100');

    apiFetchAuthedMock.mockClear();
    await renderPage({ period: '2026-01' });
    const [withPeriod] = apiFetchAuthedMock.mock.calls[0] as [string];
    expect(withPeriod).toBe('/platform/payouts?period=2026-01&page=1&pageSize=100');
  });

  it('⚠️ 周期格式非法 → 提示，且根本不调后端', async () => {
    const texts = await renderPage({ period: '2026-13' });

    expect(hasText(texts, '周期格式非法')).toBe(true);
    // ⚠️ **非法周期的明细比没有明细更糟**：所以压根不调后端。
    expect(apiFetchAuthedMock).not.toHaveBeenCalled();
  });
});

describe('出款单列表页：翻页（阶段 5l）', () => {
  it('⚠️ 页码与每页条数从 URL 读', async () => {
    await renderPage({ page: '3', pageSize: '20' });

    const [path] = apiFetchAuthedMock.mock.calls[0] as [string];
    expect(path).toBe('/platform/payouts?page=3&pageSize=20');
  });

  it('⚠️ 非法页码落回第 1 页', async () => {
    await renderPage({ page: '0' });
    const [zeroPage] = apiFetchAuthedMock.mock.calls[0] as [string];
    expect(zeroPage).toBe('/platform/payouts?page=1&pageSize=100');
  });

  it('⚠️ 翻页链接必须带上 period（否则筛选被悄悄重置）', async () => {
    apiFetchAuthedMock.mockResolvedValue({ ...LIST, total: 250 });

    const hrefs = await renderHrefs({ period: '2026-01' });

    // ⚠️ **漏掉 period 的话超管筛完周期一翻页，筛选就被重置成「全部周期」**，
    //    看到的是一份完全不相干的列表。
    expect(hrefs).toContain('?period=2026-01&page=2&pageSize=100');
  });

  it('⚠️ 只有一页时不显示翻页控件', async () => {
    const hrefs = await renderHrefs();

    expect(hrefs.some((href) => href.includes('page=2'))).toBe(false);
  });

  it('⚠️ 多页时有翻页链接', async () => {
    apiFetchAuthedMock.mockResolvedValue({ ...LIST, total: 250 });

    const hrefs = await renderHrefs();

    expect(hrefs).toContain('?page=2&pageSize=100');
  });

  it('⚠️ 每页条数三档都有链接（20 / 50 / 100）', async () => {
    const hrefs = await renderHrefs();

    expect(hrefs).toContain('?page=1&pageSize=20');
    expect(hrefs).toContain('?page=1&pageSize=50');
    expect(hrefs).toContain('?page=1&pageSize=100');
  });
});

describe('出款单列表页：金额一律用后端返回的值', () => {
  it('⚠️ 应结金额是后端给的值，不是前端把货款与佣金加总出来的', async () => {
    const texts = await renderPage();

    // ⚠️ **这条是护栏「前端不自己算金额」的直接锁**：
    // 后端给的应结金额是 99999 分 → ¥999.99；
    // 前端自己加总的话是 100 − 300 = −200 分 → ¥-2.00。
    expect(hasText(texts, '¥999.99')).toBe(true);
    expect(hasText(texts, '¥-2.00')).toBe(false);
  });

  it('货款净额与佣金也分别显示出来', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '¥1.00')).toBe(true);
    expect(hasText(texts, '¥3.00')).toBe(true);
  });

  it('⚠️ 笔数必须整段精确匹配', async () => {
    const texts = await renderPage();

    // ⚠️ **光断言 `hasText(texts, '2')` 是假阳性** —— 页面上还有
    //    `2026-01`、`¥999.99` 等，全都含 "2"。
    //    `expect(texts).toContain('2')` 是**同一个假阳性**（子串匹配）。
    //    页面渲染成「2 笔」后，「2 笔」才是能锁住笔数的整段匹配。
    expect(hasText(texts, '2 笔')).toBe(true);
  });

  it('状态显示中文文案', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '待审批')).toBe(true);
    expect(hasText(texts, 'REQUESTED')).toBe(false);
  });

  it('⚠️ 已拒绝状态也翻成中文（REJECTED 不是页面上该出现的裸枚举）', async () => {
    apiFetchAuthedMock.mockResolvedValue({
      ...LIST,
      items: [{ ...LIST.items[0], status: 'REJECTED' as const }],
    });

    const texts = await renderPage();

    expect(hasText(texts, '已拒绝')).toBe(true);
    expect(hasText(texts, 'REJECTED')).toBe(false);
  });

  it('显示商家名、单号与周期', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '示例店铺')).toBe(true);
    expect(hasText(texts, 'PAY202601010000001234')).toBe(true);
    expect(hasText(texts, '2026-01')).toBe(true);
  });

  it('⚠️ 表头把货款净额 / 佣金 / 应结金额三列分开列出来', async () => {
    const texts = await renderPage();

    // ⚠️ **三列必须分开**：合在一列里的界面没法核对货款与佣金。
    expect(hasText(texts, '货款净额')).toBe(true);
    expect(hasText(texts, '佣金')).toBe(true);
    expect(hasText(texts, '应结金额')).toBe(true);
  });
});

describe('出款单列表页：取数失败', () => {
  it('⚠️ 取数失败时显示错误提示，且不崩', async () => {
    const { ApiError } = await vi.importActual<
      typeof import('@/lib/api-client')
    >('@/lib/api-client');
    apiFetchAuthedMock.mockRejectedValue(
      new ApiError(500, 'INTERNAL', '后端炸了'),
    );

    const texts = await renderPage();

    expect(hasText(texts, '加载出款单失败')).toBe(true);
    expect(hasText(texts, '500')).toBe(true);
  });

  it('⚠️ 取数失败（非 ApiError）时也有提示', async () => {
    apiFetchAuthedMock.mockRejectedValue(new Error('网络断了'));

    const texts = await renderPage();

    expect(hasText(texts, '网络断了')).toBe(true);
  });
});

describe('出款单列表页：空数据', () => {
  it('没有出款单时显示「暂无出款单。」而不是空白表', async () => {
    apiFetchAuthedMock.mockResolvedValue({ items: [], total: 0 });

    const texts = await renderPage();

    expect(hasText(texts, '暂无出款单。')).toBe(true);
  });

  it('⚠️ total 大于本页条数时提示「还有更多」', async () => {
    apiFetchAuthedMock.mockResolvedValue({ ...LIST, total: 120 });

    const texts = await renderPage();

    expect(hasText(texts, '共 120 张')).toBe(true);
    expect(hasText(texts, '本页显示 1 张')).toBe(true);
  });

  it('⚠️ total 不大于本页条数时不说「还有更多」', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '共 1 张')).toBe(true);
    expect(hasText(texts, '本页显示')).toBe(false);
  });
});

describe('出款单列表页：类型与执行状态（阶段 5h-2）', () => {
  it('⚠️ 列表显示「补差出款」标记（补差是增量，不能混在正常出款里）', async () => {
    apiFetchAuthedMock.mockResolvedValue({
      ...LIST,
      items: [{ ...LIST.items[0], kind: 'SUPPLEMENT' as const }],
    });

    const texts = await renderPage();

    expect(hasText(texts, '补差出款')).toBe(true);
    // ⚠️ **类型不能是裸枚举**：页面上直接显示 `SUPPLEMENT` 就是把后端内部标识漏出去。
    expect(hasText(texts, 'SUPPLEMENT')).toBe(false);
  });

  it('⚠️ 正常出款显示「正常出款」', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '正常出款')).toBe(true);
  });

  it('表头里有「类型」这一列', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '类型')).toBe(true);
  });

  it('⚠️ 出款失败时显示失败原因与尝试次数', async () => {
    apiFetchAuthedMock.mockResolvedValue({
      ...LIST,
      items: [
        {
          ...LIST.items[0],
          status: 'FAILED' as const,
          failureReason: '收款账户校验不通过',
          attemptCount: 3,
        },
      ],
    });

    const texts = await renderPage();

    expect(hasText(texts, '出款失败')).toBe(true);
    expect(hasText(texts, '收款账户校验不通过')).toBe(true);
    expect(hasText(texts, '已尝试 3 次')).toBe(true);
  });

  it('⚠️ 不是失败状态时不显示失败原因', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '失败原因')).toBe(false);
    expect(hasText(texts, '已尝试')).toBe(false);
  });

  it('⚠️ 「打款中」超过 10 分钟的单标红（卡住了，要人工去查）', async () => {
    apiFetchAuthedMock.mockResolvedValue({
      ...LIST,
      items: [
        {
          ...LIST.items[0],
          status: 'PROCESSING' as const,
          // ⚠️ **20 分钟前**开始的打款 —— 早过了 10 分钟的阈值。
          processingAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
        },
      ],
    });

    const element = await PayoutsPage({
      searchParams: Promise.resolve({}),
    });

    // ⚠️ **标红是唯一的前端动作**：后端绝不自动重试卡住的单
    //    （钱可能已经打出去，重试等于确定性地重复打款）。
    expect(collectClassNames(element).some((name) => name.includes('text-destructive'))).toBe(
      true,
    );
  });

  it('⚠️ 「打款中」不到 10 分钟不标红', async () => {
    apiFetchAuthedMock.mockResolvedValue({
      ...LIST,
      items: [
        {
          ...LIST.items[0],
          status: 'PROCESSING' as const,
          // ⚠️ **2 分钟前** —— 还在正常范围内。
          processingAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
        },
      ],
    });

    const element = await PayoutsPage({
      searchParams: Promise.resolve({}),
    });

    expect(
      collectClassNames(element).some((name) => name.includes('text-destructive')),
    ).toBe(false);
  });
});

describe('出款单列表页：详情页链接', () => {
  it('⚠️ 每一行都有指向详情页的链接（超管要能点进去审批）', async () => {
    const hrefs = await renderHrefs();

    expect(hrefs).toContain('/payouts/payout-1');
  });
});
