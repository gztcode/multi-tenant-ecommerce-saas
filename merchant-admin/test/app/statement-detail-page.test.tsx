/**
 * 商家侧对账单详情页（Server Component）的页面级测试。
 *
 * ⚠️ **遍历元素树而不是渲染 HTML**：页面上有 `next/link`，
 * 在 Next 运行时之外渲染它可能抛错。直接 `await StatementDetailPage(...)`
 * 拿到元素树，只读 `props.children`。
 *
 * ⚠️ **`next/navigation` 必须 mock 掉**：详情页要调 `notFound()`
 *    处理 404，而 `notFound()` 在测试环境里会抛一个特殊错误。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ⚠️ **`@/auth` 必须 mock 掉**：`@/lib/api-client` 会 import 它，
// 而 `next-auth` 会间接 import `next/server` —— 那是 ESM 下的路径别名，
// 在 node 环境下直接 import 会抛 `ERR_MODULE_NOT_FOUND`。
vi.mock('@/auth', () => ({ auth: vi.fn() }));

const { apiFetchAuthedMock, notFoundMock } = vi.hoisted(() => ({
  apiFetchAuthedMock: vi.fn(),
  notFoundMock: vi.fn(),
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

vi.mock('next/navigation', () => ({
  notFound: notFoundMock,
}));

import StatementDetailPage from '@/app/(dashboard)/statements/[period]/page';
import type { StatementPeriodDetail } from '@/lib/statement';

import { collectHrefs, collectText, hasText } from '../helpers/page-tree';

/**
 * ⚠️ **三个金额刻意用三个不同的数值**（货款 ¥5.00 / 佣金 ¥3.00 / 应结 ¥9.00）：
 * 前端若自己加总会得 ¥2.00，与后端给的 ¥9.00 不同 → 能测出来。
 */
const DETAIL: StatementPeriodDetail = {
  period: '2026-08',
  statementId: 'stmt-1',
  statementStatus: 'CONFIRMED',
  receiptAmount: 500,
  receiptCount: 2,
  commissionAmount: 300,
  commissionEntryCount: 2,
  payableAmount: 900,
  paidAmount: 0,
  inFlightAmount: 0,
  pendingAmount: 900,
  overpaidAmount: 0,
  applicableKind: 'NORMAL',
  blockedReason: null,
  commissionEntries: [
    {
      entryId: 'ce-1',
      orderNo: 'ORD-C1',
      type: 'COMMISSION',
      baseAmount: 6000,
      rateBps: 500,
      amount: 300,
      occurredAt: '2026-08-05T10:00:00.000Z',
    },
  ],
  receiptEntries: [
    {
      entryId: 're-1',
      orderNo: 'ORD-R1',
      type: 'SALE',
      amount: 500,
      occurredAt: '2026-08-06T10:00:00.000Z',
      payoutStatus: 'PAID',
    },
    {
      entryId: 're-2',
      orderNo: 'ORD-R2',
      type: 'SALE_REVERSAL',
      amount: -100,
      occurredAt: '2026-08-07T10:00:00.000Z',
      payoutStatus: null,
    },
  ],
};

/** 渲染页面并收集文字 */
async function renderPage(period = '2026-08'): Promise<string[]> {
  const element = await StatementDetailPage({
    params: Promise.resolve({ period }),
  });
  return collectText(element);
}

/** 渲染页面并收集链接地址 */
async function renderHrefs(period = '2026-08'): Promise<string[]> {
  const element = await StatementDetailPage({
    params: Promise.resolve({ period }),
  });
  return collectHrefs(element);
}

beforeEach(() => {
  vi.clearAllMocks();
  apiFetchAuthedMock.mockResolvedValue(DETAIL);
});

describe('对账单详情页：取数', () => {
  it('⚠️ 打到商家侧的 /merchant/statements/:period（精确匹配）', async () => {
    await renderPage();

    expect(apiFetchAuthedMock).toHaveBeenCalledTimes(1);
    const [path] = apiFetchAuthedMock.mock.calls[0] as [string];
    expect(path).toBe('/merchant/statements/2026-08');
  });
});

describe('对账单详情页：金额一律用后端返回的值', () => {
  it('⚠️ 应结金额是后端给的值，不是前端把货款与佣金加总出来的', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '¥9.00')).toBe(true);
    expect(hasText(texts, '¥2.00')).toBe(false);
  });
});

describe('对账单详情页：抽佣明细', () => {
  it('⚠️ 费率显示成百分数（不是 500 bps）', async () => {
    const texts = await renderPage();

    // ⚠️ **`500 bps` 商家看不懂** —— 界面上给的是「5%」。
    expect(hasText(texts, '5%')).toBe(true);
    expect(hasText(texts, '500 bps')).toBe(false);
    expect(hasText(texts, '500')).toBe(false);
  });

  it('⚠️ 显示订单号与类型', async () => {
    const texts = await renderPage();

    expect(hasText(texts, 'ORD-C1')).toBe(true);
    expect(hasText(texts, '抽佣')).toBe(true);
    expect(hasText(texts, 'COMMISSION')).toBe(false);
  });

  it('显示计佣基数与佣金金额', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '¥60.00')).toBe(true);
    expect(hasText(texts, '¥3.00')).toBe(true);
  });

  it('⚠️ 没有抽佣明细时显示「暂无抽佣明细。」', async () => {
    apiFetchAuthedMock.mockResolvedValue({
      ...DETAIL,
      commissionEntries: [],
    });

    const texts = await renderPage();

    expect(hasText(texts, '暂无抽佣明细。')).toBe(true);
  });
});

