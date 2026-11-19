// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SkuPriceTable } from '@/components/product/sku-price-table';

/**
 * 行 fixture：一个「已启用、无划线价、有编码」的 SKU。
 * 编码非空 → 行标签用商家编码「A」（fallbackLabel），
 * aria-label 因此是「A 售价」「A 划线价」「A 商家编码」。
 */
const SKU = {
  id: 'sku-a',
  price: 1000, // 10.00 元
  comparePrice: null,
  code: 'A',
  status: 'ACTIVE' as const,
};

/** 成功响应：回读服务端处理后的 SKU 字段（saveRow 用它覆盖草稿）。 */
function okResponse(updated: object): Response {
  return new Response(JSON.stringify(updated), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** 失败响应：后端 message 经 readResponse 透传到界面。 */
function errResponse(message: string): Response {
  return new Response(JSON.stringify({ message }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
}

function renderTable(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('fetch', fetchMock);
  render(<SkuPriceTable productId="prod-1" skus={[SKU]} specs={[]} />);
}

/** 取最后一次 fetch 调用的参数（URL、method、JSON 解析后的 body）。 */
function lastCall(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  return { url, method: (init as RequestInit).method, body: JSON.parse((init as RequestInit).body as string) };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('SKU 价格表的保存行为', () => {
  it('合法的元金额保存为整数分：10.5 元 → body.price 是 1050 分（PATCH，URL 精确）', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(okResponse({ price: 1050, comparePrice: null, code: 'A', status: 'ACTIVE' })));
    renderTable(fetchMock);

    const priceInput = screen.getByLabelText('A 售价');
    await userEvent.clear(priceInput);
    await userEvent.type(priceInput, '10.5');
    await userEvent.tab(); // 失焦触发自动保存

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, method, body } = lastCall(fetchMock);
    expect(url).toBe('/api/products/prod-1/skus/sku-a');
    expect(method).toBe('PATCH');
    expect(body).toEqual({ price: 1050 }); // 金额是分，不是元
    expect(await screen.findByText('已保存')).toBeTruthy();
  });

  it('浮点误差边界：12.34 元 → 1234 分，不因浮点误差差一分', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(okResponse({ price: 1234, comparePrice: null, code: 'A', status: 'ACTIVE' })));
    renderTable(fetchMock);

    const priceInput = screen.getByLabelText('A 售价');
    await userEvent.clear(priceInput);
    await userEvent.type(priceInput, '12.34');
    await userEvent.tab();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastCall(fetchMock).body).toEqual({ price: 1234 });
  });

  it('两位以上小数被拒：10.555 → 不发请求，提示售价必须是 ≥ 0 的金额（最多两位小数）', async () => {
    const fetchMock = vi.fn();
    renderTable(fetchMock);

    const priceInput = screen.getByLabelText('A 售价');
    await userEvent.clear(priceInput);
    await userEvent.type(priceInput, '10.555');
    await userEvent.tab();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await screen.findByText('售价必须是 ≥ 0 的金额（最多两位小数）')).toBeTruthy();
  });

  it('划线价从有到无 → 提交 comparePrice: null（不是 0）', async () => {
    const skuWithCompare = { ...SKU, comparePrice: 2000 }; // 20.00 元
    const fetchMock = vi.fn(() => Promise.resolve(okResponse({ price: 1000, comparePrice: null, code: 'A', status: 'ACTIVE' })));
    vi.stubGlobal('fetch', fetchMock);
    render(<SkuPriceTable productId="prod-1" skus={[skuWithCompare]} specs={[]} />);

    const compareInput = screen.getByLabelText('A 划线价');
    await userEvent.clear(compareInput);
    await userEvent.tab();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastCall(fetchMock).body).toEqual({ comparePrice: null });
  });

  it('划线价元→分：19.9 元 → comparePrice: 1990 分', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(okResponse({ price: 1000, comparePrice: 1990, code: 'A', status: 'ACTIVE' })));
    renderTable(fetchMock);

    const compareInput = screen.getByLabelText('A 划线价');
    await userEvent.type(compareInput, '19.9');
    await userEvent.tab();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastCall(fetchMock).body).toEqual({ comparePrice: 1990 });
  });

  it('点击状态开关 → PATCH body { status: INACTIVE }，最低价统计跟随草稿变为 0 个已启用', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(okResponse({ status: 'INACTIVE' })));
    renderTable(fetchMock);

    await userEvent.click(screen.getByRole('button', { name: '已启用（点击停用）' }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, method, body } = lastCall(fetchMock);
    expect(url).toBe('/api/products/prod-1/skus/sku-a');
    expect(method).toBe('PATCH');
    expect(body).toEqual({ status: 'INACTIVE' });
    // 草稿状态已生效于最低价统计（停用的不参与）。
    expect(await screen.findByText(/0 个已启用/)).toBeTruthy();
  });

  it('点击停用后界面立即翻转：按钮变「已停用（点击启用）」并出现已停用徽标（BUG 复现：此前读的是初始 prop）', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(okResponse({ status: 'INACTIVE' })));
    renderTable(fetchMock);

    await userEvent.click(screen.getByRole('button', { name: '已启用（点击停用）' }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastCall(fetchMock).body).toEqual({ status: 'INACTIVE' });
    // ⚠️ 界面必须反映已保存的草稿状态，而不是等父组件刷新重传 skus。
    expect(await screen.findByRole('button', { name: '已停用（点击启用）' })).toBeTruthy();
    expect(await screen.findByText('已停用')).toBeTruthy();
  });

  it('后端 400 → 显示后端返回的 message', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(errResponse('价格超出上限')));
    renderTable(fetchMock);

    const priceInput = screen.getByLabelText('A 售价');
    await userEvent.clear(priceInput);
    await userEvent.type(priceInput, '99');
    await userEvent.tab();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('价格超出上限')).toBeTruthy();
  });

  it('没有改动 → 显示「没有改动」且不发请求', async () => {
    const fetchMock = vi.fn();
    renderTable(fetchMock);

    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await screen.findByText('没有改动')).toBeTruthy();
  });
});
