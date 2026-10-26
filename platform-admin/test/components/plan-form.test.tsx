// @vitest-environment jsdom
/**
 * 套餐表单的关键行为。
 *
 * ⚠️ **第一行必须写 `// @vitest-environment jsdom`**：
 * platform-admin 的 vitest 配置全局是 `node`（Route Handler 用 Web 标准的
 * Request / Response，不需要 DOM）。逐文件的环境注释**优先于全局配置**。
 *
 * ⚠️ **断言要具体**：只断言「点得动」或「不报错」都算恒真。
 * 这里断言的是**发出去的请求体**（价格是不是整数分、费率是不是基点）
 * 与**界面上真的显示了什么**。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { PlanDisableButton, PlanForm } from '@/app/(dashboard)/plans/plan-form';
import type { Plan } from '@/lib/billing';

const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

/** 读出 fetch 调用参数 */
function callOf(fetchMock: ReturnType<typeof vi.fn>, index = 0) {
  const [url, options] = fetchMock.mock.calls[index] as [string, RequestInit];
  return { url, options, body: JSON.parse(String(options.body)) as Record<string, unknown> };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 无内容响应（下架接口回的是 204） */
function noContentResponse(status = 204): Response {
  return new Response(null, { status });
}

const PLAN: Plan = {
  id: 'plan-1',
  code: 'PRO',
  name: '专业版',
  description: '面向成长期的商家',
  price: 9900,
  periodDays: 30,
  trialDays: 14,
  commissionBps: 500,
  maxProducts: 100,
  maxSkus: 500,
  maxStores: 1,
  features: { marketing: true },
  status: 'ACTIVE',
  sortOrder: 0,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn(async () => jsonResponse({ id: 'plan-1' }));
  vi.stubGlobal('fetch', fetchMock);
});

