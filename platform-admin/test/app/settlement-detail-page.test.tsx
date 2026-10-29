/**
 * 平台结算单详情页（Server Component）的页面级测试。
 *
 * ⚠️ **遍历元素树而不是渲染 HTML**：理由同列表页 ——
 * 页面上有 `next/link`，在 Next 运行时之外渲染它可能抛错。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentType } from 'react';

// ⚠️ **`@/auth` 必须 mock 掉**：理由同列表页。
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

/**
 * ⚠️ **`notFound()` 必须 mock 掉**：它抛的是 Next 的**内部 digest**
 * （App Router 实际抛 `NEXT_HTTP_ERROR_FALLBACK;404`）——
 * 断言那个字符串等于把测试焊死在 Next 的实现细节上，
 * 升级 Next 就会假红。**我们要测的是「页面调用了 `notFound()`」**，
 * 那是页面自己的逻辑。
 */
vi.mock('next/navigation', async () => {
  const actual = await vi.importActual<typeof import('next/navigation')>(
    'next/navigation',
  );
  return {
    ...actual,
    notFound: notFoundMock,
  };
});

import SettlementDetailPage from '@/app/(dashboard)/settlements/[id]/page';
import { SettlementRowActions } from '@/app/(dashboard)/settlements/settlement-actions';
import type { SettlementDetail } from '@/lib/billing';

import { collectComponentProps, collectText, hasText } from '../helpers/page-tree';

/**
 * ⚠️ **净额故意与明细对不上**：后端给的净额是 99999 分 = ¥999.99，
 * 明细两行是 100 与 −300 → 和 = −200 分 = ¥-2.00。
 * 页面若自己加总，净额格显示的就是 ¥-2.00。
 */
const DETAIL: SettlementDetail = {
  id: 'statement-1',
  tenantId: 'tenant-1',
  tenantName: '示例店铺',
  subdomain: 'demo',
  statementNo: 'STL202601010000001234',
  periodStart: '2026-01-01T00:00:00.000Z',
  periodEnd: '2026-02-01T00:00:00.000Z',
  periodLabel: '2026-01',
  grossAmount: 100,
  reversalAmount: -300,
  netAmount: 99999,
  entryCount: 2,
  status: 'CONFIRMED',
  confirmedAt: '2026-02-01T10:00:00.000Z',
  createdAt: '2026-02-01T00:00:00.000Z',
  entries: [
    {
      entryId: 'entry-1',
      orderNo: 'ORD-1',
      type: 'COMMISSION',
      amount: 100,
      rateBps: 500,
      baseAmount: 20000,
      occurredAt: '2026-01-05T00:00:00.000Z',
    },
    {
      entryId: 'entry-2',
      orderNo: 'ORD-2',
      type: 'REVERSAL',
      amount: -300,
      rateBps: 500,
      baseAmount: 20000,
      occurredAt: '2026-01-20T00:00:00.000Z',
    },
  ],
};

/** 渲染页面并收集文字 */
async function renderPage(id = 'statement-1'): Promise<string[]> {
  const element = await SettlementDetailPage({
    params: Promise.resolve({ id }),
  });
  return collectText(element);
}

/** 渲染页面并收集 `SettlementRowActions` 收到的 props */
async function renderRowActionProps(
  id = 'statement-1',
): Promise<Record<string, unknown>[]> {
  const element = await SettlementDetailPage({
    params: Promise.resolve({ id }),
  });
  return collectComponentProps(
    element,
    SettlementRowActions as unknown as ComponentType<unknown>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  apiFetchAuthedMock.mockResolvedValue(DETAIL);
  // ⚠️ 真实的 `notFound()` 抛的是 Next 内部异常；
  //    这里换成一个**好认的**自定义错误，断言时不会跟别的错误混。
  notFoundMock.mockImplementation(() => {
    throw new Error('NOT_FOUND_CALLED');
  });
});

describe('结算单详情页：取数', () => {
  it('按 id 拉详情', async () => {
    await renderPage('statement-1');

    expect(apiFetchAuthedMock).toHaveBeenCalledTimes(1);
    const [path] = apiFetchAuthedMock.mock.calls[0] as [string];
    expect(path).toBe('/platform/settlements/statement-1');
  });

  it('⚠️ 取数失败时显示错误提示，且不崩', async () => {
    const { ApiError } = await vi.importActual<
      typeof import('@/lib/api-client')
    >('@/lib/api-client');
    apiFetchAuthedMock.mockRejectedValue(
      new ApiError(500, 'INTERNAL', '后端炸了'),
    );

    const texts = await renderPage();

    expect(hasText(texts, '加载结算单失败')).toBe(true);
    expect(hasText(texts, '500')).toBe(true);
  });

  it('⚠️ 取数失败（非 ApiError）时也有提示', async () => {
    apiFetchAuthedMock.mockRejectedValue(new Error('网络断了'));

    const texts = await renderPage();

    expect(hasText(texts, '网络断了')).toBe(true);
  });

  it('⚠️ 结算单不存在（404）→ 走 notFound()，不是渲染错误提示', async () => {
    const { ApiError } = await vi.importActual<
      typeof import('@/lib/api-client')
    >('@/lib/api-client');
    apiFetchAuthedMock.mockRejectedValue(
      new ApiError(404, 'NOT_FOUND', '结算单不存在'),
    );

    // ⚠️ **`notFound()` 是抛异常，不是返回值**：
    //    Next.js 靠捕获这个异常渲染 404 页，
    //    所以断言的是「它被调用了」，而不是「页面里有什么文字」。
    //
    // ⚠️ **404 与 500 必须分开**：500 是「服务出错了」（渲染错误提示），
    //    404 是「这张单不存在」（渲染 404 页）。两条混了，
    //    用户看到的会是「加载结算单失败」而不是 404。
    await expect(renderPage()).rejects.toThrow('NOT_FOUND_CALLED');
    expect(notFoundMock).toHaveBeenCalledTimes(1);
  });
});

