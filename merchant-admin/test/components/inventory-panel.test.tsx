// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { InventoryPanel } from '@/components/product/inventory-panel';

const SKUS = [
  { skuId: 'sku-a', code: 'A', stock: 10, status: 'ACTIVE' },
  { skuId: 'sku-b', code: 'B', stock: 20, status: 'ACTIVE' },
];

function movements(item: string) {
  return {
    items: [
      {
        id: `${item}-1`,
        skuId: item,
        type: 'ADJUST_IN',
        quantity: 1,
        stockBefore: 0,
        stockAfter: 1,
        reason: item === 'sku-a' ? 'A 的流水' : 'B 的流水',
        createdAt: '2026-11-04T00:00:00.000Z',
      },
    ],
  };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('库存面板的切 SKU 竞态', () => {
  it('先发出的旧响应晚到 → 丢弃，不覆盖新选择', async () => {
    let resolveB!: (value: Response) => void;
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('skuId=sku-a')) {
        // A 的响应故意晚到
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(new Response(JSON.stringify(movements('sku-a')))), 50);
        });
      }
      if (url.includes('skuId=sku-b')) {
        return new Promise<Response>((resolve) => {
          resolveB = resolve;
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ items: [] })));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<InventoryPanel skus={SKUS} />);

    // 初次加载 A → 切到 B → 再切回 A
    const select = screen.getByLabelText('SKU');
    await userEvent.selectOptions(select, 'sku-b');
    await userEvent.selectOptions(select, 'sku-a');

    // 放行 B 的迟到响应
    resolveB(new Response(JSON.stringify(movements('sku-b'))));

    // 最终显示的必须是 A 的流水
    await waitFor(() => {
      expect(screen.getByText('A 的流水')).toBeTruthy();
    });
    expect(screen.queryByText('B 的流水')).toBeNull();
  });

  it('响应体解析期间切走 → 旧数据仍被丢弃', async () => {
    let resolveAJson!: (value: unknown) => void;
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('skuId=sku-a')) {
        // A 的响应头先到，但响应体解析挂起 —— 期间用户切到 B。
        return Promise.resolve({
          ok: true,
          json: () =>
            new Promise<unknown>((resolve) => {
              resolveAJson = resolve;
            }),
        } as unknown as Response);
      }
      return Promise.resolve(
        new Response(JSON.stringify(movements('sku-b'))),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<InventoryPanel skus={SKUS} />);
    await waitFor(() => expect(resolveAJson).toBeTypeOf('function'));

    await userEvent.selectOptions(screen.getByLabelText('SKU'), 'sku-b');
    await waitFor(() => {
      expect(screen.getByText('B 的流水')).toBeTruthy();
    });

    // A 的响应体此时才解析完：序号已过期，必须丢弃。
    resolveAJson(movements('sku-a'));
    await waitFor(() => {
      expect(screen.queryByText('A 的流水')).toBeNull();
    });
    expect(screen.getByText('B 的流水')).toBeTruthy();
  });
});
