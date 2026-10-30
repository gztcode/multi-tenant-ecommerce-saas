/**
 * 商家侧对账单列表页（Server Component）的页面级测试。
 *
 * ⚠️ **遍历元素树而不是渲染 HTML**：页面上有 `next/link`，
 * 在 Next 运行时之外渲染它可能抛错。直接 `await StatementsPage()`
 * 拿到元素树，只读 `props.children`，**不执行任何组件函数**。
 *
 * ⚠️ **这一页最要紧的护栏是「前端不自己算金额」**：
 * 用**故意对不上**的数值（货款 ¥5.00 / 佣金 ¥3.00 / 应结 ¥9.00）
 * 才能锁住它 —— 前端若自己加总会得 ¥2.00。
 */
import { isValidElement, type ReactElement, type ReactNode } from 'react';
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

import StatementsPage from '@/app/(dashboard)/statements/page';
import type { StatementPeriod } from '@/lib/statement';

import { collectHrefs, collectText, hasText } from '../helpers/page-tree';

/**
 * ⚠️ **三个金额刻意用三个不同的数值**（货款 ¥5.00 / 佣金 ¥3.00 / 应结 ¥9.00）：
 * 前端若自己加总，5.00 − 3.00 = 2.00，与后端给的 ¥9.00 不同 → 能测出来。
 */
const PERIOD: StatementPeriod = {
  period: '2026-08',
  statementId: 'stmt-1',
  statementStatus: 'PAID',
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
  missingEntryCount: 0,
};

const LIST: StatementPeriod[] = [PERIOD];

/** 渲染页面并收集文字 */
async function renderPage(): Promise<string[]> {
  const element = await StatementsPage();
  return collectText(element);
}

/** 渲染页面并收集链接地址 */
async function renderHrefs(): Promise<string[]> {
  const element = await StatementsPage();
  return collectHrefs(element);
}

/**
 * 取出表格里**数据行**（`<tbody>` 里的 `<tr>`）的每一格文字。
 *
 * ⚠️ **为什么需要它**：表头里有一列就叫「已出款」——
 *    断言「页面出现『已出款』」时，表头会把它顶出来（假阳性）。
 *    而「结算单的 PAID 不能显示成『已出款』」这条护栏，
 *    恰恰要盯的是**结算单状态那一格**。
 */
async function renderRows(): Promise<string[][]> {
  const element = await StatementsPage();
  const rows: string[][] = [];

  const visit = (node: unknown): void => {
    if (node === null || node === undefined || typeof node === 'boolean') return;
    if (typeof node === 'string' || typeof node === 'number') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!isValidElement(node)) return;
    const el = node as ReactElement<Record<string, unknown>>;
    const children = el.props?.children as ReactNode;
    // 只在 <tbody> 里找 <tr>（表头的 <tr> 在 <thead> 里，不算数）。
    if (el.type === 'tbody') {
      const trs = Array.isArray(children) ? children : [children];
      for (const tr of trs) {
        if (!isValidElement(tr)) continue;
        const tds = (tr as ReactElement<Record<string, unknown>>).props
          ?.children as ReactNode;
        const cells = (Array.isArray(tds) ? tds : [tds]).filter((cell) =>
          isValidElement(cell),
        ) as ReactElement<Record<string, unknown>>[];
        rows.push(
          cells.map((cell) => collectText(cell.props?.children).join('')),
        );
      }
      return;
    }
    visit(children);
  };

  visit(element);
  return rows;
}

beforeEach(() => {
  vi.clearAllMocks();
  apiFetchAuthedMock.mockResolvedValue(LIST);
});

describe('对账单列表页：取数', () => {
  it('⚠️ 打到商家侧的 /merchant/statements（精确匹配）', async () => {
    await renderPage();

    expect(apiFetchAuthedMock).toHaveBeenCalledTimes(1);
    const [path] = apiFetchAuthedMock.mock.calls[0] as [string];
    // ⚠️ **精确匹配而不是 `toContain`**：`toContain('/merchant/statements')`
    //    连 `/merchant/statementsXYZ` 也放得过，路径写歪了照样绿。
    expect(path).toBe('/merchant/statements');
  });
});

describe('对账单列表页：金额一律用后端返回的值', () => {
  it('⚠️ 应结金额是后端给的值，不是前端把货款与佣金加总出来的', async () => {
    const texts = await renderPage();

    // ⚠️ **这条是护栏「前端不自己算金额」的直接锁**：
    // 后端给的应结金额是 900 分 → ¥9.00；
    // 前端自己加总的话是 500 − 300 = 200 分 → ¥2.00。
    expect(hasText(texts, '¥9.00')).toBe(true);
    expect(hasText(texts, '¥2.00')).toBe(false);
  });

  it('货款净额与平台佣金也分别显示出来', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '¥5.00')).toBe(true);
    expect(hasText(texts, '¥3.00')).toBe(true);
  });

  it('⚠️ 佣金为 null 时显示「—」（不是 ¥0.00）', async () => {
    apiFetchAuthedMock.mockResolvedValue([
      {
        ...PERIOD,
        statementId: null,
        statementStatus: null,
        commissionAmount: null,
        payableAmount: null,
        pendingAmount: null,
      },
    ]);

    const rows = await renderRows();

    // ⚠️ **佣金 / 应结 / 待出款三列都要是「—」**：
    //    填 0 会让商家以为「这一期不用扣佣」，而真相是「佣金还没算」。
    const cells = rows[0];
    expect(cells[3]).toBe('—'); // 平台佣金
    expect(cells[4]).toBe('—'); // 应结金额
    expect(cells[6]).toBe('—'); // 待出款
  });
});

