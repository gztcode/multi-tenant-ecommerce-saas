/**
 * 商家侧出款单详情页（Server Component）的页面级测试。
 *
 * ⚠️ **遍历元素树而不是渲染 HTML**：页面上有 `next/link` 与客户端组件，
 * 在 Next 运行时之外渲染它可能抛错。直接 `await PayoutDetailPage(...)`
 * 拿到元素树，只读 `props.children`。
 *
 * ⚠️ **这一页最要紧的护栏是「前端不自己算金额」**：
 * 把 `payout.netAmount` 换成「把货款净额与佣金加总一遍」时，
 * 应结金额会从 ¥9.00 变成 ¥2.00 —— 用**故意对不上**的数值才能锁住它。
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

import PayoutDetailPage from '@/app/(dashboard)/settlements/[id]/page';
import type { PayoutDetail } from '@/lib/payout';

import { collectHrefs, collectText, hasText } from '../helpers/page-tree';

/**
 * ⚠️ **三个金额刻意用三个不同的数值**（货款 ¥5.00 / 佣金 ¥3.00 / 应结 ¥9.00）：
 * 三个都用同一个数时，「货款显示的是佣金」这类错误测不出来。
 * 应结 ¥9.00 与「货款 − 佣金 = ¥2.00」不等 → 前端若自己加总能测出来。
 */
const DETAIL: PayoutDetail = {
  id: 'payout-1',
  payoutNo: 'PAY202601010000001234',
  periodLabel: '2026-01',
  periodStart: '2026-01-01T00:00:00.000Z',
  periodEnd: '2026-02-01T00:00:00.000Z',
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
  entries: [
    {
      entryId: 'entry-1',
      orderNo: 'ORD-001',
      type: 'SALE',
      amount: 500,
      occurredAt: '2026-01-05T10:00:00.000Z',
    },
  ],
};

/** 渲染页面并收集文字 */
async function renderPage(id = 'payout-1'): Promise<string[]> {
  const element = await PayoutDetailPage({ params: Promise.resolve({ id }) });
  return collectText(element);
}

/** 渲染页面并收集链接地址 */
async function renderHrefs(id = 'payout-1'): Promise<string[]> {
  const element = await PayoutDetailPage({ params: Promise.resolve({ id }) });
  return collectHrefs(element);
}

beforeEach(() => {
  vi.clearAllMocks();
  apiFetchAuthedMock.mockResolvedValue(DETAIL);
});

describe('出款单详情页：取数', () => {
  it('打到商家侧的 /merchant/payouts/:id', async () => {
    await renderPage();

    expect(apiFetchAuthedMock).toHaveBeenCalledTimes(1);
    const [path] = apiFetchAuthedMock.mock.calls[0] as [string];
    expect(path).toBe('/merchant/payouts/payout-1');
  });
});

describe('出款单详情页：金额一律用后端返回的值', () => {
  it('⚠️ 应结金额是后端给的值，不是前端把货款与佣金加总出来的', async () => {
    const texts = await renderPage();

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

    // ⚠️ **光断言 `'2'` 是假阳性** —— `2026-01`、`¥9.00` 里都有 "2"。
    expect(hasText(texts, '2 笔')).toBe(true);
  });

  it('状态显示中文文案，不显示裸枚举', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '待审批')).toBe(true);
    expect(hasText(texts, 'REQUESTED')).toBe(false);
  });

  it('显示周期与单号', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '2026-01')).toBe(true);
    expect(hasText(texts, 'PAY202601010000001234')).toBe(true);
  });
});

