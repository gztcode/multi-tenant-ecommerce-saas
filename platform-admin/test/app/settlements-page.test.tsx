/**
 * 平台结算单列表页（Server Component）的页面级测试。
 *
 * ⚠️ **遍历元素树而不是渲染 HTML**：页面上有 `next/link`，
 * 在 Next 运行时之外渲染它可能抛错。直接 `await SettlementsPage(...)`
 * 拿到元素树，只读 `props.children`，**不执行任何组件函数**。
 *
 * ⚠️ **这一页最要紧的护栏是「前端不自己算净额」**：
 * 把 `statement.netAmount` 换成「把毛额与冲回加总一遍」时，
 * 净额会从 ¥999.99 变成 ¥-2.00 —— 而那笔账是错的。
 * 所以这里构造**故意对不上**的数据来锁住它。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ComponentType, type ReactElement, type ReactNode } from 'react';

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

import SettlementsPage from '@/app/(dashboard)/settlements/page';
import {
  SettlementGenerateForm,
  SettlementRowActions,
} from '@/app/(dashboard)/settlements/settlement-actions';
import { TableBody, TableCell, TableRow } from '@/components/ui/table';
import type { SettlementListResult } from '@/lib/billing';

import {
  collectClassNames,
  collectComponentProps,
  collectHrefs,
  collectText,
  hasText,
} from '../helpers/page-tree';

/**
 * ⚠️ **故意对不上**：
 * 单据的净额是 99999 分 = ¥999.99；
 * 毛额 100 分、冲回 -300 分 → 和 = -200 分 = ¥-2.00。
 * 页面若自己加总，净额格显示的就是 ¥-2.00。
 */
const LIST: SettlementListResult = {
  items: [
    {
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
      status: 'DRAFT',
      confirmedAt: null,
      createdAt: '2026-02-01T00:00:00.000Z',
    },
  ],
  total: 1,
};

/** 渲染页面并收集文字 */
async function renderPage(params: { period?: string } = {}): Promise<string[]> {
  const element = await SettlementsPage({
    searchParams: Promise.resolve(params),
  });
  return collectText(element);
}

/** 渲染页面并收集链接地址 */
async function renderHrefs(params: { period?: string } = {}): Promise<string[]> {
  const element = await SettlementsPage({
    searchParams: Promise.resolve(params),
  });
  return collectHrefs(element);
}

/** 渲染页面并收集 `SettlementGenerateForm` 收到的 props */
async function renderGenerateProps(
  params: { period?: string } = {},
): Promise<Record<string, unknown>[]> {
  const element = await SettlementsPage({
    searchParams: Promise.resolve(params),
  });
  return collectComponentProps(
    element,
    SettlementGenerateForm as unknown as ComponentType<unknown>,
  );
}

/** 渲染页面并收集 `SettlementRowActions` 收到的 props */
async function renderRowActionProps(
  params: { period?: string } = {},
): Promise<Record<string, unknown>[]> {
  const element = await SettlementsPage({
    searchParams: Promise.resolve(params),
  });
  return collectComponentProps(
    element,
    SettlementRowActions as unknown as ComponentType<unknown>,
  );
}

/**
 * 取出表格里**数据行**（`<tbody>` 里的 `<tr>`）的每一格文字。
 *
 * ⚠️ **为什么需要它**：表头里有一列就叫「缺笔」——
 *    断言「页面出现『缺笔』」时，表头会把它顶出来（**恒真的假阳性**）。
 *    真正要盯的是**缺笔那一格**（第 8 格，索引 7）。
 *
 * ⚠️ **表头的 `<tr>` 在 `<thead>` 里，不算数** —— 只在 `TableBody` 里找 `TableRow`。
 *
 * ⚠️ **必须按组件引用比对，不能按 `'tbody'` 字符串**：
 *    `TableBody` / `TableRow` / `TableCell` 都是**组件函数**，
 *    元素树里它们的 `type` 是函数本身而不是 `'tbody'`。
 *    （商家端那套用原生 `<tbody>`，所以那边能比字符串。）
 */