describe('结算单详情页：金额与状态', () => {
  it('⚠️ 净额是后端给的值，不是前端把明细加总出来的', async () => {
    const texts = await renderPage();

    // ⚠️ **这条是护栏「前端不自己算净额」的直接锁**：
    // 后端给的净额是 99999 分 → ¥999.99；
    // 前端自己加总的话是 100 + (−300) = −200 分 → ¥-2.00。
    expect(hasText(texts, '¥999.99')).toBe(true);
    expect(hasText(texts, '¥-2.00')).toBe(false);
  });

  it('⚠️ 冲回显示成负数', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '¥-3.00')).toBe(true);
  });

  it('⚠️ 净额为负时显示成 ¥-50.00（平台倒欠商家钱）', async () => {
    apiFetchAuthedMock.mockResolvedValue({ ...DETAIL, netAmount: -5000 });

    const texts = await renderPage();

    // ⚠️ **负净额是真实场景**：某商家本期只有退款冲回、没有新的抽佣，
    //    平台这一期倒欠商家钱。显示成 `¥-50.00` 才对 ——
    //    写成 `-¥50.00` 或 `¥NaN` 都是把账算错了。
    expect(hasText(texts, '¥-50.00')).toBe(true);
    expect(hasText(texts, 'NaN')).toBe(false);
  });

  it('毛额与笔数也显示出来', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '¥1.00')).toBe(true);
    expect(hasText(texts, '2 笔')).toBe(true);
  });

  it('显示状态的中文文案与单号', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '已确认')).toBe(true);
    expect(hasText(texts, 'CONFIRMED')).toBe(false);
    expect(hasText(texts, 'STL202601010000001234')).toBe(true);
  });

  it('显示商家名与周期', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '示例店铺')).toBe(true);
    expect(hasText(texts, '2026-01')).toBe(true);
  });

  it('⚠️ 已确认的单据显示「确认于」时间', async () => {
    const texts = await renderPage();

    // ⚠️ **只断言「确认于」这三个字，不断言具体时间串**：
    //    `formatDateTime` 走 `toLocaleString`，结果依赖运行时的时区 ——
    //    断言「2026/2/1 18:00:00」这种具体值，换个 TZ 就假红。
    expect(hasText(texts, '确认于')).toBe(true);
  });
});

describe('结算单详情页：明细', () => {
  it('每一行显示自己的金额、类型与费率', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '¥1.00')).toBe(true);
    expect(hasText(texts, '抽佣')).toBe(true);
    expect(hasText(texts, '退款冲回')).toBe(true);
    expect(hasText(texts, '5%')).toBe(true);
    expect(hasText(texts, 'ORD-1')).toBe(true);
  });

  it('⚠️ 明细的六列表头都在', async () => {
    const texts = await renderPage();

    // ⚠️ **六列都要在**：少了「计佣基数」这一列，超管就没法核对
    // 「这笔抽佣是按多少基数算出来的」。
    expect(hasText(texts, '时间')).toBe(true);
    expect(hasText(texts, '订单号')).toBe(true);
    expect(hasText(texts, '类型')).toBe(true);
    expect(hasText(texts, '费率')).toBe(true);
    expect(hasText(texts, '计佣基数')).toBe(true);
  });

  it('⚠️ 计佣基数按后端给的分显示', async () => {
    const texts = await renderPage();

    // 20000 分 = ¥200.00
    expect(hasText(texts, '¥200.00')).toBe(true);
  });

  it('没有明细时显示「暂无明细。」而不是空白表', async () => {
    apiFetchAuthedMock.mockResolvedValue({ ...DETAIL, entries: [] });

    const texts = await renderPage();

    expect(hasText(texts, '暂无明细。')).toBe(true);
  });
});

describe('结算单详情页：客户端组件拿到的 props', () => {
  it('状态操作按钮拿到的是这张单据与它的状态', async () => {
    const actions = await renderRowActionProps('statement-1');

    // ⚠️ **状态必须原样传下去**：按钮要根据状态决定显示「确认」
    // 还是「取消确认」，传错状态就等于给了错的操作。
    expect(actions).toHaveLength(1);
    expect(actions[0].statementId).toBe('statement-1');
    expect(actions[0].status).toBe('CONFIRMED');
  });
});
