/**
 * 平台结算单详情页（Server Component）的页面级测试。
 *
 * ⚠️ **遍历元素树而不是渲染 HTML**：理由同列表页 ——
 * 页面上有 `next/link`，在 Next 运行时之外渲染它可能抛错。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ComponentType, type ReactElement, type ReactNode } from 'react';

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

import {
  collectClassNames,
  collectComponentProps,
  collectHrefs,
  collectText,
  hasText,
} from '../helpers/page-tree';

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
  missingEntryCount: 0,
  canRecalculate: true,
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
    searchParams: Promise.resolve({}),
  });
  return collectText(element);
}

/** 渲染页面并收集 `SettlementRowActions` 收到的 props */
async function renderRowActionProps(
  id = 'statement-1',
): Promise<Record<string, unknown>[]> {
  const element = await SettlementDetailPage({
    params: Promise.resolve({ id }),
    searchParams: Promise.resolve({}),
  });
  return collectComponentProps(
    element,
    SettlementRowActions as unknown as ComponentType<unknown>,
  );
}

/**
 * 取出**缺笔修账指引**那一句（不含「本期结算单缺 N 笔」的坏消息）。
 *
 * ⚠️ **为什么要单独定位，而不是整页断言**：
 *    页面上还有 `SettlementRowActions`（客户端组件），
 *    它的按钮文字（「确认」「重算」「取消确认」）与指引文案里
 *    的「重算」「取消确认」**是同一批字**。
 *    整页断言分不清「这句指引说了重算」与「页面上有个重算按钮」。
 *
 * ⚠️ **定位方式**：缺笔块是个 `div`，里面有两个并列的 `<p>` ——
 *    第一个是 `text-destructive` 的坏消息，第二个（`text-muted-foreground`）
 *    才是指引。这里按「`text-destructive` 的 `<p>` 的下一个兄弟 `<p>`」取。
 *
 * ⚠️ **返回 null 而不是空串**：取不到说明缺笔块根本没渲染，
 *    调用方据此断言「没出提示」，而不是拿到空串去 `toContain` 蒙混过关。
 */
async function renderHint(id = 'statement-1'): Promise<string | null> {
  const element = await SettlementDetailPage({
    params: Promise.resolve({ id }),
    searchParams: Promise.resolve({}),
  });

  const visit = (node: unknown): string | null => {
    if (node === null || node === undefined || typeof node === 'boolean') return null;
    if (typeof node === 'string' || typeof node === 'number') return null;
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = visit(child);
        if (found !== null) return found;
      }
      return null;
    }
    if (!isValidElement(node)) return null;

    const el = node as ReactElement<Record<string, unknown>>;
    const children = el.props?.children as ReactNode;
    const list = (Array.isArray(children) ? children : [children]).filter(
      (child): child is ReactElement<Record<string, unknown>> =>
        isValidElement(child),
    );

    // 找到「坏消息」那个 `<p>`（className 带 text-destructive），
    // 取它的下一个兄弟 `<p>` —— 那就是指引。
    for (let index = 0; index < list.length; index += 1) {
      const child = list[index];
      const className = child.props?.className;
      const text = collectText(child.props?.children).join('');
      if (
        typeof className === 'string' &&
        className.includes('text-destructive') &&
        text.includes('本期结算单缺')
      ) {
        const next = list[index + 1];
        if (next) return collectText(next.props?.children).join('');
      }
    }

    return visit(children);
  };

  return visit(element);
}

/**
 * 结算单明细分页接口的响应（阶段 5l）。
 *
 * ⚠️ **明细单独一个端点** —— 详情接口的 `entries` 是无上限全量返回，
 *    页面改用 `/platform/settlements/:id/entries` 取当前页。
 */
const ENTRIES_PAGE = {
  items: DETAIL.entries,
  total: 2,
  page: 1,
  pageSize: 50,
};

/**
 * 只覆盖**详情接口**的返回值，明细分页端点仍走 `ENTRIES_PAGE`。
 *
 * ⚠️ **为什么需要这个**：详情页现在调两个接口，
 *    直接 `mockResolvedValue` 会把**明细也一起覆盖掉** →
 *    改个 `netAmount` 的用例顺带把明细表也改了，测的就不是那件事了。
 */