async function renderRows(
  params: { period?: string } = {},
): Promise<string[][]> {
  const element = await SettlementsPage({
    searchParams: Promise.resolve(params),
  });
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
    if (el.type === TableBody) {
      const trs = (Array.isArray(children) ? children : [children]).filter(
        (child): child is ReactElement<Record<string, unknown>> =>
          isValidElement(child),
      );
      for (const tr of trs) {
        if (tr.type !== TableRow) continue;
        const tds = tr.props?.children as ReactNode;
        const cells = (Array.isArray(tds) ? tds : [tds]).filter(
          (cell): cell is ReactElement<Record<string, unknown>> =>
            isValidElement(cell) && cell.type === TableCell,
        );
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

describe('结算单列表页：周期来自 URL', () => {
  it('不给周期 → 路径里没有 period（列出全部）', async () => {
    await renderPage();

    expect(apiFetchAuthedMock).toHaveBeenCalledTimes(1);
    const [path] = apiFetchAuthedMock.mock.calls[0] as [string];
    // ⚠️ **精确匹配而不是 `toContain`**：`toContain('/platform/settlements')`
    //    连 `/platform/settlementsXYZ` 也放得过，路径写歪了照样绿。
    expect(path).toBe('/platform/settlements?pageSize=200');
  });

  it('给了周期 → 路径里带 period', async () => {
    await renderPage({ period: '2026-01' });

    const [path] = apiFetchAuthedMock.mock.calls[0] as [string];
    // ⚠️ **精确匹配**：参数顺序与编码方式都锁死 ——
    //    顺序一变后端解析结果可能变，编码漏了则含特殊字符的周期会被截断。
    expect(path).toBe('/platform/settlements?period=2026-01&pageSize=200');
  });

  it('⚠️ 两种路径都带 pageSize=200（后端 pageSize 上限就是 200）', async () => {
    // ⚠️ 少了这个参数 → 后端退回默认页大小 → 单据多时被静默截断，
    //    页面看上去「只有这些单据」→ 平台据此算账会少算。
    // ⚠️ **必须精确匹配**：写成 `toContain('pageSize=200')` 时，
    //    `pageSize=2000` 也能匹配过去 —— 那会被后端截断或直接报错。
    await renderPage();
    const [withoutPeriod] = apiFetchAuthedMock.mock.calls[0] as [string];
    expect(withoutPeriod).toBe('/platform/settlements?pageSize=200');

    apiFetchAuthedMock.mockClear();
    await renderPage({ period: '2026-01' });
    const [withPeriod] = apiFetchAuthedMock.mock.calls[0] as [string];
    expect(withPeriod).toBe(
      '/platform/settlements?period=2026-01&pageSize=200',
    );
  });

  it('⚠️ 周期格式非法 → 提示，且根本不调后端', async () => {
    const texts = await renderPage({ period: '2026-13' });

    expect(hasText(texts, '周期格式非法')).toBe(true);
    // ⚠️ **非法周期的明细比没有明细更糟**：所以压根不调后端。
    expect(apiFetchAuthedMock).not.toHaveBeenCalled();
  });
});

describe('结算单列表页：金额一律用后端返回的值', () => {
  it('⚠️ 净额是后端给的值，不是前端把毛额与冲回加总出来的', async () => {
    const texts = await renderPage();

    // ⚠️ **这条是护栏「前端不自己算净额」的直接锁**：
    // 后端给的净额是 99999 分 → ¥999.99；
    // 前端自己加总的话是 100 + (−300) = −200 分 → ¥-2.00。
    expect(hasText(texts, '¥999.99')).toBe(true);
    expect(hasText(texts, '¥-2.00')).toBe(false);
  });

  it('⚠️ 冲回显示成负数（不是 0、也不是「—」）', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '¥-3.00')).toBe(true);
  });

  it('毛额与笔数也显示出来', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '¥1.00')).toBe(true);
    // ⚠️ **笔数必须整段精确匹配**：光断言 `hasText(texts, '2')` 是假阳性 ——
    //    页面上还有 `2026-01`、`¥999.99`、`STL202601010000001234`，全都含 "2"，
    //    把 `entryCount` 改成 999，这条照样绿。
    //
    // ⚠️ **列表页的笔数格没有「笔」字**（详情页才有「2 笔」），所以这里断言
    //    「**存在一个正好等于 '2' 的文本节点**」—— 笔数格本身就是那个节点，
    //    而 `¥999.99` / `2026-01` / 单号都不可能是整个节点。
    expect(texts).toContain('2');
  });

  it('状态显示中文文案', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '草稿')).toBe(true);
    expect(hasText(texts, 'DRAFT')).toBe(false);
  });

  it('⚠️ 已出款状态也翻成中文（PAID 不是页面上该出现的裸枚举）', async () => {
    apiFetchAuthedMock.mockResolvedValue({
      ...LIST,
      items: [{ ...LIST.items[0], status: 'PAID' as const }],
    });

    const texts = await renderPage();

    // ⚠️ **三态里 PAID 在页面级测试里从来没有出现过**：
    //    只有组件层测过「PAID 不给按钮」，没人锁住页面上的文案。
    //    漏译的话超管看到的就是一串 `PAID`。
    expect(hasText(texts, '已出款')).toBe(true);
    expect(hasText(texts, 'PAID')).toBe(false);
  });

  it('⚠️ 净额为负时显示成 ¥-50.00（平台倒欠商家钱）', async () => {
    apiFetchAuthedMock.mockResolvedValue({
      ...LIST,
      items: [{ ...LIST.items[0], netAmount: -5000 }],
    });

    const texts = await renderPage();

    // ⚠️ **负净额是真实场景**：某商家本期只有退款冲回、没有新的抽佣。
    //    显示成 `¥-50.00` 才对 —— 写成 `-¥50.00` 或 `¥NaN` 都是算错了账。
    expect(hasText(texts, '¥-50.00')).toBe(true);
    expect(hasText(texts, 'NaN')).toBe(false);
  });

  it('显示商家名、单号与周期', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '示例店铺')).toBe(true);
    expect(hasText(texts, 'STL202601010000001234')).toBe(true);
    expect(hasText(texts, '2026-01')).toBe(true);
  });

  it('⚠️ 表头把毛额 / 冲回 / 净额三列分开列出来', async () => {
    const texts = await renderPage();

    // ⚠️ **三列必须分开**：合在一列里的界面没法核对毛额与冲回。
    expect(hasText(texts, '毛额')).toBe(true);
    expect(hasText(texts, '冲回')).toBe(true);
    expect(hasText(texts, '净额')).toBe(true);
  });
});