describe('出款单详情页：明细', () => {
  it('⚠️ 明细的流水类型翻成中文（SALE 不是页面上该出现的裸枚举）', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '货款入账')).toBe(true);
    expect(hasText(texts, 'SALE')).toBe(false);
  });

  it('⚠️ 冲回类型也翻成中文', async () => {
    apiFetchAuthedMock.mockResolvedValue({
      ...DETAIL,
      entries: [{ ...DETAIL.entries[0], type: 'SALE_REVERSAL' }],
    });

    const texts = await renderPage();

    expect(hasText(texts, '货款冲回')).toBe(true);
    expect(hasText(texts, 'SALE_REVERSAL')).toBe(false);
  });

  it('显示订单号与明细金额', async () => {
    const texts = await renderPage();

    expect(hasText(texts, 'ORD-001')).toBe(true);
    expect(hasText(texts, '¥5.00')).toBe(true);
  });

  it('没有明细时显示「暂无明细。」', async () => {
    apiFetchAuthedMock.mockResolvedValue({ ...DETAIL, entries: [] });

    const texts = await renderPage();

    expect(hasText(texts, '暂无明细。')).toBe(true);
  });
});

describe('出款单详情页：拒绝原因', () => {
  it('被拒绝时显示拒绝原因', async () => {
    apiFetchAuthedMock.mockResolvedValue({
      ...DETAIL,
      status: 'REJECTED' as const,
      rejectedReason: '结算单还没确认',
    });

    const texts = await renderPage();

    expect(hasText(texts, '拒绝原因：结算单还没确认')).toBe(true);
  });

  it('没被拒绝时不显示「拒绝原因」', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '拒绝原因')).toBe(false);
  });
});

describe('出款单详情页：取数失败', () => {
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
});

describe('出款单详情页：申请时预估与当前应结的差异', () => {
  it('⚠️ 单独显示申请时的预估金额（审批时会重算并锁定）', async () => {
    apiFetchAuthedMock.mockResolvedValue({
      ...DETAIL,
      // ⚠️ **预估与当前应结刻意不同**：审批时平台会重算并锁定，
      //    商家看不到这个差异就会以为金额没变过。
      requestedAmount: 700,
      netAmount: 900,
    });

    const texts = await renderPage();

    expect(hasText(texts, '申请时预估')).toBe(true);
    expect(hasText(texts, '¥7.00')).toBe(true);
    // ⚠️ **还要说清「审批会重算」**：光给两个数，商家不知道差在哪。
    expect(hasText(texts, '重算')).toBe(true);
  });
});

describe('出款单详情页：时间线', () => {
  it('待审批 → 只显示申请时间，不显示「审批时间」', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '申请时间')).toBe(true);
    expect(hasText(texts, '审批时间')).toBe(false);
  });

  it('⚠️ 已审批 → 显示审批时间', async () => {
    apiFetchAuthedMock.mockResolvedValue({
      ...DETAIL,
      status: 'APPROVED' as const,
      approvedAt: '2026-02-05T00:00:00.000Z',
    });

    const texts = await renderPage();

    expect(hasText(texts, '审批时间')).toBe(true);
  });

  it('⚠️ 已拒绝 → 显示「拒绝时间」，且不再说「已审批」', async () => {
    apiFetchAuthedMock.mockResolvedValue({
      ...DETAIL,
      status: 'REJECTED' as const,
      // ⚠️ **后端 `reject()` 同填 `approvedAt` 与 `approvedBy`**
      //    （拒绝也是一次审批动作）—— 页面上不能因此显示「已审批」。
      approvedAt: '2026-02-05T00:00:00.000Z',
      rejectedReason: '该期结算单尚未确认',
    });

    const texts = await renderPage();

    expect(hasText(texts, '拒绝时间')).toBe(true);
    expect(hasText(texts, '已审批')).toBe(false);
    expect(hasText(texts, '已拒绝')).toBe(true);
  });

  it('⚠️ 已撤回 → 显示撤回时间', async () => {
    apiFetchAuthedMock.mockResolvedValue({
      ...DETAIL,
      status: 'CANCELLED' as const,
      cancelledAt: '2026-02-05T00:00:00.000Z',
    });

    const texts = await renderPage();

    expect(hasText(texts, '撤回时间')).toBe(true);
  });
});