function mockDetail(detail: unknown): void {
  apiFetchAuthedMock.mockImplementation((path: string) => {
    if (path.includes('/entries')) {
      return Promise.resolve(ENTRIES_PAGE);
    }
    return Promise.resolve(detail);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // ⚠️ **按路径分派**：详情页现在调**两个**接口 ——
  //    ① `/platform/settlements/:id`（单头信息）
  //    ② `/platform/settlements/:id/entries`（明细分页，阶段 5l）
  //    同一个 mock 一律返回 DETAIL 的话，明细表会拿到没有 `items` 的对象。
  apiFetchAuthedMock.mockImplementation((path: string) => {
    if (path.includes('/entries')) {
      return Promise.resolve(ENTRIES_PAGE);
    }
    return Promise.resolve(DETAIL);
  });
  // ⚠️ 真实的 `notFound()` 抛的是 Next 内部异常；
  //    这里换成一个**好认的**自定义错误，断言时不会跟别的错误混。
  notFoundMock.mockImplementation(() => {
    throw new Error('NOT_FOUND_CALLED');
  });
});

describe('结算单详情页：取数', () => {
  it('按 id 拉详情', async () => {
    await renderPage('statement-1');

    const detailCall = apiFetchAuthedMock.mock.calls.find(
      (call) => !(call[0] as string).includes('/entries'),
    );
    expect(detailCall).toBeDefined();
    const [path] = detailCall as [string];
    expect(path).toBe('/platform/settlements/statement-1');
  });

  it('⚠️ 明细走分页端点（阶段 5l，不再全量渲染）', async () => {
    await renderPage('statement-1');

    const entriesCall = apiFetchAuthedMock.mock.calls.find((call) =>
      (call[0] as string).includes('/entries'),
    );
    expect(entriesCall).toBeDefined();
    const [path] = entriesCall as [string];
    expect(path).toBe(
      '/platform/settlements/statement-1/entries?page=1&pageSize=50',
    );
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
    mockDetail({ ...DETAIL, netAmount: -5000 });

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
    // ⚠️ **明细来自分页端点**（阶段 5l），不是详情接口的 `entries`。
    apiFetchAuthedMock.mockImplementation((path: string) => {
      if (path.includes('/entries')) {
        return Promise.resolve({
          items: [],
          total: 0,
          page: 1,
          pageSize: 50,
        });
      }
      return Promise.resolve(DETAIL);
    });

    const texts = await renderPage();

    expect(hasText(texts, '暂无明细。')).toBe(true);
  });
});

describe('结算单详情页：明细分页（阶段 5l）', () => {
  it('⚠️ 明细走分页端点，页码与每页条数从 URL 读', async () => {
    const element = await SettlementDetailPage({
      params: Promise.resolve({ id: 'statement-1' }),
      searchParams: Promise.resolve({ page: '2', pageSize: '20' }),
    });
    void element;

    const entriesCall = apiFetchAuthedMock.mock.calls.find((call) =>
      (call[0] as string).includes('/entries'),
    );
    expect(entriesCall).toBeDefined();
    const [path] = entriesCall as [string];
    expect(path).toBe(
      '/platform/settlements/statement-1/entries?page=2&pageSize=20',
    );
  });

  it('⚠️ 明细翻页链接必须带上 pageSize', async () => {
    apiFetchAuthedMock.mockImplementation((path: string) => {
      if (path.includes('/entries')) {
        return Promise.resolve({
          items: DETAIL.entries,
          total: 120,
          page: 1,
          pageSize: 50,
        });
      }
      return Promise.resolve(DETAIL);
    });

    const element = await SettlementDetailPage({
      params: Promise.resolve({ id: 'statement-1' }),
      searchParams: Promise.resolve({}),
    });
    const hrefs = collectHrefs(element);

    // ⚠️ **漏掉 pageSize 的话翻一次页，每页条数就被重置回默认的 50 条**，
    //    页码与实际条数对不上。
    expect(hrefs).toContain('?page=2&pageSize=50');
  });

  it('⚠️ 明细取数失败时单头信息照样显示（不阻断整页）', async () => {
    const { ApiError } = await vi.importActual<
      typeof import('@/lib/api-client')
    >('@/lib/api-client');
    apiFetchAuthedMock.mockImplementation((path: string) => {
      if (path.includes('/entries')) {
        return Promise.reject(
          new ApiError(500, 'INTERNAL', '明细炸了'),
        );
      }
      return Promise.resolve(DETAIL);
    });

    const texts = await renderPage();

    // ⚠️ **单头信息比明细更要紧**：明细挂了也要能看到这张单的状态与金额。
    expect(hasText(texts, '示例店铺')).toBe(true);
    expect(hasText(texts, '加载结算明细失败')).toBe(true);
  });
});

describe('结算单详情页：缺笔可见（阶段 5j）', () => {
  it('⚠️ 缺笔时详情页给出修账指引', async () => {
    mockDetail({
      ...DETAIL,
      missingEntryCount: 2,
      canRecalculate: true,
    });

    const texts = await renderPage();

    // ⚠️ **缺笔数要出现在页面上**：只说「本期缺笔」不说缺几笔，
    //    超管还是得回列表去数。
    expect(hasText(texts, '缺 2 笔')).toBe(true);
    // ⚠️ **要给得出下一步怎么做**，而不是只报一个坏消息。
    expect(hasText(texts, '重算')).toBe(true);
  });

  it('⚠️ 能重算时指引说「取消确认 → 重算」', async () => {
    mockDetail({
      ...DETAIL,
      missingEntryCount: 2,
      canRecalculate: true,
    });

    const texts = await renderPage();

    // ⚠️ **能修的路径必须写出来**：超管看到「缺笔」却不知道能做什么，
    //    就会去调账（多绕一圈流程，还可能算错）。
    expect(hasText(texts, '取消确认')).toBe(true);
    expect(hasText(texts, '重算')).toBe(true);
    // ⚠️ **不能提调账**：这一期能重算，调账是另一条路。
    expect(hasText(texts, '调账')).toBe(false);
  });

  it('⚠️ 不能重算时（被出款单引用）改指引为调账', async () => {
    mockDetail({
      ...DETAIL,
      missingEntryCount: 2,
      canRecalculate: false,
    });

    const texts = await renderPage();

    // ⚠️ **有出款单引用时 `unconfirm` 会被 409 拦下** ——
    //    这时候还说「可先取消确认再重算」是在指一条走不通的路。
    expect(hasText(texts, '调账')).toBe(true);
    expect(hasText(texts, '不能取消确认')).toBe(true);
    // ⚠️ **不能出现「重算」**：走不通的路不能出现在指引里。
    expect(hasText(texts, '重算')).toBe(false);
  });

  it('⚠️ 草稿单直接说「重算」，不说「先取消确认再重算」', async () => {
    mockDetail({
      ...DETAIL,
      status: 'DRAFT' as const,
      confirmedAt: null,
      missingEntryCount: 2,
      canRecalculate: true,
    });

    const texts = await renderPage();
    const hint = await renderHint();

    // ⚠️ **缺笔数要出现在页面上**（这条护栏与状态无关）。
    expect(hasText(texts, '缺 2 笔')).toBe(true);

    // ⚠️ **只断言「指引那一句」**：页面上还有 `SettlementRowActions`
    //    的按钮文字（「确认」「重算」），整页断言分不清
    //    「这句指引说了重算」与「页面上有个重算按钮」。
    expect(hint).not.toBeNull();
    expect(hint).toContain('可直接「重算」');

    // ⚠️ **草稿单压根没有「取消确认」按钮**（`SettlementRowActions` 里
    //    「取消确认」只在 `status === 'CONFIRMED'` 时渲染）：
    //    给草稿单指「先取消确认再重算」是指了一条走不通的路。
    expect(hint).not.toContain('先「取消确认」再「重算」');
    expect(hint).not.toContain('取消确认');
  });

  it('⚠️ 不缺笔时不出任何缺笔提示', async () => {
    const texts = await renderPage();

    // ⚠️ **不缺笔就不该有缺笔提示**：每次都提醒一遍，
    //    真缺笔的那次就被淹没了。
    expect(hasText(texts, '缺笔')).toBe(false);
    expect(hasText(texts, '缺 0 笔')).toBe(false);
  });

  it('⚠️ 缺笔的提示要标红', async () => {
    mockDetail({
      ...DETAIL,
      missingEntryCount: 2,
      canRecalculate: true,
    });

    const element = await SettlementDetailPage({
      params: Promise.resolve({ id: 'statement-1' }),
      searchParams: Promise.resolve({}),
    });
    const classNames = collectClassNames(element);

    expect(
      classNames.some((name) => name.includes('text-destructive')),
    ).toBe(true);
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
