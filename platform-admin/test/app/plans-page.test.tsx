/**
 * 套餐列表页（Server Component）的页面级测试。
 *
 * ⚠️ **为什么不用 `renderToStaticMarkup`**：页面上有 `next/link`，
 * 在 Next 运行时之外渲染它可能抛错。这里改成**遍历元素树**：
 * 直接 `await PlansPage({ searchParams })` 拿到元素树，
 * 只读 `props.children`，**不执行任何组件函数**。
 *
 * ⚠️ **断言要具体**：变异 `formatQuota` → 内联 `?? '不限'` 时，
 * 全部用例照样通过 —— 那说明页面根本没被测过。这里逐条锁住
 * 「页面上真的出现了什么」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentType } from 'react';

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

import PlansPage from '@/app/(dashboard)/plans/page';
import { PlanForm } from '@/app/(dashboard)/plans/plan-form';
import type { Plan, PlanList } from '@/lib/billing';

import { collectComponentProps, collectHrefs, collectText, hasText } from '../helpers/page-tree';

const PLAN: Plan = {
  id: 'plan-1',
  code: 'PRO',
  name: '专业版',
  description: '面向成长期的商家',
  price: 9900,
  periodDays: 30,
  trialDays: 14,
  commissionBps: 500,
  maxProducts: null,
  maxSkus: 20,
  maxStores: 1,
  features: { marketing: true },
  status: 'ACTIVE',
  sortOrder: 0,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

/** 渲染页面并收集文字 */
async function renderPage(params: {
  new?: string;
  edit?: string;
} = {}): Promise<string[]> {
  const element = await PlansPage({ searchParams: Promise.resolve(params) });
  return collectText(element);
}

/** 渲染页面并收集链接地址 */
async function renderHrefs(params: {
  new?: string;
  edit?: string;
} = {}): Promise<string[]> {
  const element = await PlansPage({ searchParams: Promise.resolve(params) });
  return collectHrefs(element);
}

/** 渲染页面并收集 PlanForm 收到的 props */
async function renderFormProps(params: {
  new?: string;
  edit?: string;
} = {}): Promise<Record<string, unknown>[]> {
  const element = await PlansPage({ searchParams: Promise.resolve(params) });
  return collectComponentProps(
    element,
    PlanForm as unknown as ComponentType<unknown>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  apiFetchAuthedMock.mockResolvedValue({
    items: [PLAN],
    total: 1,
  } as PlanList);
});

describe('套餐页：套餐列表', () => {
  it('三个额度都显示（null → 不限，有值的显示数字）', async () => {
    const texts = await renderPage();

    // ⚠️ **三档都要能看到**：超管要一眼看出套餐卡在哪一项上。
    // 商品数上限是 null → 「不限」，SKU 是 20，店铺数是 1。
    expect(hasText(texts, '不限')).toBe(true);
    expect(hasText(texts, '20')).toBe(true);
    expect(hasText(texts, '1')).toBe(true);
    // ⚠️ **三档的标签都要在**：不然「20」可能是别的数字碰巧撞上。
    expect(hasText(texts, '商品')).toBe(true);
    expect(hasText(texts, 'SKU')).toBe(true);
    expect(hasText(texts, '店铺')).toBe(true);
  });

  it('抽佣费率显示成百分比', async () => {
    const texts = await renderPage();

    // ⚠️ **500 基点 = 5%**，不是「500」也不是「5.00%」。
    expect(hasText(texts, '5%')).toBe(true);
  });

  it('状态显示成中文（在售 / 已下架）', async () => {
    const texts = await renderPage();
    expect(hasText(texts, '在售')).toBe(true);

    apiFetchAuthedMock.mockResolvedValue({
      items: [{ ...PLAN, status: 'DISABLED' }],
      total: 1,
    } as PlanList);
    const disabled = await renderPage();
    expect(hasText(disabled, '已下架')).toBe(true);
  });

  it('功能开关显示成中文名', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '营销工具')).toBe(true);
  });

  it('价格与周期也显示出来', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '¥99.00')).toBe(true);
    expect(hasText(texts, '30 天')).toBe(true);
  });

  it('空列表显示「暂无套餐。」', async () => {
    apiFetchAuthedMock.mockResolvedValue({ items: [], total: 0 } as PlanList);

    const texts = await renderPage();

    expect(hasText(texts, '暂无套餐。')).toBe(true);
  });

  it('⚠️ 取数失败时显示错误提示，且不崩', async () => {
    const { ApiError } = await vi.importActual<
      typeof import('@/lib/api-client')
    >('@/lib/api-client');
    apiFetchAuthedMock.mockRejectedValue(
      new ApiError(503, 'UPSTREAM', '后端没起来'),
    );

    const texts = await renderPage();

    expect(hasText(texts, '加载套餐列表失败')).toBe(true);
    expect(hasText(texts, '503')).toBe(true);
  });

  it('⚠️ 取数失败（非 ApiError）时也有提示', async () => {
    apiFetchAuthedMock.mockRejectedValue(new Error('网络断了'));

    const texts = await renderPage();

    expect(hasText(texts, '网络断了')).toBe(true);
  });
});

describe('套餐页：新建与编辑表单', () => {
  it('?new=1 渲染新建表单', async () => {
    const forms = await renderFormProps({ new: '1' });

    // ⚠️ **新建 = 不传 plan**：表单按「新建」渲染，字段全空。
    expect(forms).toHaveLength(1);
    expect(forms[0].plan).toBeUndefined();
  });

  it('?edit=<id> 渲染编辑表单，表单拿到的是那个套餐', async () => {
    const forms = await renderFormProps({ edit: 'plan-1' });

    // ⚠️ **预填的值要真的传进去**：编辑表单必须拿到被编辑的套餐。
    expect(forms).toHaveLength(1);
    expect(forms[0].plan).toMatchObject({
      id: 'plan-1',
      code: 'PRO',
      name: '专业版',
    });
  });

  it('⚠️ ?new=1 与 ?edit=<id> 同时给时，表单是编辑表单', async () => {
    const forms = await renderFormProps({ new: '1', edit: 'plan-1' });

    // ⚠️ **editId 优先**：两者都在时按编辑处理。
    expect(forms).toHaveLength(1);
    expect(forms[0].plan).toMatchObject({ id: 'plan-1' });
  });

  it('有表单时渲染「取消」链接，指向 /plans', async () => {
    const hrefs = await renderHrefs({ new: '1' });

    expect(hrefs).toContain('/plans');
  });

  it('列表里的每个套餐都有编辑链接', async () => {
    const hrefs = await renderHrefs();

    expect(hrefs).toContain('/plans?edit=plan-1');
    expect(hrefs).toContain('/plans?new=1');
  });

  it('⚠️ 找不到要编辑的套餐时给出提示，而不是崩掉', async () => {
    const texts = await renderPage({ edit: 'not-exist' });

    expect(hasText(texts, '找不到要编辑的套餐')).toBe(true);
  });
});

describe('套餐页：整体', () => {
  it('页面上有「套餐」这个标题与总数', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '套餐')).toBe(true);
    expect(hasText(texts, '全部套餐（')).toBe(true);
  });
});