describe('对账单详情页：货款明细', () => {
  it('⚠️ 标出「已出款」与「未出款」', async () => {
    const texts = await renderPage();

    // ⚠️ **商家最常问的两件事**：「哪笔钱还没给我」与「哪笔已经给了」。
    // ⚠️ **这里必须按「整节点相等」判**，不能用 `hasText`：
    //    页面顶部的汇总行里也有「已出款」（`· 已出款 `），
    //    用 `hasText` 判「已出款」恒为真 → 测不出明细表里的状态。
    expect(texts).toContain('已出款');
    expect(texts).toContain('未出款');
  });

  it('⚠️ 在途的出款单标「出款中」，不是「已出款」', async () => {
    apiFetchAuthedMock.mockResolvedValue({
      ...DETAIL,
      receiptEntries: [
        {
          entryId: 're-1',
          orderNo: 'ORD-R1',
          type: 'SALE',
          amount: 500,
          occurredAt: '2026-08-06T10:00:00.000Z',
          payoutStatus: 'IN_FLIGHT',
        },
      ],
    });

    const texts = await renderPage();

    // ⚠️ **钱还没打** → 显示「已出款」会让商家以为钱已经打过来了，
    //    等不到钱就来投诉。
    expect(texts).toContain('出款中');
    // ⚠️ **`toContain` 对数组是「整节点严格相等」，不是子串包含**：
    //    页面顶部的汇总行产出的是带前后缀的 `"· 已出款 "`，
    //    与明细表里的裸 `"已出款"` 是**两个不同的节点**
    //    → 这条负向断言只会命中明细表，不会被汇总行误伤。
    expect(texts).not.toContain('已出款');
    expect(texts).not.toContain('未出款');
  });

  it('⚠️ 货款类型翻成中文，不显示裸枚举', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '货款入账')).toBe(true);
    expect(hasText(texts, '货款冲回')).toBe(true);
    expect(hasText(texts, 'SALE_REVERSAL')).toBe(false);
  });

  it('⚠️ 没有货款明细时显示「暂无货款明细。」', async () => {
    apiFetchAuthedMock.mockResolvedValue({ ...DETAIL, receiptEntries: [] });

    const texts = await renderPage();

    expect(hasText(texts, '暂无货款明细。')).toBe(true);
  });
});

describe('对账单详情页：口径说明', () => {
  it('⚠️ 页面有「货款按流水实时统计」那句口径说明', async () => {
    const texts = await renderPage();

    // ⚠️ **这句不能省**：商家看到「应结」会变，
    //    必须告诉他为什么（货款实时、佣金以已确认的结算单为准）。
    expect(hasText(texts, '货款按流水实时统计')).toBe(true);
    expect(hasText(texts, '平台佣金以已确认的结算单为准')).toBe(true);
  });
});

describe('对账单详情页：超付', () => {
  it('⚠️ 超付时显示「本期已超付」与「待平台调账。」', async () => {
    apiFetchAuthedMock.mockResolvedValue({
      ...DETAIL,
      overpaidAmount: 200,
      payableAmount: 700,
    });

    const texts = await renderPage();

    expect(hasText(texts, '本期已超付')).toBe(true);
    expect(hasText(texts, '待平台调账。')).toBe(true);
  });

  it('⚠️ 没超付时不显示那句提示', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '本期已超付')).toBe(false);
  });
});

describe('对账单详情页：404', () => {
  it('⚠️ 后端返回 404 时调 notFound()', async () => {
    const { ApiError } = await vi.importActual<
      typeof import('@/lib/api-client')
    >('@/lib/api-client');
    apiFetchAuthedMock.mockRejectedValue(
      new ApiError(404, 'NOT_FOUND', '找不到 2026-08 的对账单数据'),
    );

    await renderPage();

    expect(notFoundMock).toHaveBeenCalledTimes(1);
  });

  it('⚠️ 不是 404 时不调 notFound()，而是显示错误提示', async () => {
    const { ApiError } = await vi.importActual<
      typeof import('@/lib/api-client')
    >('@/lib/api-client');
    apiFetchAuthedMock.mockRejectedValue(
      new ApiError(500, 'INTERNAL', '后端炸了'),
    );

    const texts = await renderPage();

    expect(notFoundMock).not.toHaveBeenCalled();
    expect(hasText(texts, '加载对账单失败')).toBe(true);
    expect(hasText(texts, '后端炸了')).toBe(true);
  });
});

describe('对账单详情页：返回列表的入口', () => {
  it('⚠️ 有指回 /statements 的链接', async () => {
    const hrefs = await renderHrefs();

    expect(hrefs).toContain('/statements');
  });
});
