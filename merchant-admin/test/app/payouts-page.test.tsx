/**
 * 商家侧出款单列表页（Server Component）的页面级测试。
 *
 * ⚠️ **遍历元素树而不是渲染 HTML**：页面上有 `next/link`，
 * 在 Next 运行时之外渲染它可能抛错。直接 `await PayoutsPage(...)`
 * 拿到元素树，只读 `props.children`，**不执行任何组件函数**。
 *
 * ⚠️ **这一页最要紧的护栏是「前端不自己算金额」**：
 * 把 `payout.netAmount` 换成「把货款净额与佣金加总一遍」时，
 * 应结金额会从 ¥2.00 变成 ¥2.00 —— 用**故意对不上**的数值才能锁住它。
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

import PayoutsPage from '@/app/(dashboard)/settlements/page';
import type { PayoutItem } from '@/lib/payout';

import { collectHrefs, collectText, hasText } from '../helpers/page-tree';

/**
 * ⚠️ **三个金额刻意用三个不同的数值**（货款 ¥5.00 / 佣金 ¥3.00 / 应结 ¥2.00）：
 * 三个都用同一个数时，「货款列显示的是佣金」这类错误测不出来。
 * 而**故意对不上**（5.00 − 3.00 = 2.00 与应结 2.00 相同）——
 * 这里改成应结 ¥2.00、货款 ¥5.00、佣金 ¥3.00：
 * 前端若自己加总，5.00 − 3.00 = 2.00，恰好相同 → 测不出来。
 * 所以让**应结与加总结果不等**：货款 ¥5.00、佣金 ¥3.00、应结 ¥9.00
 * （加总会得 ¥2.00，与后端给的 ¥9.00 不同 → 能锁住）。
 */
const ITEM: PayoutItem = {
  id: 'payout-1',
  payoutNo: 'PAY202601010000001234',
  periodLabel: '2026-01',
  receiptAmount: 500,
  commissionAmount: 300,
  netAmount: 900,
  entryCount: 2,
  status: 'REQUESTED',
  requestedAmount: 900,
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
};

const LIST = {
  items: [ITEM],
  total: 1,
};

/** 渲染页面并收集文字 */
async function renderPage(): Promise<string[]> {
  const element = await PayoutsPage();
  return collectText(element);
}

/** 渲染页面并收集链接地址 */
async function renderHrefs(): Promise<string[]> {
  const element = await PayoutsPage();
  return collectHrefs(element);
}

beforeEach(() => {
  vi.clearAllMocks();
  apiFetchAuthedMock.mockResolvedValue(LIST);
});

describe('出款单列表页：取数', () => {
  it('打到商家侧的 /merchant/payouts（不是平台侧）', async () => {
    await renderPage();

    expect(apiFetchAuthedMock).toHaveBeenCalledTimes(1);
    const [path] = apiFetchAuthedMock.mock.calls[0] as [string];
    // ⚠️ **精确匹配而不是 `toContain`**：`toContain('/merchant/payouts')`
    //    连 `/merchant/payoutsXYZ` 也放得过，路径写歪了照样绿。
    expect(path).toBe('/merchant/payouts?pageSize=100');
  });

  it('⚠️ 显式请求 pageSize=100（后端 clampPagination 的上限就是 100）', async () => {
    // ⚠️ **少了这个参数 → 后端退回缺省的 20** → 页面写着「共 N 张出款单」
    //    却只画 20 张，第 21 条之后商家永远看不到，还没有分页控件可翻。
    await renderPage();

    const [path] = apiFetchAuthedMock.mock.calls[0] as [string];
    expect(path).toContain('pageSize=100');
  });
});

describe('出款单列表页：金额一律用后端返回的值', () => {
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

  it('⚠️ 笔数必须整段精确匹配', async () => {
    const texts = await renderPage();

    // ⚠️ **光断言 `hasText(texts, '2')` 是假阳性** —— 页面上还有
    //    `2026-01`、`¥9.00` 等，全都含 "2"（`2026-01` 里就有两个 2）。
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
      items: [{ ...ITEM, status: 'REJECTED' as const }],
    });

    const texts = await renderPage();

    expect(hasText(texts, '已拒绝')).toBe(true);
    expect(hasText(texts, 'REJECTED')).toBe(false);
  });

  it('显示单号与周期', async () => {
    const texts = await renderPage();

    expect(hasText(texts, 'PAY202601010000001234')).toBe(true);
    expect(hasText(texts, '2026-01')).toBe(true);
  });

  it('⚠️ 表头把货款净额 / 平台佣金 / 应结金额三列分开列出来', async () => {
    const texts = await renderPage();

    // ⚠️ **三列必须分开**：合在一列里的界面没法核对货款与佣金。
    expect(hasText(texts, '货款净额')).toBe(true);
    expect(hasText(texts, '平台佣金')).toBe(true);
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
    expect(hasText(texts, '后端炸了')).toBe(true);
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

  it('显示总数', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '共 1 张出款单')).toBe(true);
  });
});

