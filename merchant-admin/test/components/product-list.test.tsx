// @vitest-environment jsdom
/**
 * 商品列表（客户端组件）：批量上架 / 下架 / 删除 + 筛选 + 全选 + 分页。
 *
 * ⚠️ **写操作必须精确断言 fetch 的 URL / method / body**：
 * 只断言「点了不报错」或「点了有响应」测不出 body 拼错（比如 action 写死、
 * ids 没展开、漏了 content-type）。
 *
 * ⚠️ **`next/link` 必须 mock 掉**：被测组件渲染 `<Link>`，Next 运行时之外
 * 直接渲染 App Router 的 Link 会抛错（它内部要 useRouter / usePathname）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { routerMock, searchParams } = vi.hoisted(() => {
  const params = new URLSearchParams();
  return {
    routerMock: { push: vi.fn(), refresh: vi.fn() },
    searchParams: params,
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  useSearchParams: () => searchParams,
}));

vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) =>
      React.createElement('a', { href, ...rest }, children),
  };
});

import { ProductList, type ProductRow } from '@/components/product/product-list';

const ROWS: ProductRow[] = [
  {
    id: 'p1',
    name: '咖啡豆',
    slug: 'coffee-beans',
    status: 'PUBLISHED',
    minPrice: 5900,
    categoryId: 'c1',
  },
  {
    id: 'p2',
    name: '滤纸',
    slug: 'filter-paper',
    status: 'DRAFT',
    minPrice: 1200,
    categoryId: null,
  },
];

const CATEGORIES = [{ id: 'c1', name: '咖啡' }];

/** 统一的成功响应假实现（组件只读 response.ok 与 response.json()） */
function okResponse() {
  return { ok: true, json: async () => ({}) } as unknown as Response;
}

function renderList(overrides: Partial<Parameters<typeof ProductList>[0]> = {}) {
  return render(
    <ProductList
      initial={ROWS}
      total={5}
      page={1}
      pageSize={2}
      categories={CATEGORIES}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of [...searchParams.keys()]) {
    searchParams.delete(key);
  }
  vi.stubGlobal('confirm', vi.fn(() => true));
});

afterEach(() => vi.unstubAllGlobals());

describe('商品列表：批量上架 / 下架', () => {
  it('批量上架：POST /api/products/batch，body 精确为 { ids, action: PUBLISH }', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    renderList();
    await userEvent.click(screen.getByLabelText('选择 咖啡豆'));

    await userEvent.click(screen.getByRole('button', { name: '批量上架' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/products/batch');
    expect(options.method).toBe('POST');
    expect(options.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(options.body)).toEqual({ ids: ['p1'], action: 'PUBLISH' });
  });

  it('批量下架：选中两个商品 → body 的 ids 展开为数组且 action 为 UNPUBLISH', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    renderList();
    await userEvent.click(screen.getByLabelText('选择 咖啡豆'));
    await userEvent.click(screen.getByLabelText('选择 滤纸'));

    await userEvent.click(screen.getByRole('button', { name: '批量下架' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({ ids: ['p1', 'p2'], action: 'UNPUBLISH' });
  });

  it('成功后有成功提示、清空勾选并刷新页面', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    renderList();
    await userEvent.click(screen.getByLabelText('选择 咖啡豆'));

    await userEvent.click(screen.getByRole('button', { name: '批量上架' }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('批量上架：已处理 1 个商品');
    expect(routerMock.refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText('已选 0 个')).toBeInTheDocument();
  });

  it('未勾选任何商品时批量按钮禁用，点不到也就不会发请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    renderList();

    expect(screen.getByRole('button', { name: '批量上架' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '批量下架' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '批量删除' })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('批量操作失败 → 显示后端返回的 message', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ message: '批量操作失败' }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    renderList();
    await userEvent.click(screen.getByLabelText('选择 咖啡豆'));

    await userEvent.click(screen.getByRole('button', { name: '批量下架' }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('批量操作失败');
    // 失败时不清勾选、不刷新
    expect(routerMock.refresh).not.toHaveBeenCalled();
    expect(screen.getByText('已选 1 个')).toBeInTheDocument();
  });
});

describe('商品列表：批量删除（需确认）', () => {
  it('确认后 → 发 DELETE 到 /api/products/batch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    renderList();
    await userEvent.click(screen.getByLabelText('选择 咖啡豆'));

    await userEvent.click(screen.getByRole('button', { name: '批量删除' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/products/batch');
    expect(JSON.parse(options.body)).toEqual({ ids: ['p1'], action: 'DELETE' });
  });

  it('取消确认 → 确认框被调用且根本不发请求', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    renderList();
    await userEvent.click(screen.getByLabelText('选择 咖啡豆'));

    await userEvent.click(screen.getByRole('button', { name: '批量删除' }));

    await waitFor(() => expect(vi.mocked(confirm)).toHaveBeenCalled());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('商品列表：筛选', () => {
  it('填写关键词、状态、品类并提交 → router.push 带三个查询参数', async () => {
    renderList();

    await userEvent.type(screen.getByPlaceholderText('商品名或 slug'), '  咖啡  ');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '状态' }), 'PUBLISHED');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: '品类' }), 'c1');

    await userEvent.click(screen.getByRole('button', { name: '筛选' }));

    expect(routerMock.push).toHaveBeenCalledTimes(1);
    // URLSearchParams.toString() 会对非 ASCII 字符做百分号编码（标准行为）
    expect(routerMock.push).toHaveBeenCalledWith(
      '/products?keyword=%E5%92%96%E5%95%A1&status=PUBLISHED&categoryId=c1',
    );
  });

  it('关键词会 trim，空值不进入查询串', async () => {
    renderList();

    await userEvent.type(screen.getByPlaceholderText('商品名或 slug'), '   ');
    await userEvent.click(screen.getByRole('button', { name: '筛选' }));

    expect(routerMock.push).toHaveBeenCalledWith('/products');
  });
});

describe('商品列表：全选本页', () => {
  it('点一次全选 → 本页所有行选中；再点一次 → 全部取消', async () => {
    renderList();

    const header = screen.getByLabelText('全选本页');
    expect(header).not.toBeChecked();

    await userEvent.click(header);
    expect(screen.getByLabelText('选择 咖啡豆')).toBeChecked();
    expect(screen.getByLabelText('选择 滤纸')).toBeChecked();
    expect(screen.getByLabelText('全选本页')).toBeChecked();
    expect(screen.getByText('已选 2 个')).toBeInTheDocument();

    await userEvent.click(header);
    expect(screen.getByLabelText('选择 咖啡豆')).not.toBeChecked();
    expect(screen.getByLabelText('选择 滤纸')).not.toBeChecked();
    expect(screen.getByText('已选 0 个')).toBeInTheDocument();
  });

  it('全选后直接批量下架 → ids 是本页全部商品', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    renderList();
    await userEvent.click(screen.getByLabelText('全选本页'));
    await userEvent.click(screen.getByRole('button', { name: '批量下架' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({ ids: ['p1', 'p2'], action: 'UNPUBLISH' });
  });
});

describe('商品列表：分页', () => {
  it('点「下一页」→ router.push 带 page=2', async () => {
    renderList();

    await userEvent.click(screen.getByRole('button', { name: '下一页' }));

    expect(routerMock.push).toHaveBeenCalledWith('/products?page=2');
  });

  it('第 1 页时「上一页」禁用', async () => {
    renderList();

    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '下一页' })).toBeEnabled();
  });
});