describe('对账单列表页：结算单状态文案', () => {
  it('⚠️ PAID 显示「已结算」而不是「已出款」', async () => {
    const rows = await renderRows();

    // ⚠️ **结算单与出款单是两回事**：结算单的 PAID 说的是
    //    「这一期的佣金定了」，出款单说的才是「钱打给你了」。
    // ⚠️ **只看「结算单状态」那一格**（第 2 格）：表头里本来就有一列
    //    叫「已出款」，整页断言会被表头顶成假阳性。
    expect(rows[0][1]).toBe('已结算');
    expect(rows[0][1]).not.toContain('已出款');
  });

  it('⚠️ 不显示裸枚举', async () => {
    const texts = await renderPage();

    expect(hasText(texts, 'PAID')).toBe(false);
    expect(hasText(texts, 'CONFIRMED')).toBe(false);
  });

  it('⚠️ 没有结算单时显示「待确认」', async () => {
    apiFetchAuthedMock.mockResolvedValue([
      { ...PERIOD, statementId: null, statementStatus: null },
    ]);

    const texts = await renderPage();

    expect(hasText(texts, '待确认')).toBe(true);
  });
});

describe('对账单列表页：状态列', () => {
  it('⚠️ 可申请补差时显示「可申请补差」', async () => {
    apiFetchAuthedMock.mockResolvedValue([
      { ...PERIOD, applicableKind: 'SUPPLEMENT' as const },
    ]);

    const texts = await renderPage();

    expect(hasText(texts, '可申请补差')).toBe(true);
    expect(hasText(texts, '可申请出款')).toBe(false);
  });

  it('可申请正常出款时显示「可申请出款」', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '可申请出款')).toBe(true);
  });

  it('⚠️ 不能申请时显示原因', async () => {
    apiFetchAuthedMock.mockResolvedValue([
      {
        ...PERIOD,
        applicableKind: null,
        blockedReason: '该期结算单尚未确认',
      },
    ]);

    const texts = await renderPage();

    expect(hasText(texts, '该期结算单尚未确认')).toBe(true);
    expect(hasText(texts, '可申请出款')).toBe(false);
  });

  it('⚠️ 超付时显示「已超付」与「待平台调账」', async () => {
    apiFetchAuthedMock.mockResolvedValue([
      { ...PERIOD, overpaidAmount: 200, payableAmount: 700 },
    ]);

    const texts = await renderPage();

    expect(hasText(texts, '已超付')).toBe(true);
    expect(hasText(texts, '待平台调账')).toBe(true);
  });

  it('⚠️ 什么都没发生时显示「—」', async () => {
    apiFetchAuthedMock.mockResolvedValue([
      { ...PERIOD, applicableKind: null, blockedReason: null },
    ]);

    const texts = await renderPage();

    expect(hasText(texts, '—')).toBe(true);
  });
});

describe('对账单列表页：缺笔提示', () => {
  it('⚠️ 缺笔时在「结算单状态」那一格下面显示提示', async () => {
    apiFetchAuthedMock.mockResolvedValue([
      { ...PERIOD, missingEntryCount: 2 },
    ]);

    const rows = await renderRows();

    // ⚠️ **只看「结算单状态」那一格**（第 2 格）：
    //    整页断言会被别处的文字顶成假阳性。
    expect(rows[0][1]).toContain('本期结算单缺 2 笔抽佣流水');
    expect(rows[0][1]).toContain('佣金以结算单为准');
  });

  it('⚠️ 不缺笔时不显示缺笔提示', async () => {
    const rows = await renderRows();

    expect(rows[0][1]).not.toContain('缺');
    expect(rows[0][1]).toBe('已结算');
  });

  it('⚠️ 没有结算单的期不显示缺笔提示（缺笔恒为 0）', async () => {
    apiFetchAuthedMock.mockResolvedValue([
      {
        ...PERIOD,
        statementId: null,
        statementStatus: null,
        missingEntryCount: 0,
      },
    ]);

    const rows = await renderRows();

    expect(rows[0][1]).not.toContain('缺');
  });

  it('⚠️ 文案中立：不指责平台、不承诺补钱', async () => {
    apiFetchAuthedMock.mockResolvedValue([
      { ...PERIOD, missingEntryCount: 2 },
    ]);

    const rows = await renderRows();

    expect(rows[0][1]).not.toContain('少扣');
    expect(rows[0][1]).not.toContain('待补记');
    expect(rows[0][1]).not.toContain('补记');
  });
});

describe('对账单列表页：详情页链接', () => {
  it('⚠️ 每一行都有指向详情页的链接', async () => {
    const hrefs = await renderHrefs();

    expect(hrefs).toContain('/statements/2026-08');
  });
});

describe('对账单列表页：取数失败', () => {
  it('⚠️ 取数失败时显示错误提示，且不崩', async () => {
    const { ApiError } = await vi.importActual<
      typeof import('@/lib/api-client')
    >('@/lib/api-client');
    apiFetchAuthedMock.mockRejectedValue(
      new ApiError(500, 'INTERNAL', '后端炸了'),
    );

    const texts = await renderPage();

    expect(hasText(texts, '加载对账单失败')).toBe(true);
    expect(hasText(texts, '后端炸了')).toBe(true);
  });

  it('⚠️ 取数失败（非 ApiError）时也有提示', async () => {
    apiFetchAuthedMock.mockRejectedValue(new Error('网络断了'));

    const texts = await renderPage();

    expect(hasText(texts, '网络断了')).toBe(true);
  });
});

describe('对账单列表页：空数据', () => {
  it('⚠️ 没有货款时显示「还没有货款入账。」而不是空白表', async () => {
    apiFetchAuthedMock.mockResolvedValue([]);

    const texts = await renderPage();

    expect(hasText(texts, '还没有货款入账。')).toBe(true);
  });
});