describe('出款单列表页：详情页链接', () => {
  it('⚠️ 每一行都有指向详情页的链接（商家要能点进去看明细）', async () => {
    const hrefs = await renderHrefs();

    expect(hrefs).toContain('/settlements/payout-1');
  });
});

describe('出款单列表页：申请出款的入口', () => {
  it('⚠️ 有指向申请页的链接（否则商家没有任何路径能申请出款）', async () => {
    const hrefs = await renderHrefs();

    // ⚠️ **这是 5h-1 的核心写入流程的入口**：少了它，商家能看列表、
    //    看详情、撤回，却**永远申请不了**。
    expect(hrefs).toContain('/settlements/apply');
  });

  it('⚠️ 入口上有「申请出款」的文案（光有链接商家不知道那是干嘛的）', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '申请出款')).toBe(true);
  });
});

describe('出款单列表页：超过一页时的提示', () => {
  it('⚠️ total 大于本页条数时说明「只显示最近 100 张」', async () => {
    apiFetchAuthedMock.mockResolvedValue({ ...LIST, total: 120 });

    const texts = await renderPage();

    expect(hasText(texts, '共 120 张出款单')).toBe(true);
    expect(hasText(texts, '本页显示 1 张')).toBe(true);
    // ⚠️ **必须说清楚「更多出款单要找平台」**：只写「本页显示 1 张」
    //    商家会以为另外 119 张丢了。
    expect(hasText(texts, '更多出款单请联系平台')).toBe(true);
  });

  it('⚠️ total 不大于本页条数时不说「只显示最近 100 张」', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '共 1 张出款单')).toBe(true);
    expect(hasText(texts, '本页显示')).toBe(false);
    expect(hasText(texts, '更多出款单请联系平台')).toBe(false);
  });
});

describe('出款单列表页：类型标记与失败提示（阶段 5h-2）', () => {
  it('⚠️ 补差单显示「补差出款」标记', async () => {
    apiFetchAuthedMock.mockResolvedValue({
      ...LIST,
      items: [{ ...ITEM, kind: 'SUPPLEMENT' as const }],
    });

    const texts = await renderPage();

    // ⚠️ **文案要与平台端统一**（「补差出款」而不是「补差」）：
    //    同一件事两种说法，商家与超管对不上账。
    expect(hasText(texts, '补差出款')).toBe(true);
    expect(hasText(texts, 'SUPPLEMENT')).toBe(false);
  });

  it('正常单显示「正常出款」标记', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '正常出款')).toBe(true);
  });

  it('⚠️ 未知类型回落成「正常出款」（不误标成别的类型）', async () => {
    apiFetchAuthedMock.mockResolvedValue({
      ...LIST,
      // ⚠️ **后端将来加新枚举时不能误标**：内联三元会把任何非补差的值
      //    显示成「正常」，这里锁定「有兜底文案、且不是裸枚举」。
      items: [{ ...ITEM, kind: 'SOMETHING_NEW' as never }],
    });

    const texts = await renderPage();

    expect(hasText(texts, '正常出款')).toBe(true);
    expect(hasText(texts, 'SOMETHING_NEW')).toBe(false);
  });

  it('⚠️ 出款失败时提示商家去核对是否已到账', async () => {
    apiFetchAuthedMock.mockResolvedValue({
      ...LIST,
      items: [{ ...ITEM, status: 'FAILED' as const }],
    });

    const texts = await renderPage();

    expect(hasText(texts, '出款失败')).toBe(true);
    // ⚠️ **这句提示不能省**：失败的单可能真的已经打出去了，
    //    商家不去核对就会直接再申请一笔。
    expect(hasText(texts, '请联系平台确认是否已到账')).toBe(true);
  });

  it('⚠️ 不是失败状态时不显示那句核对提示', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '请联系平台确认是否已到账')).toBe(false);
  });
});