describe('PlanForm：新建套餐', () => {
  it('提交时把「元」换算成整数分、把「%」换算成基点', async () => {
    const user = userEvent.setup();
    render(<PlanForm />);

    await user.type(screen.getByLabelText('代码'), 'PRO');
    await user.type(screen.getByLabelText('名称'), '专业版');
    await user.type(screen.getByLabelText('周期价格（元）'), '99.00');
    await user.type(screen.getByLabelText('抽佣比例（%）'), '5');
    await user.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const { url, options, body } = callOf(fetchMock);
    expect(url).toBe('/api/billing/plans');
    expect(options.method).toBe('POST');
    // ⚠️ **金额必须是整数分**：界面上的「99.00 元」提交出去是 9900。
    expect(body.price).toBe(9900);
    // ⚠️ **费率必须是基点**：界面上的「5%」提交出去是 500。
    expect(body.commissionBps).toBe(500);
    expect(body.code).toBe('PRO');
    expect(body.name).toBe('专业版');
  });

  it('⚠️ 价格非法时显示错误提示，且根本不发请求', async () => {
    const user = userEvent.setup();
    render(<PlanForm />);

    await user.type(screen.getByLabelText('代码'), 'PRO');
    await user.type(screen.getByLabelText('名称'), '专业版');
    await user.type(screen.getByLabelText('周期价格（元）'), 'abc');
    await user.click(screen.getByRole('button', { name: '创建' }));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('周期价格');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('⚠️ 抽佣比例非法时显示错误提示，且根本不发请求', async () => {
    const user = userEvent.setup();
    render(<PlanForm />);

    await user.type(screen.getByLabelText('代码'), 'PRO');
    await user.type(screen.getByLabelText('名称'), '专业版');
    // ⚠️ **价格要填对**：校验是按顺序做的，价格不合法时先报价格，
    // 根本轮不到抽佣比例 —— 那样这条用例就名不副实了。
    await user.type(screen.getByLabelText('周期价格（元）'), '99.00');
    await user.type(screen.getByLabelText('抽佣比例（%）'), 'abc');
    await user.click(screen.getByRole('button', { name: '创建' }));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('抽佣比例');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('⚠️ 不勾选营销工具时，整个 features 键都不在请求体里', async () => {
    const user = userEvent.setup();
    render(<PlanForm />);

    await user.type(screen.getByLabelText('代码'), 'PRO');
    await user.type(screen.getByLabelText('名称'), '专业版');
    await user.type(screen.getByLabelText('周期价格（元）'), '99.00');
    await user.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // ⚠️ **不是 `features: { marketing: false }`**：后端的语义是
    // 「缺省一律视为 false」，缺键与显式 false 等价，但缺键不会留下
    // 「这个键到底是没配还是配成 false」的歧义。
    const { body } = callOf(fetchMock);
    expect(body).not.toHaveProperty('features');
  });

  it('⚠️ 勾选营销工具时，features 里只有 marketing: true', async () => {
    const user = userEvent.setup();
    render(<PlanForm />);

    await user.type(screen.getByLabelText('代码'), 'PRO');
    await user.type(screen.getByLabelText('名称'), '专业版');
    await user.type(screen.getByLabelText('周期价格（元）'), '99.00');
    await user.click(screen.getByLabelText('营销工具'));
    await user.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const { body } = callOf(fetchMock);
    expect(body.features).toEqual({ marketing: true });
  });
});

describe('PlanForm：编辑套餐', () => {
  it('字段是预填的，提交走 PATCH', async () => {
    const user = userEvent.setup();
    render(<PlanForm plan={PLAN} />);

    // ⚠️ **预填要真的预填**：价格显示成「元」（不是 9900 分），
    // 费率显示成「%」（不是 500 基点）。
    expect(
      (screen.getByLabelText('周期价格（元）') as HTMLInputElement).value,
    ).toBe('99.00');
    expect(
      (screen.getByLabelText('抽佣比例（%）') as HTMLInputElement).value,
    ).toBe('5');
    expect((screen.getByLabelText('代码') as HTMLInputElement).value).toBe(
      'PRO',
    );
    expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe(
      '专业版',
    );

    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const { url, options, body } = callOf(fetchMock);
    expect(url).toBe('/api/billing/plans/plan-1');
    expect(options.method).toBe('PATCH');
    expect(body.price).toBe(9900);
    expect(body.commissionBps).toBe(500);
  });

  it('⚠️ 把额度清空 = 显式传 null（清空即「不限」）', async () => {
    const user = userEvent.setup();
    render(<PlanForm plan={PLAN} />);

    // ⚠️ **预填的额度是 100**：清空它，超管的意思是「这条要改成不限」。
    const input = screen.getByLabelText('商品数上限（留空 = 不限）');
    expect((input as HTMLInputElement).value).toBe('100');
    await user.clear(input);

    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const { body } = callOf(fetchMock);
    // ⚠️ **必须是 null**：不是「不放这个键」（那样改不回不限），
    // 也不是原来的 100（那样清空根本没生效）。
    expect(body.maxProducts).toBeNull();
    // ⚠️ **没碰过的额度带着原值**：maxSkus / maxStores 分别是 500 / 1，
    // 不能因为 maxProducts 被清空就一起变成 null。
    expect(body.maxSkus).toBe(500);
    expect(body.maxStores).toBe(1);
  });

  it('额度没碰过时带着原值提交（不会莫名变成 null）', async () => {
    const user = userEvent.setup();
    render(<PlanForm plan={PLAN} />);

    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const { body } = callOf(fetchMock);
    expect(body.maxProducts).toBe(100);
    expect(body.maxSkus).toBe(500);
    expect(body.maxStores).toBe(1);
  });

  it('新建时留空的额度 = null（不限）', async () => {
    const user = userEvent.setup();
    render(<PlanForm />);

    await user.type(screen.getByLabelText('代码'), 'PRO');
    await user.type(screen.getByLabelText('名称'), '专业版');
    await user.type(screen.getByLabelText('周期价格（元）'), '99.00');
    // 三个额度都不填 → 三个都是 null（不限）。
    await user.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const { body } = callOf(fetchMock);
    expect(body.maxProducts).toBeNull();
    expect(body.maxSkus).toBeNull();
    expect(body.maxStores).toBeNull();
  });

  it('⚠️ 把说明清空 = 显式传 null（清空即「没有说明」）', async () => {
    const user = userEvent.setup();
    render(<PlanForm plan={PLAN} />);

    // ⚠️ **预填的说明是「面向成长期的商家」**：清空它，
    // 超管的意思是「这条不要说明了」。
    const input = screen.getByLabelText('说明（留空 = 清空说明）');
    expect((input as HTMLInputElement).value).toBe('面向成长期的商家');
    await user.clear(input);

    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const { body } = callOf(fetchMock);
    // ⚠️ **必须是 null**：不是「不放这个键」（那样后端的
    // `if (dto.description !== undefined)` 不命中，旧说明原样保留，
    // 而界面上却显示「保存成功」—— 假装成功是最坏的形态），
    // 也不是空串（那会被写成「空字符串」而不是「没有说明」）。
    expect(body).toHaveProperty('description');
    expect(body.description).toBeNull();
  });

  it('说明没碰过时带着原值提交', async () => {
    const user = userEvent.setup();
    render(<PlanForm plan={PLAN} />);

    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const { body } = callOf(fetchMock);
    expect(body.description).toBe('面向成长期的商家');
  });

  it('新建时留空的说明 = null（没有说明）', async () => {
    const user = userEvent.setup();
    render(<PlanForm />);

    await user.type(screen.getByLabelText('代码'), 'PRO');
    await user.type(screen.getByLabelText('名称'), '专业版');
    await user.type(screen.getByLabelText('周期价格（元）'), '99.00');
    await user.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const { body } = callOf(fetchMock);
    // ⚠️ **新建 / 编辑用同一套规则**（不传 = 不改）—— 一套规则不容易漂移。
    expect(body.description).toBeNull();
  });
});

describe('PlanDisableButton：下架套餐', () => {
  it('⚠️ 后端回 204（无内容）时不报错', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(noContentResponse());
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<PlanDisableButton planId="plan-1" planName="专业版" />);
    await user.click(screen.getByRole('button', { name: '下架' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // ⚠️ **204 没有 body**：无条件 `response.json()` 会抛「body 已消费」，
    // 成功的事会被报成失败（界面上冒出「下架失败」）。
    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('⚠️ 失败时显示错误提示', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ message: '套餐已下架' }, 409));
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<PlanDisableButton planId="plan-1" planName="专业版" />);
    await user.click(screen.getByRole('button', { name: '下架' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('套餐已下架');
    // ⚠️ **失败就不该刷新**：刷新了会把错误提示冲掉。
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('⚠️ 失败后按钮恢复可点（闸门复位）', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ message: '下不了架' }, 500));
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<PlanDisableButton planId="plan-1" planName="专业版" />);
    const button = screen.getByRole('button', { name: '下架' });
    await user.click(button);

    await screen.findByRole('alert');

    // ⚠️ **按钮必须回到可点状态**：`busyRef` / `busy` 没复位的话，
    // 按钮永远停在「下架中…」且再也点不动 —— 一次失败就把这个按钮废掉。
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '下架' })).not.toBeDisabled();
    });
  });

  it('用户取消确认 → 根本不发请求', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<PlanDisableButton planId="plan-1" planName="专业版" />);
    await user.click(screen.getByRole('button', { name: '下架' }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });
});
