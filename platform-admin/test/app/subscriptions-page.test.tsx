/**
 * 订阅列表页（Server Component）的页面级测试。
 *
 * ⚠️ **遍历元素树而不是渲染 HTML**：页面上有 `next/link`，
 * 在 Next 运行时之外渲染它可能抛错。直接 `await SubscriptionsPage()`
 * 拿到元素树，只读 `props.children`，**不执行任何组件函数**。
 *
 * ⚠️ **断言要具体**：变异 `describeSubscriptionStatus` → 内联裸枚举时，
 * 全部用例照样通过 —— 那说明页面根本没被测过。
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

import SubscriptionsPage from '@/app/(dashboard)/subscriptions/page';
import type { PlatformSubscription, SubscriptionList } from '@/lib/billing';

import { collectText, hasText } from '../helpers/page-tree';

const SUBSCRIPTION: PlatformSubscription = {
  id: 'sub-1',
  tenantId: 'tenant-1',
  tenantName: '优选生活',
  tenantSubdomain: 'yousheng',
  planId: 'plan-1',
  planName: '专业版',
  pendingPlanId: null,
  pendingPlanName: null,
  status: 'ACTIVE',
  commissionBps: 500,
  startedAt: '2026-10-01T00:00:00.000Z',
  trialEndsAt: null,
  currentPeriodStart: '2026-10-01T00:00:00.000Z',
  currentPeriodEnd: '2026-10-31T00:00:00.000Z',
  cancelAtPeriodEnd: false,
};

async function renderPage(): Promise<string[]> {
  const element = await SubscriptionsPage();
  return collectText(element);
}

beforeEach(() => {
  vi.clearAllMocks();
  apiFetchAuthedMock.mockResolvedValue({
    items: [SUBSCRIPTION],
    total: 1,
  } as SubscriptionList);
});

describe('订阅页：订阅列表', () => {
  it('商家名与子域名都显示', async () => {
    const texts = await renderPage();

    // ⚠️ **两个都要有**：超管靠子域名区分同名商家。
    expect(hasText(texts, '优选生活')).toBe(true);
    expect(hasText(texts, 'yousheng')).toBe(true);
  });

  it('套餐名显示出来', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '专业版')).toBe(true);
  });

  it('状态显示成中文（生效中）', async () => {
    const texts = await renderPage();

    // ⚠️ **不能是裸枚举 `ACTIVE`**：超管看不懂 Prisma 的枚举名。
    expect(hasText(texts, '生效中')).toBe(true);
  });

  it('有 pendingPlanName 时显示「下个周期：xxx」', async () => {
    apiFetchAuthedMock.mockResolvedValue({
      items: [
        { ...SUBSCRIPTION, pendingPlanId: 'plan-2', pendingPlanName: '旗舰版' },
      ],
      total: 1,
    } as SubscriptionList);

    const texts = await renderPage();

    // ⚠️ **「即将涨价」这件事必须看得见**：不显示的话这张表读不出来。
    expect(hasText(texts, '下个周期：旗舰版')).toBe(true);
  });

  it('没有 pendingPlanName 时不显示「下个周期」', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '下个周期')).toBe(false);
  });

  it('抽佣费率显示成百分比', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '5%')).toBe(true);
  });

  it('到期后不续费显示成「是」/「否」', async () => {
    const texts = await renderPage();
    expect(hasText(texts, '否')).toBe(true);

    apiFetchAuthedMock.mockResolvedValue({
      items: [{ ...SUBSCRIPTION, cancelAtPeriodEnd: true }],
      total: 1,
    } as SubscriptionList);
    const canceled = await renderPage();
    expect(hasText(canceled, '是')).toBe(true);
  });
});

describe('订阅页：列表被截断时的提示', () => {
  it('⚠️ total 大于返回条数时提示「仅显示最近 N 条，共 M 条」', async () => {
    apiFetchAuthedMock.mockResolvedValue({
      items: [SUBSCRIPTION],
      total: 250,
    } as SubscriptionList);

    const texts = await renderPage();

    // ⚠️ **不提示的话，超管看到 1 条会以为平台只有 1 个订阅**。
    expect(hasText(texts, '仅显示最近 1 条，共 250 条')).toBe(true);
  });

  it('total 等于返回条数时不提示截断', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '仅显示最近')).toBe(false);
  });
});

describe('订阅页：空列表与失败', () => {
  it('空列表显示「暂无订阅。」', async () => {
    apiFetchAuthedMock.mockResolvedValue({ items: [], total: 0 } as SubscriptionList);

    const texts = await renderPage();

    expect(hasText(texts, '暂无订阅。')).toBe(true);
  });

  it('⚠️ 取数失败时显示错误提示，且不崩', async () => {
    const { ApiError } = await vi.importActual<
      typeof import('@/lib/api-client')
    >('@/lib/api-client');
    apiFetchAuthedMock.mockRejectedValue(
      new ApiError(403, 'FORBIDDEN', '令牌角色不对'),
    );

    const texts = await renderPage();

    expect(hasText(texts, '加载订阅列表失败')).toBe(true);
    expect(hasText(texts, '403')).toBe(true);
  });

  it('⚠️ 取数失败（非 ApiError）时也有提示', async () => {
    apiFetchAuthedMock.mockRejectedValue(new Error('网络断了'));

    const texts = await renderPage();

    expect(hasText(texts, '网络断了')).toBe(true);
  });
});

describe('订阅页：整体', () => {
  it('页面上有「订阅」标题与总数', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '订阅')).toBe(true);
    expect(hasText(texts, '全部订阅（')).toBe(true);
  });

  it('⚠️ 平台侧只读：页面上没有写操作的按钮', async () => {
    const texts = await renderPage();

    // ⚠️ **护栏 M3**：平台能替商家换套餐就能绕过计费规则。
    // 这一页没有写操作，所以界面上不该出现「换套餐」这类入口。
    expect(hasText(texts, '换套餐')).toBe(false);
  });
});
