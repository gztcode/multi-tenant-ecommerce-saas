/**
 * 对账详情页（Server Component）的筛选与截断提示。
 *
 * ⚠️ **遍历元素树而不是渲染 HTML**：页面上有 `next/link`，
 * 在 Next 运行时之外渲染它可能抛错。直接 `await Page(...)` 拿到元素树，
 * 只读 `props.children`，**不执行任何组件函数**。
 *
 * ⚠️ **这一页最要紧的护栏是「筛选真的进了请求」** —— 页面能选、请求却没带，
 *    运营就会以为「CRITICAL 只有这几条」，而实际只是前 200 条里恰好这些。
 *    所以断言的是 `apiFetchAuthed` 收到的**完整路径**。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ⚠️ `@/auth` 必须 mock 掉：`@/lib/api-client` 会 import 它，
// 而 `next-auth` 会间接 import `next/server`（node 环境下直接 import 会炸）。
vi.mock('@/auth', () => ({ auth: vi.fn() }));

const { apiFetchAuthedMock } = vi.hoisted(() => ({
  apiFetchAuthedMock: vi.fn(),
}));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>(
    '@/lib/api-client',
  );
  return { ...actual, apiFetchAuthed: apiFetchAuthedMock };
});

import ReconciliationDetailPage from '@/app/(dashboard)/reconciliations/[id]/page';
import { ReconciliationItemsTable } from '@/app/(dashboard)/reconciliations/reconciliation-items-table';
import type {
  Reconciliation,
  ReconciliationItem,
} from '@/lib/reconciliation';

import {
  collectComponentProps,
  collectHrefs,
  collectText,
  hasText,
} from '../helpers/page-tree';

const ID = 'rec-1';
const params = Promise.resolve({ id: ID });

/** 一条差异项（字段齐全，避免页面读到 undefined 时被掩盖） */
function makeItem(overrides: Partial<ReconciliationItem> = {}): ReconciliationItem {
  return {
    id: 'item-1',
    reconciliationId: ID,
    type: 'AMOUNT_MISMATCH',
    severity: 'CRITICAL',
    payoutId: null,
    channelTxnId: null,
    channelReferenceNo: null,
    channelAmount: null,
    channelStatus: null,
    channelPaidAt: null,
    localAmount: null,
    localStatus: null,
    resolution: 'PENDING',
    resolvedBy: null,
    resolvedAt: null,
    note: null,
    ...overrides,
  };
}

/**
 * 一张**任务级共 206 条差异**的对账任务（列表只回了 2 条）。
 *
 * ⚠️ **任务级总数与列表长度故意不一致** —— 这正是「超过 200 条」的形态；
 *    两者相等的话，截断提示的用例根本咬不住实现。
 */
function makeReconciliation(
  overrides: Partial<Reconciliation> = {},
): Reconciliation {
  return {
    id: ID,
    channel: 'fake-payout',
    source: 'FILE',
    windowFrom: '2026-03-01T00:00:00.000Z',
    windowTo: '2026-03-02T00:00:00.000Z',
    fileName: 'bill.csv',
    status: 'COMPLETED',
    triggeredBy: 'admin-1',
    startedAt: '2026-03-02T00:00:00.000Z',
    finishedAt: '2026-03-02T00:01:00.000Z',
    channelCount: 300,
    localCount: 100,
    matchedCount: 94,
    diffCount: 206,
    errorMessage: null,
    items: [
      makeItem({ id: 'item-crit' }),
      makeItem({ id: 'item-info', severity: 'INFO', type: 'CHANNEL_PENDING_LOCAL' }),
    ],
    itemsTruncated: true,
    itemsTotal: 206,
    actionableCount: 3,
    ...overrides,
  };
}

async function renderPage(
  searchParams: Record<string, string> = {},
  data: Reconciliation = makeReconciliation(),
) {
  apiFetchAuthedMock.mockResolvedValue(data);
  const element = await ReconciliationDetailPage({
    params,
    searchParams: Promise.resolve(searchParams),
  });
  return {
    element,
    text: collectText(element),
    hrefs: collectHrefs(element),
    tableProps: collectComponentProps(
      element,
      ReconciliationItemsTable as never,
    )[0] as { emptyText?: string; items: ReconciliationItem[] },
  };
}

/** 页面实际请求的后端路径 */
function requestedPath(): string {
  return apiFetchAuthedMock.mock.calls[0][0] as string;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('对账详情页：差异筛选', () => {
  it('无筛选参数 → 请求不带问号（行为与改造前逐字一致）', async () => {
    const { text, tableProps } = await renderPage();

    expect(requestedPath()).toBe('/platform/payout-reconciliations/rec-1');
    // 空态文案保持原样，不能因为「支持筛选」就改成筛选口径
    expect(tableProps.emptyText).toBe('没有差异。');
    expect(hasText(text, '差异共 206 条，当前按筛选显示前 2 条')).toBe(true);
  });

  it('severity=CRITICAL → 参数进请求，截断提示说明是筛选口径', async () => {
    const { text, tableProps, hrefs } = await renderPage({
      severity: 'CRITICAL',
    });

    expect(requestedPath()).toBe(
      '/platform/payout-reconciliations/rec-1?severity=CRITICAL',
    );
    expect(
      hasText(text, '差异共 206 条（当前筛选条件下），当前按筛选显示前 2 条'),
    ).toBe(true);
    expect(tableProps.emptyText).toBe('当前筛选条件下没有差异。');
    // 有筛选时才给「清除筛选」的出口
    expect(hrefs).toContain('/reconciliations/rec-1');
  });

  it('三个参数同时生效，且按固定顺序拼进请求', async () => {
    await renderPage({
      severity: 'CRITICAL',
      resolution: 'PENDING',
      type: 'AMOUNT_MISMATCH',
    });

    expect(requestedPath()).toBe(
      '/platform/payout-reconciliations/rec-1' +
        '?severity=CRITICAL&resolution=PENDING&type=AMOUNT_MISMATCH',
    );
  });

  it('空串视为没选（GET 表单会带上空的 select）', async () => {
    const { hrefs } = await renderPage({
      severity: '',
      resolution: '',
      type: '',
    });

    expect(requestedPath()).toBe('/platform/payout-reconciliations/rec-1');
    expect(hrefs).not.toContain('/reconciliations/rec-1');
  });

  it('非法筛选值 → 忽略该条件并如实提示，不把它发给后端', async () => {
    const { text } = await renderPage({ severity: 'critical' });

    // 后端对非法枚举是 400；页面这一层就该挡住，不要把它变成错误页
    expect(requestedPath()).toBe('/platform/payout-reconciliations/rec-1');
    expect(hasText(text, '筛选条件非法（严重级）')).toBe(true);
  });

  it('未截断时不出现提示', async () => {
    const { text } = await renderPage(
      {},
      makeReconciliation({ itemsTruncated: false, itemsTotal: 2 }),
    );

    expect(hasText(text, '当前按筛选显示前')).toBe(false);
  });

  it('不再承诺「去列表页按批次查看」（那条路不存在）', async () => {
    const { text } = await renderPage();

    expect(hasText(text, '列表页按批次')).toBe(false);
    // 取而代之：指向筛选控件与统计口径
    expect(hasText(text, '请用上方的筛选缩小范围')).toBe(true);
  });
});
