/**
 * 平台抽佣明细页（Server Component）的页面级测试。
 *
 * ⚠️ **遍历元素树而不是渲染 HTML**：页面上有 `next/link`，
 * 在 Next 运行时之外渲染它可能抛错。直接 `await CommissionsPage(...)`
 * 拿到元素树，只读 `props.children`，**不执行任何组件函数**。
 *
 * ⚠️ **这一页最要紧的护栏是「前端不自己算净额」**（N8）：
 * 把 `merchant.netAmount` 换成「把明细加总一遍」时，
 * 汇总数字会从 ¥999.99 变成 ¥-2.00 —— 而那笔账是错的。
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

import CommissionsPage from '@/app/(dashboard)/commissions/page';
import type { CommissionLedger } from '@/lib/billing';

import { collectText, hasText } from '../helpers/page-tree';

/**
 * ⚠️ **故意对不上**：
 * 明细两行是 100 分与 −300 分 → 和 = −200 分 = ¥-2.00；
 * 而后端给的净额是 99999 分 = ¥999.99。
 * 页面若自己加总，汇总格显示的就是 ¥-2.00。
 */
const LEDGER: CommissionLedger = {
  from: '2026-03-04T05:06:07.000Z',
  to: '2026-11-12T13:14:15.000Z',
  byMerchant: [
    {
      tenantId: 'tenant-1',
      tenantName: '示例店铺',
      subdomain: 'demo',
      netAmount: 99999,
      entryCount: 2,
      reversalCount: 1,
    },
  ],
  entries: [
    {
      id: 'entry-1',
      tenantId: 'tenant-1',
      orderNo: 'ORD-1',
      type: 'COMMISSION',
      amount: 100,
      rateBps: 500,
      baseAmount: 20000,
      occurredAt: '2026-03-04T05:06:07.000Z',
    },
    {
      id: 'entry-2',
      tenantId: 'tenant-1',
      orderNo: 'ORD-2',
      type: 'REVERSAL',
      amount: -300,
      rateBps: 500,
      baseAmount: 20000,
      occurredAt: '2026-11-12T13:14:15.000Z',
    },
  ],
};

async function renderPage(params: {
  from?: string;
  to?: string;
} = {}): Promise<string[]> {
  const element = await CommissionsPage({
    searchParams: Promise.resolve(params),
  });
  return collectText(element);
}

beforeEach(() => {
  vi.clearAllMocks();
  apiFetchAuthedMock.mockResolvedValue(LEDGER);
});

describe('抽佣明细页：区间来自 URL', () => {
  it('⚠️ 不给日期 → 路径里没有 from / to（后端用「最近 30 天」缺省）', async () => {
    await renderPage();

    expect(apiFetchAuthedMock).toHaveBeenCalledTimes(1);
    const [path] = apiFetchAuthedMock.mock.calls[0] as [string];
    // ⚠️ **不能带 from / to**：那个缺省窗口是用**数据库的时钟**算的
    // （护栏 M15），前端自己算「最近 30 天」用的是浏览器的时钟。
    expect(path).not.toContain('from');
    expect(path).not.toContain('to');
    expect(path).toBe('/platform/commissions');
  });

  it('给了两个日期 → 路径里带 from / to', async () => {
    await renderPage({ from: '2026-01-01', to: '2026-01-31' });

    const [path] = apiFetchAuthedMock.mock.calls[0] as [string];
    expect(path).toContain('from=');
    expect(path).toContain('to=');
  });

  it('⚠️ 只给开始日期 → 提示「请同时选择开始与结束日期」，且根本不调后端', async () => {
    const texts = await renderPage({ from: '2026-01-01' });

    expect(hasText(texts, '请同时选择开始与结束日期')).toBe(true);
    // ⚠️ **区间不完整的明细比没有明细更糟**：所以压根不调后端。
    expect(apiFetchAuthedMock).not.toHaveBeenCalled();
  });

  it('⚠️ 只给结束日期 → 同样提示，且根本不调后端', async () => {
    const texts = await renderPage({ to: '2026-01-31' });

    expect(hasText(texts, '请同时选择开始与结束日期')).toBe(true);
    expect(apiFetchAuthedMock).not.toHaveBeenCalled();
  });

  it('⚠️ 结束日期早于开始日期 → 显示那句错误，且根本不调后端', async () => {
    const texts = await renderPage({ from: '2026-02-01', to: '2026-01-01' });

    expect(hasText(texts, '结束日期不能早于开始日期')).toBe(true);
    expect(apiFetchAuthedMock).not.toHaveBeenCalled();
  });
});

describe('抽佣明细页：金额一律用后端返回的值', () => {
  it('⚠️ 净抽佣是后端给的值，不是前端把明细加总出来的', async () => {
    const texts = await renderPage();

    // ⚠️ **这条是护栏 N8「前端不自己算净额」的直接锁**：
    // 后端给的净额是 99999 分 → ¥999.99；
    // 前端自己加总的话是 100 + (−300) = −200 分 → ¥-2.00。
    expect(hasText(texts, '¥999.99')).toBe(true);
    expect(hasText(texts, '¥-2.00')).toBe(false);
  });

  it('明细里每一行显示自己的金额（带符号）', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '¥1.00')).toBe(true);
    expect(hasText(texts, '¥-3.00')).toBe(true);
  });

  it('明细里每一行显示类型与费率', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '抽佣')).toBe(true);
    expect(hasText(texts, '退款冲回')).toBe(true);
    expect(hasText(texts, '5%')).toBe(true);
  });

  it('汇总表显示商家名与子域名（不是 tenantId）', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '示例店铺')).toBe(true);
    expect(hasText(texts, 'demo')).toBe(true);
    expect(hasText(texts, 'tenant-1')).toBe(false);
  });
});

describe('抽佣明细页：取数失败', () => {
  it('⚠️ 取数失败时显示错误提示，且不崩', async () => {
    const { ApiError } = await vi.importActual<
      typeof import('@/lib/api-client')
    >('@/lib/api-client');
    apiFetchAuthedMock.mockRejectedValue(
      new ApiError(500, 'INTERNAL', '后端炸了'),
    );

    const texts = await renderPage();

    expect(hasText(texts, '加载抽佣明细失败')).toBe(true);
    expect(hasText(texts, '500')).toBe(true);
  });

  it('⚠️ 取数失败（非 ApiError）时也有提示', async () => {
    apiFetchAuthedMock.mockRejectedValue(new Error('网络断了'));

    const texts = await renderPage();

    expect(hasText(texts, '网络断了')).toBe(true);
  });
});

describe('抽佣明细页：空数据', () => {
  it('没有流水时显示「暂无流水。」而不是空白表', async () => {
    apiFetchAuthedMock.mockResolvedValue({
      ...LEDGER,
      byMerchant: [],
      entries: [],
    });

    const texts = await renderPage();

    expect(hasText(texts, '暂无流水。')).toBe(true);
  });
});
