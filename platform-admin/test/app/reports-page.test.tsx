/**
 * 平台收入报表页（Server Component）的页面级测试。
 *
 * ⚠️ **遍历元素树而不是渲染 HTML**：页面上有 `next/link`，
 * 在 Next 运行时之外渲染它可能抛错。直接 `await ReportsPage(...)`
 * 拿到元素树，只读 `props.children`，**不执行任何组件函数**。
 *
 * ⚠️ **这一页最要紧的护栏是「前端不自己算净额」**：把
 * `report.netRevenue` 换成 `subscriptionRevenue + commissionRevenue - reversal`
 * 时，金额会从 ¥999.99 变成 ¥11.50 —— 而那笔账是错的。
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

import ReportsPage from '@/app/(dashboard)/reports/page';
import type { ReportSummary } from '@/lib/billing';

import { collectText, hasText } from '../helpers/page-tree';

/**
 * ⚠️ **故意对不上**：1000 + 200 − 50 = 1150 分 = ¥11.50，
 * 而后端给的净额是 99999 分 = ¥999.99。
 * 页面若自己算，显示的就是 ¥11.50。
 *
 * ⚠️ **区间取「有区分度」的值**：既不是 10 月也不是任何会撞上金额
 * （¥10.00 / ¥2.00 / ¥0.50）的日子 —— 断言要能分辨「回显的是这一段」
 * 与「回显的是别的一段」。
 */
const REPORT: ReportSummary = {
  from: '2026-03-04T05:06:07.000Z',
  to: '2026-11-12T13:14:15.000Z',
  subscriptionRevenue: 1000,
  commissionRevenue: 200,
  reversal: 50,
  netRevenue: 99999,
};

async function renderPage(params: {
  from?: string;
  to?: string;
} = {}): Promise<string[]> {
  const element = await ReportsPage({ searchParams: Promise.resolve(params) });
  return collectText(element);
}

beforeEach(() => {
  vi.clearAllMocks();
  apiFetchAuthedMock.mockResolvedValue(REPORT);
});

describe('报表页：区间来自 URL', () => {
  it('⚠️ 不给日期 → 路径里没有 from / to（后端用「最近 30 天」缺省）', async () => {
    await renderPage();

    expect(apiFetchAuthedMock).toHaveBeenCalledTimes(1);
    const [path] = apiFetchAuthedMock.mock.calls[0] as [string];
    // ⚠️ **不能带 from / to**：那个缺省窗口是用**数据库的时钟**算的
    // （护栏 M15），前端自己算「最近 30 天」用的是浏览器的时钟。
    expect(path).not.toContain('from');
    expect(path).not.toContain('to');
    expect(path).toBe('/platform/reports');
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
    // ⚠️ **区间不完整的报表比没有报表更糟**：所以压根不调后端。
    expect(apiFetchAuthedMock).not.toHaveBeenCalled();
  });

  it('⚠️ 只给结束日期 → 同样提示，且根本不调后端', async () => {
    const texts = await renderPage({ to: '2026-01-31' });

    expect(hasText(texts, '请同时选择开始与结束日期')).toBe(true);
    expect(apiFetchAuthedMock).not.toHaveBeenCalled();
  });

  it('⚠️ toIsoRange 出错 → 显示那句错误，且根本不调后端', async () => {
    const texts = await renderPage({ from: '2026-02-01', to: '2026-01-01' });

    expect(hasText(texts, '结束日期不能早于开始日期')).toBe(true);
    expect(apiFetchAuthedMock).not.toHaveBeenCalled();
  });

  it('⚠️ 日期格式非法 → 显示那句错误，且根本不调后端', async () => {
    const texts = await renderPage({ from: 'not-a-date', to: '2026-01-31' });

    expect(hasText(texts, '日期必须是 YYYY-MM-DD 格式')).toBe(true);
    expect(apiFetchAuthedMock).not.toHaveBeenCalled();
  });
});

