/**
 * 平台出款单详情页（Server Component）的页面级测试。
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
 * 升级 Next 就会假红。**我们要测的是「页面调用了 `notFound()`」**。
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

import PayoutDetailPage from '@/app/(dashboard)/payouts/[id]/page';
import { PayoutActions } from '@/app/(dashboard)/payouts/payout-actions';
import type { PlatformPayoutDetail } from '@/lib/payout';

import { collectComponentProps, collectText, hasText } from '../helpers/page-tree';

/**
 * ⚠️ **故意对不上**：
 * 单据的应结金额是 99999 分 = ¥999.99；
 * 货款净额 100 分、佣金 300 分 → 差 = -200 分 = ¥-2.00。
 * 页面若自己加总，应结金额格显示的就是 ¥-2.00。
 */
const DETAIL: PlatformPayoutDetail = {
  id: 'payout-1',
  payoutNo: 'PAY202601010000001234',
  periodLabel: '2026-01',
  periodStart: '2026-01-01T00:00:00.000Z',
  periodEnd: '2026-02-01T00:00:00.000Z',
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
  tenantId: 'tenant-1',
  tenantName: '示例店铺',
  subdomain: 'demo',
  entries: [
    {
      entryId: 'entry-1',
      orderNo: 'ORD-1',
      // ⚠️ **必须与后端 Prisma 的 `ReceiptType` 一致**（`SALE` / `SALE_REVERSAL`）
      type: 'SALE',
      amount: 100,
      occurredAt: '2026-01-05T00:00:00.000Z',
    },
    {
      entryId: 'entry-2',
      orderNo: 'ORD-2',
      type: 'SALE',
      amount: 200,
      occurredAt: '2026-01-20T00:00:00.000Z',
    },
  ],
};

/** 渲染页面并收集文字 */
async function renderPage(id = 'payout-1'): Promise<string[]> {
  const element = await PayoutDetailPage({
    params: Promise.resolve({ id }),
  });
  return collectText(element);
}

/** 渲染页面并收集 `PayoutActions` 收到的 props */
async function renderActionProps(
  id = 'payout-1',
): Promise<Record<string, unknown>[]> {
  const element = await PayoutDetailPage({
    params: Promise.resolve({ id }),
  });
  return collectComponentProps(
    element,
    PayoutActions as unknown as ComponentType<unknown>,
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

describe('出款单详情页：取数', () => {
  it('按 id 拉详情', async () => {
    await renderPage('payout-1');

    expect(apiFetchAuthedMock).toHaveBeenCalledTimes(1);
    const [path] = apiFetchAuthedMock.mock.calls[0] as [string];
    expect(path).toBe('/platform/payouts/payout-1');
  });

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

  it('⚠️ 出款单不存在（404）→ 走 notFound()，不是渲染错误提示', async () => {
    const { ApiError } = await vi.importActual<
      typeof import('@/lib/api-client')
    >('@/lib/api-client');
    apiFetchAuthedMock.mockRejectedValue(
      new ApiError(404, 'NOT_FOUND', '出款单不存在'),
    );

    // ⚠️ **404 与 500 必须分开**：500 是「服务出错了」（渲染错误提示），
    //    404 是「这张单不存在」（渲染 404 页）。
    await expect(renderPage()).rejects.toThrow('NOT_FOUND_CALLED');
    expect(notFoundMock).toHaveBeenCalledTimes(1);
  });
});

describe('出款单详情页：金额与状态', () => {
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

  it('笔数也显示出来', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '2 笔')).toBe(true);
  });

  it('显示状态的中文文案与单号', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '待审批')).toBe(true);
    expect(hasText(texts, 'REQUESTED')).toBe(false);
    expect(hasText(texts, 'PAY202601010000001234')).toBe(true);
  });

  it('显示商家名与周期', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '示例店铺')).toBe(true);
    expect(hasText(texts, '2026-01')).toBe(true);
  });

  it('⚠️ 显示申请时的预估金额（与当前应结金额可能不同）', async () => {
    const texts = await renderPage();

    // ⚠️ **必须单独显示预估**：审批时平台会重算并锁定金额，
    //    商家申请时看到的是另一个数 —— 不显示出来超管会以为金额没变过。
    expect(hasText(texts, '¥888.88')).toBe(true);
    expect(hasText(texts, '申请时预估')).toBe(true);
  });

  it('⚠️ 拒绝原因只在被拒时显示', async () => {
    apiFetchAuthedMock.mockResolvedValue({
      ...DETAIL,
      status: 'REJECTED' as const,
      rejectedReason: '该期结算单尚未确认',
    });

    const texts = await renderPage();

    expect(hasText(texts, '该期结算单尚未确认')).toBe(true);
    expect(hasText(texts, '已拒绝')).toBe(true);
  });

  it('⚠️ 未被拒时不显示「拒绝原因」', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '拒绝原因')).toBe(false);
  });

  it('⚠️ 待审批时只显示申请时间，不显示「审批时间」', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '申请时间')).toBe(true);
    expect(hasText(texts, '审批时间')).toBe(false);
  });

  it('⚠️ 已审批时显示审批时间', async () => {
    apiFetchAuthedMock.mockResolvedValue({
      ...DETAIL,
      status: 'APPROVED' as const,
      approvedAt: '2026-02-05T00:00:00.000Z',
    });

    const texts = await renderPage();

    expect(hasText(texts, '审批时间')).toBe(true);
  });

  it('⚠️ 已拒绝时显示「拒绝时间」，且不再说「已审批」', async () => {
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
    // ⚠️ **拒绝时不能出现「已审批」**：那会让超管以为这单批过了。
    expect(hasText(texts, '已审批')).toBe(false);
    expect(hasText(texts, '已拒绝')).toBe(true);
  });

  it('⚠️ 已撤回时显示撤回时间', async () => {
    apiFetchAuthedMock.mockResolvedValue({
      ...DETAIL,
      status: 'CANCELLED' as const,
      cancelledAt: '2026-02-05T00:00:00.000Z',
    });

    const texts = await renderPage();

    expect(hasText(texts, '撤回时间')).toBe(true);
  });
});