describe('结算单列表页：取数失败', () => {
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
});

describe('结算单列表页：缺笔可见（阶段 5j）', () => {
  it('⚠️ 缺笔的期在列表里标出来', async () => {
    apiFetchAuthedMock.mockResolvedValue({
      ...LIST,
      items: [{ ...LIST.items[0], missingEntryCount: 3 }],
    });

    const rows = await renderRows();

    // ⚠️ **缺笔必须在列表页就看得见**：超管是按月扫列表找问题的，
    //    只在详情页提示等于让超管一张张点进去才知道哪期对不上账。
    //
    // ⚠️ **只看「缺笔」那一格**（索引 7）：
    //    整页断言 `hasText(texts, '缺笔')` **恒真** —— 表头里本来就有一列
    //    叫「缺笔」，`hasText` 会把所有文本节点拼起来匹配，
    //    这条断言从写下来那天起就没有区分力。
    expect(rows).toHaveLength(1);
    expect(rows[0][7]).toBe('缺 3 笔');
  });

  it('⚠️ 不缺笔时这一列显示「—」（不写「缺 0 笔」）', async () => {
    const rows = await renderRows();

    // ⚠️ **「缺 0 笔」是自相矛盾的说法**：0 就是不缺笔，
    //    写出来会让超管以为每张单都有问题。
    expect(rows[0][7]).toBe('—');
    expect(rows[0][7]).not.toContain('缺');
  });

  it('⚠️ 缺笔列的内容跟着后端给的缺笔数走（前端不自己比）', async () => {
    apiFetchAuthedMock.mockResolvedValue({
      ...LIST,
      items: [{ ...LIST.items[0], missingEntryCount: 7 }],
    });

    const rows = await renderRows();

    // ⚠️ **前端不自己算缺笔数**：缺笔 = 当期真实流水笔数 − 结算单纳入的笔数，
    //    两处口径一旦漂移，同一张单在列表页与详情页会给出两个不同的数。
    expect(rows[0][7]).toBe('缺 7 笔');
  });

  it('⚠️ 缺笔的提示要标红（className 是 text-destructive）', async () => {
    apiFetchAuthedMock.mockResolvedValue({
      ...LIST,
      items: [{ ...LIST.items[0], missingEntryCount: 3 }],
    });

    const element = await SettlementsPage({
      searchParams: Promise.resolve({}),
    });
    const classNames = collectClassNames(element);

    // ⚠️ **光有文字不够**：不标红的话，超管在几十行表格里扫过去
    //    根本不会注意到那一格 —— 「看得见」包括「一眼能看见」。
    expect(
      classNames.some((name) =>
        name.includes('text-destructive'),
      ),
    ).toBe(true);
  });
});