describe('报表页：四个数直接用后端返回的值', () => {
  it('⚠️ 净收入是后端给的值，不是前端算的', async () => {
    const texts = await renderPage();

    // ⚠️ **这条是护栏「前端不自己算净额」的直接锁**：
    // 后端给的是 99999 分 → ¥999.99；
    // 前端自己算的话是 1000 + 200 − 50 = 1150 分 → ¥11.50。
    expect(hasText(texts, '¥999.99')).toBe(true);
    expect(hasText(texts, '¥11.50')).toBe(false);
  });

  it('三个分项也是后端给的值', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '¥10.00')).toBe(true);
    expect(hasText(texts, '¥2.00')).toBe(true);
    expect(hasText(texts, '¥0.50')).toBe(true);
  });

  it('四个数的标题都在', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '订阅收入')).toBe(true);
    expect(hasText(texts, '抽佣收入')).toBe(true);
    expect(hasText(texts, '退款冲回')).toBe(true);
    expect(hasText(texts, '净收入')).toBe(true);
  });

  it('页面上有「净收入 = 订阅收入 + 抽佣收入 − 退款冲回」这句说明', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '净收入 = 订阅收入 + 抽佣收入 − 退款冲回')).toBe(true);
  });
});

describe('报表页：区间回显', () => {
  it('⚠️ 回显的是后端返回的 from / to（不是 URL 里给的）', async () => {
    const texts = await renderPage({ from: '2026-01-01', to: '2026-01-31' });

    expect(hasText(texts, '统计区间：')).toBe(true);
    // ⚠️ **断言整段区间串，不拆成 '2026' / '10' / '31' 三个子串**：
    // 那三个片段太弱 —— '10' 会命中「¥10.00」（订阅收入），
    // '31' 会命中格式化后的日期串里的任何位置。把区间起点改错
    // （2026-10-15 ~ 2026-10-31，仍含 10/31/2026）时，用例照样全绿。
    //
    // ⚠️ **期望值写死成字面量，不从 `REPORT` 推导**：从 mock 的返回值
    // 推导期望值 = 「用被测的输入证明被测的输出」。改掉 `REPORT.from`
    // 时两边一起动，用例照样绿。这里直接把 ISO 串写成字面量。
    //
    // ⚠️ **不用硬编码本地时区的输出**：页面走的是 `toLocaleString()`，
    // 输出形态随运行环境与时区而变（'2026/3/4 13:06:07' vs
    // '2026-03-04'）。这里**独立地**按本地字段拼出期望串
    // （不调用页面用的 `formatDateTime`，否则就成了自证）。
    expect(
      hasText(
        texts,
        `统计区间：${localOf('2026-03-04T05:06:07.000Z')} ~ ${localOf(
          '2026-11-12T13:14:15.000Z',
        )}`,
      ),
    ).toBe(true);
  });

  it('⚠️ URL 里给的日期不会混进回显的区间里', async () => {
    const texts = await renderPage({ from: '2026-01-01', to: '2026-01-31' });

    // ⚠️ **后端可能用了「最近 30 天」的缺省值**：界面要显示它真正统计的那段。
    // 回显里出现 URL 里的 1 月，就是把「请求的区间」当成了「统计的区间」。
    expect(hasText(texts, localOf('2026-01-01T00:00:00.000Z'))).toBe(false);
    expect(hasText(texts, localOf('2026-01-31T00:00:00.000Z'))).toBe(false);
  });
});

/**
 * ISO 串 → 本地时间字符串（**与页面的 `formatDateTime` 同款输出**）。
 *
 * ⚠️ **刻意不复用 `formatDateTime`**：断言若用被测代码自己算期望值，
 * 就成了「自己证明自己」。这里按 `Date` 的本地字段独立拼一遍，
 * 页面换个格式化方式（或回显错区间）时用例就会红。
 */
function localOf(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

describe('报表页：取数失败', () => {
  it('⚠️ 取数失败时显示错误提示，且不崩', async () => {
    const { ApiError } = await vi.importActual<
      typeof import('@/lib/api-client')
    >('@/lib/api-client');
    apiFetchAuthedMock.mockRejectedValue(
      new ApiError(500, 'INTERNAL', '后端炸了'),
    );

    const texts = await renderPage();

    expect(hasText(texts, '加载报表失败')).toBe(true);
    expect(hasText(texts, '500')).toBe(true);
  });

  it('⚠️ 取数失败（非 ApiError）时也有提示', async () => {
    apiFetchAuthedMock.mockRejectedValue(new Error('网络断了'));

    const texts = await renderPage();

    expect(hasText(texts, '网络断了')).toBe(true);
  });
});

describe('报表页：查询表单', () => {
  it('页面上有「不选日期 = 最近 30 天」的说明', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '不选日期 = 最近 30 天')).toBe(true);
  });

  it('页面上有「报表」标题', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '报表')).toBe(true);
  });
});
