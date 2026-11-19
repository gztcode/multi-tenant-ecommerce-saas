// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// next/navigation 的 useRouter 用 vi.hoisted 造 mock fn，方便断言 refresh 被调用。
// mockPush 只在 mock 工厂里被引用（组件不用 push），不算未使用。
const { mockPush, mockRefresh } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockRefresh: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, refresh: mockRefresh }),
}));

import { CategoryManager } from '@/components/product/category-manager';

/** 一级品类 A + 子品类 A1 + 二级品类 B */
const TREE = [
  {
    id: 'a',
    name: 'A',
    slug: 'a',
    parentId: null,
    sort: 0,
    children: [
      {
        id: 'a1',
        name: 'A1',
        slug: 'a1',
        parentId: 'a',
        sort: 0,
        children: [],
      },
    ],
  },
  {
    id: 'b',
    name: 'B',
    slug: 'b',
    parentId: null,
    sort: 1,
    children: [],
  },
];

/** 某文本所在节点行的操作按钮容器（该行的「删除 / 改名 / 加子品类」） */
function rowOf(text: string) {
  const span = screen.getByText(text);
  const rowDiv = span.closest('div');
  if (!rowDiv) throw new Error(`找不到「${text}」所在行`);
  return within(rowDiv);
}

/** 解析 fetch 最后一次调用的 URL / method / body */
function lastCall() {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error('fetch 尚未被调用');
  const [url, init] = call as [string, RequestInit];
  return {
    url,
    method: init.method,
    body: init.body
      ? (JSON.parse(init.body as string) as Record<string, unknown>)
      : undefined,
  };
}

function okResponse() {
  return new Response('{}', { status: 200 });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('品类管理 CategoryManager', () => {
  it('空树显示「还没有品类」提示', () => {
    render(<CategoryManager initial={[]} />);
    expect(screen.getByText('还没有品类，先新增一个一级品类。')).toBeTruthy();
  });

  it('新增一级品类：POST /api/categories，body 只有 name 与 slug（无 parentId），成功后 refresh', async () => {
    fetchMock.mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    render(<CategoryManager initial={TREE} />);
    await userEvent.click(screen.getByRole('button', { name: '新增一级品类' }));
    await userEvent.type(screen.getByLabelText('品类名'), 'A 新');
    await userEvent.type(screen.getByLabelText('slug'), 'a-new');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(lastCall()).toEqual({
      url: '/api/categories',
      method: 'POST',
      body: { name: 'A 新', slug: 'a-new' },
    });
    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
  });

  it('新增子品类：点「加子品类」后保存，body 带 parentId', async () => {
    fetchMock.mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    render(<CategoryManager initial={TREE} />);
    await userEvent.click(rowOf('A').getByRole('button', { name: '加子品类' }));
    await userEvent.type(screen.getByLabelText('品类名'), 'A 子');
    await userEvent.type(screen.getByLabelText('slug'), 'a-child');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(lastCall()).toEqual({
      url: '/api/categories',
      method: 'POST',
      body: { name: 'A 子', slug: 'a-child', parentId: 'a' },
    });
  });

  it('改名：PATCH /api/categories/:id，body { name }，成功后 refresh', async () => {
    fetchMock.mockResolvedValue(okResponse());
    vi.stubGlobal('fetch', fetchMock);

    render(<CategoryManager initial={TREE} />);
    await userEvent.click(rowOf('A').getByRole('button', { name: '改名' }));
    const input = screen.getByLabelText('改名 A');
    await userEvent.clear(input);
    await userEvent.type(input, 'A 改名');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(lastCall()).toEqual({
      url: '/api/categories/a',
      method: 'PATCH',
      body: { name: 'A 改名' },
    });
    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
  });

  it('删除：confirm 确认后 DELETE /api/categories/:id，成功后 refresh', async () => {
    const confirmMock = vi.fn().mockReturnValue(true);
    vi.stubGlobal('confirm', confirmMock);
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<CategoryManager initial={TREE} />);
    await userEvent.click(rowOf('A').getByRole('button', { name: '删除' }));

    expect(confirmMock).toHaveBeenCalledWith(
      '确定删除「A」？有子品类或商品的品类删不掉。',
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(lastCall()).toEqual({
      url: '/api/categories/a',
      method: 'DELETE',
      body: undefined,
    });
    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
  });

  it('删除：confirm 取消则不发起请求', async () => {
    const confirmMock = vi.fn().mockReturnValue(false);
    vi.stubGlobal('confirm', confirmMock);
    vi.stubGlobal('fetch', fetchMock);

    render(<CategoryManager initial={TREE} />);
    await userEvent.click(rowOf('A').getByRole('button', { name: '删除' }));

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('后端失败显示后端返回的 message', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ message: '有子品类或商品的品类删不掉' }),
        { status: 400 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<CategoryManager initial={TREE} />);
    await userEvent.click(screen.getByRole('button', { name: '新增一级品类' }));
    await userEvent.type(screen.getByLabelText('品类名'), 'A 新');
    await userEvent.type(screen.getByLabelText('slug'), 'a-new');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe(
        '有子品类或商品的品类删不掉',
      );
    });
  });
});