describe('结算单列表页：空数据', () => {
  it('没有结算单时显示「暂无结算单。」而不是空白表', async () => {
    apiFetchAuthedMock.mockResolvedValue({ items: [], total: 0 });

    const texts = await renderPage();

    expect(hasText(texts, '暂无结算单。')).toBe(true);
  });

  it('⚠️ total 大于本页条数时提示「还有更多」', async () => {
    apiFetchAuthedMock.mockResolvedValue({ ...LIST, total: 120 });

    const texts = await renderPage();

    expect(hasText(texts, '共 120 张')).toBe(true);
    expect(hasText(texts, '本页显示 1 张')).toBe(true);
  });

  it('⚠️ total 不大于本页条数时不说「还有更多」', async () => {
    const texts = await renderPage();

    // ⚠️ **总数与本页条数一致时不该出现「本页显示」**：
    // 那会让超管以为还有没翻到的单据。
    expect(hasText(texts, '共 1 张')).toBe(true);
    expect(hasText(texts, '本页显示')).toBe(false);
  });
});

describe('结算单列表页：客户端组件拿到的 props', () => {
  it('生成表单拿到的是 URL 里的周期', async () => {
    const forms = await renderGenerateProps({ period: '2026-01' });

    expect(forms).toHaveLength(1);
    expect(forms[0].period).toBe('2026-01');
  });

  it('⚠️ 周期非法时生成表单拿不到周期（不预填非法值）', async () => {
    const forms = await renderGenerateProps({ period: '2026-13' });

    // ⚠️ **不预填非法值**：否则超管点「生成」后客户端校验会再报一遍
    // 跟页面上那句一模一样的错，同一屏出现两条相同的提示。
    expect(forms).toHaveLength(1);
    expect(forms[0].period).toBeUndefined();
  });

  it('每一行都渲染一组状态操作按钮，且拿到的是那张单据', async () => {
    const actions = await renderRowActionProps();

    // ⚠️ **每一行一个**：列表页只有一行，所以正好一个。
    expect(actions).toHaveLength(1);
    expect(actions[0].statementId).toBe('statement-1');
    expect(actions[0].status).toBe('DRAFT');
  });

  it('每一行都有指向详情页的链接', async () => {
    const hrefs = await renderHrefs();

    expect(hrefs).toContain('/settlements/statement-1');
  });
});