describe('出款单详情页：明细', () => {
  it('每一行显示自己的金额、订单号与类型', async () => {
    const texts = await renderPage();

    expect(hasText(texts, 'ORD-1')).toBe(true);
    expect(hasText(texts, 'ORD-2')).toBe(true);
    // ⚠️ **明细类型不能是裸枚举**：页面上直接显示 `SALE` / `SALE_REVERSAL`
    //    就是把后端内部标识漏给超管看了。
    expect(hasText(texts, '货款入账')).toBe(true);
    expect(hasText(texts, 'SALE')).toBe(false);
    expect(hasText(texts, '¥1.00')).toBe(true);
    expect(hasText(texts, '¥2.00')).toBe(true);
  });

  it('⚠️ 冲回类型的明细显示中文文案', async () => {
    apiFetchAuthedMock.mockResolvedValue({
      ...DETAIL,
      entries: [
        {
          entryId: 'entry-1',
          orderNo: 'ORD-1',
          type: 'SALE_REVERSAL',
          amount: 100,
          occurredAt: '2026-01-05T00:00:00.000Z',
        },
      ],
    });

    const texts = await renderPage();

    expect(hasText(texts, '货款冲回')).toBe(true);
    expect(hasText(texts, 'SALE_REVERSAL')).toBe(false);
  });

  it('⚠️ 明细的四列表头都在', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '时间')).toBe(true);
    expect(hasText(texts, '订单号')).toBe(true);
    expect(hasText(texts, '类型')).toBe(true);
    expect(hasText(texts, '金额')).toBe(true);
  });

  it('没有明细时显示「暂无明细。」而不是空白表', async () => {
    apiFetchAuthedMock.mockResolvedValue({ ...DETAIL, entries: [] });

    const texts = await renderPage();

    expect(hasText(texts, '暂无明细。')).toBe(true);
  });
});

describe('出款单详情页：客户端组件拿到的 props', () => {
  it('审批操作拿到的是这张单据与它的状态', async () => {
    const actions = await renderActionProps('payout-1');

    // ⚠️ **状态必须原样传下去**：按钮要根据状态决定显示「通过」
    // 还是「拒绝」，传错状态就等于给了错的操作。
    expect(actions).toHaveLength(1);
    expect(actions[0].payoutId).toBe('payout-1');
    expect(actions[0].status).toBe('REQUESTED');
  });

  it('⚠️ 申请时的预估金额也传下去（确认框里要提示重算可能不同）', async () => {
    const actions = await renderActionProps('payout-1');

    expect(actions[0].requestedAmount).toBe(88888);
  });
});