describe('出款单详情页：返回列表的入口', () => {
  it('⚠️ 有指回 /settlements 的链接（否则商家只能靠浏览器后退）', async () => {
    const hrefs = await renderHrefs();

    expect(hrefs).toContain('/settlements');
  });
});

describe('出款单详情页：补差单与失败提示（阶段 5h-2）', () => {
  it('⚠️ 补差单显示「零佣金结算」说明', async () => {
    apiFetchAuthedMock.mockResolvedValue({
      ...DETAIL,
      kind: 'SUPPLEMENT' as const,
    });

    const texts = await renderPage();

    // ⚠️ **这段说明不能省**（设计 §6.4）：商家一定会问
    //    「这 5000 块为什么不抽佣」，不说清楚就会反复申诉。
    expect(hasText(texts, '补差按零佣金结算')).toBe(true);
    expect(hasText(texts, '该期结算单已结清')).toBe(true);
  });

  it('正常单不显示补差说明', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '补差按零佣金结算')).toBe(false);
  });

  it('⚠️ 出款失败时显示失败原因并提示核对是否已到账', async () => {
    apiFetchAuthedMock.mockResolvedValue({
      ...DETAIL,
      status: 'FAILED' as const,
      failureReason: '渠道超时',
    });

    const texts = await renderPage();

    expect(hasText(texts, '出款失败：渠道超时')).toBe(true);
    expect(hasText(texts, '请联系平台确认是否已到账')).toBe(true);
  });

  it('⚠️ 失败但没有原因时显示「未知原因」', async () => {
    apiFetchAuthedMock.mockResolvedValue({
      ...DETAIL,
      status: 'FAILED' as const,
      failureReason: null,
    });

    const texts = await renderPage();

    expect(hasText(texts, '出款失败：未知原因')).toBe(true);
  });

  it('⚠️ 不是失败状态时不显示失败提示', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '请联系平台确认是否已到账')).toBe(false);
  });
});

describe('出款单详情页：打款时刻与失败时刻（阶段 5h-2）', () => {
  it('⚠️ 出款成功时显示打款时间（商家最关心「钱什么时候打过来的」）', async () => {
    apiFetchAuthedMock.mockResolvedValue({
      ...DETAIL,
      status: 'PAID' as const,
      paidAt: '2026-02-10T08:30:00.000Z',
    });

    const texts = await renderPage();

    expect(hasText(texts, '打款时间')).toBe(true);
    // ⚠️ **时间格式走 `lib/billing.ts` 的 `formatDateTime`**：
    //    这里断言的是格式化后的结果（本地时区），
    //    页面里自造一份格式化就会漂。
    const { formatDateTime } = await vi.importActual<
      typeof import('@/lib/billing')
    >('@/lib/billing');
    expect(hasText(texts, formatDateTime('2026-02-10T08:30:00.000Z'))).toBe(true);
  });

  it('⚠️ 不是已出款状态时不显示打款时间', async () => {
    apiFetchAuthedMock.mockResolvedValue({
      ...DETAIL,
      status: 'APPROVED' as const,
      paidAt: '2026-02-10T08:30:00.000Z',
    });

    const texts = await renderPage();

    expect(hasText(texts, '打款时间')).toBe(false);
  });

  it('⚠️ 出款失败时显示失败时间', async () => {
    apiFetchAuthedMock.mockResolvedValue({
      ...DETAIL,
      status: 'FAILED' as const,
      failureReason: '渠道超时',
      failedAt: '2026-02-11T09:00:00.000Z',
    });

    const texts = await renderPage();

    expect(hasText(texts, '失败时间')).toBe(true);
    const { formatDateTime } = await vi.importActual<
      typeof import('@/lib/billing')
    >('@/lib/billing');
    expect(hasText(texts, formatDateTime('2026-02-11T09:00:00.000Z'))).toBe(true);
  });

  it('⚠️ 不是失败状态时不显示失败时间', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '失败时间')).toBe(false);
  });
});
