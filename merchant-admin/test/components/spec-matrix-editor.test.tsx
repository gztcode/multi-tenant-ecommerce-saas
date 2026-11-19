// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProductSpec } from '@/components/product/types';

/**
 * useRouter 的 mock：refresh 用 vi.hoisted 提升，让各用例能精确断言
 * 「保存成功后刷新页面」这一行为。路径必须与被测组件的 import 完全一致。
 */
const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshMock }) }));

import { SpecMatrixEditor } from '@/components/product/spec-matrix-editor';

/** 造一个满足组件 Response 用法的最小响应对象 */
function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status });
}

/**
 * 必须给 mock 实现显式声明 fetch 签名：否则 vi.fn 推断成 `() => Promise<Response>`，
 * mock.calls 被推断为空元组 `[]`，断言 `calls[0]` / `calls[0][1]` 时 tsc 直接报越界。
 */
type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** 颜色（黑/白）× 尺码（M/L）的两维矩阵，笛卡尔积 4 个组合 */
const SPECS: ProductSpec[] = [
  {
    id: 'spec-color',
    name: '颜色',
    values: [
      { id: 'v-black', value: '黑色' },
      { id: 'v-white', value: '白色' },
    ],
  },
  {
    id: 'spec-size',
    name: '尺码',
    values: [
      { id: 'v-m', value: 'M' },
      { id: 'v-l', value: 'L' },
    ],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  refreshMock.mockClear();
});

afterEach(() => vi.unstubAllGlobals());

describe('规格矩阵编辑器（spec-matrix-editor）', () => {
  it('保存成功：PUT 到 specs 路由，URL、method、headers、body 全部精确断言，并刷新页面', async () => {
    const fetchMock = vi.fn<FetchImpl>(() =>
      Promise.resolve(jsonResponse({ version: 4 })),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<SpecMatrixEditor productId="p-1" version={3} specs={SPECS} />);
    await userEvent.click(screen.getByRole('button', { name: '保存规格' }));

    await waitFor(() => expect(screen.getByText('规格已保存')).toBeTruthy());

    // 精确断言：URL、method、headers、body（JSON 解析后 toEqual）
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/products/p-1/specs');
    expect(init?.method).toBe('PUT');
    expect(init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(String(init?.body))).toEqual({
      version: 3,
      specs: [
        { name: '颜色', values: [{ value: '黑色' }, { value: '白色' }], sort: 0 },
        { name: '尺码', values: [{ value: 'M' }, { value: 'L' }], sort: 1 },
      ],
    });
    // 保存成功后刷新页面，让规格/SKU 列表与最低价跟上
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('保存成功后自持响应里的 version，第二次保存提交新版本号', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ version: 4 }))
      .mockResolvedValueOnce(jsonResponse({ version: 5 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<SpecMatrixEditor productId="p-1" version={3} specs={SPECS} />);

    await userEvent.click(screen.getByRole('button', { name: '保存规格' }));
    await waitFor(() => expect(screen.getByText('规格已保存')).toBeTruthy());

    await userEvent.click(screen.getByRole('button', { name: '保存规格' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const secondBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    // 后端每次替换都 +1，若不覆盖新值，第二次提交旧版本必然 409
    expect(secondBody.version).toBe(4);
  });

  it('409 乐观锁冲突：只提示刷新重试，绝不静默重试（fetch 只调一次）', async () => {
    const fetchMock = vi.fn<FetchImpl>(() =>
      Promise.resolve(jsonResponse({ message: 'version conflict' }, 409)),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<SpecMatrixEditor productId="p-1" version={3} specs={SPECS} />);
    await userEvent.click(screen.getByRole('button', { name: '保存规格' }));

    await waitFor(() =>
      expect(screen.getByText('商品已被他人修改，请刷新页面后重试')).toBeTruthy(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 409 不是成功，不刷新页面
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('其他非 2xx 失败：显示服务端返回的 message', async () => {
    const fetchMock = vi.fn<FetchImpl>(() =>
      Promise.resolve(jsonResponse({ message: '规格值超过 20 个上限' }, 400)),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<SpecMatrixEditor productId="p-1" version={3} specs={SPECS} />);
    await userEvent.click(screen.getByRole('button', { name: '保存规格' }));

    await waitFor(() => expect(screen.getByText('规格值超过 20 个上限')).toBeTruthy());
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('空矩阵保存：不发请求，提示至少一个完整维度', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(<SpecMatrixEditor productId="p-1" version={1} specs={[]} />);
    await userEvent.click(screen.getByRole('button', { name: '保存规格' }));

    await waitFor(() =>
      expect(
        screen.getByText('至少需要一个填写完整的规格维度（名称 + 至少一个取值）'),
      ).toBeTruthy(),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('重名维度：提交前拦截，不发请求并明确提示', async () => {
    const fetchMock = vi.fn<FetchImpl>(() =>
      Promise.resolve(jsonResponse({ version: 4 })),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<SpecMatrixEditor productId="p-1" version={3} specs={SPECS} />);

    // 把两个维度名都改成「颜色」
    const nameInputs = screen.getAllByPlaceholderText('维度名称，例如「颜色」');
    await userEvent.clear(nameInputs[0]);
    await userEvent.type(nameInputs[0], '颜色');
    await userEvent.clear(nameInputs[1]);
    await userEvent.type(nameInputs[1], '颜色');

    await userEvent.click(screen.getByRole('button', { name: '保存规格' }));

    await waitFor(() =>
      expect(screen.getByText('规格维度名称不能重复：颜色')).toBeTruthy(),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('trim + 去重：重复取值与首尾空格在提交前合并，预览组合数同步减少', async () => {
    const fetchMock = vi.fn<FetchImpl>(() =>
      Promise.resolve(jsonResponse({ version: 4 })),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<SpecMatrixEditor productId="p-1" version={3} specs={SPECS} />);

    // 把「白色」改成「黑色 」（带尾随空格）→ 颜色维度去重后只剩「黑色」
    const valueInputs = screen.getAllByPlaceholderText('取值，例如「黑色」');
    await userEvent.clear(valueInputs[1]);
    await userEvent.type(valueInputs[1], '黑色 ');

    // 预览组合数：1（颜色去重后）× 2（尺码）= 2（文本被拆到多个节点，用 textContent 匹配）
    expect(
      screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === '笛卡尔积预览：2 个 SKU 组合'),
    ).toBeTruthy();
    // 重复取值提示出现
    expect(screen.getByText(/重复取值（保存时会自动合并）/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: '保存规格' }));

    await waitFor(() => expect(screen.getByText('规格已保存')).toBeTruthy());
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    // 去重后只有一个取值，且已 trim；不带 id
    expect(body.specs[0]).toEqual({
      name: '颜色',
      values: [{ value: '黑色' }],
      sort: 0,
    });
  });

  it('维度增删与上限：空矩阵可添加两个维度，达上限后按钮禁用，删除后可再加', async () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<SpecMatrixEditor productId="p-1" version={1} specs={[]} />);

    // 空矩阵提示
    expect(
      screen.getByText('这个商品还没有规格。添加一个维度并录入取值，保存后就会自动生成 SKU。'),
    ).toBeTruthy();

    const addSpec = screen.getByRole('button', { name: '添加规格维度' });
    await userEvent.click(addSpec);
    expect(screen.getAllByPlaceholderText('维度名称，例如「颜色」')).toHaveLength(1);

    await userEvent.click(addSpec);
    expect(screen.getAllByPlaceholderText('维度名称，例如「颜色」')).toHaveLength(2);

    // 达上限（2）后按钮禁用
    expect(addSpec).toBeDisabled();

    // 删除一个维度后按钮恢复可用
    await userEvent.click(screen.getAllByRole('button', { name: '删除维度' })[0]);
    expect(screen.getAllByPlaceholderText('维度名称，例如「颜色」')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '添加规格维度' })).toBeEnabled();
  });

  it('取值增删：添加出现新输入框，删除后消失', async () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<SpecMatrixEditor productId="p-1" version={1} specs={SPECS} />);

    // 初始 4 个取值输入框（颜色 2 + 尺码 2）
    expect(screen.getAllByPlaceholderText('取值，例如「黑色」')).toHaveLength(4);

    // 给第一个维度（颜色）添加一个取值
    await userEvent.click(screen.getAllByRole('button', { name: '添加取值' })[0]);
    expect(screen.getAllByPlaceholderText('取值，例如「黑色」')).toHaveLength(5);

    // 删掉刚加的这个（最后一个），恢复 4 个
    const deleteButtons = screen.getAllByRole('button', { name: '删除' });
    await userEvent.click(deleteButtons[deleteButtons.length - 1]);
    expect(screen.getAllByPlaceholderText('取值，例如「黑色」')).toHaveLength(4);
  });

  it('取值达上限（20）后添加按钮禁用，删一个恢复可用', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const twentyValues = Array.from({ length: 20 }, (_, i) => ({
      id: `v-${i}`,
      value: `取值${i + 1}`,
    }));
    const singleSpec: ProductSpec[] = [
      { id: 'spec-a', name: '颜色', values: twentyValues },
    ];
    render(<SpecMatrixEditor productId="p-1" version={1} specs={singleSpec} />);

    const addValue = screen.getByRole('button', { name: '添加取值' });
    expect(addValue).toBeDisabled();
    expect(addValue).toHaveAttribute('title', '每个规格维度最多 20 个取值');

    // 删一个取值（第 20 个）→ 恢复可用
    const deleteButtons = screen.getAllByRole('button', { name: '删除' });
    await userEvent.click(deleteButtons[deleteButtons.length - 1]);
    expect(screen.getByRole('button', { name: '添加取值' })).toBeEnabled();
  });

  it('删取值导致组合变少：预览提示将被停用的 SKU 数量', async () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<SpecMatrixEditor productId="p-1" version={3} specs={SPECS} />);

    // 删掉颜色维的「白色」：原 4 组合 − 新 2 组合 = 2 个 SKU 会被停用
    const deleteButtons = screen.getAllByRole('button', { name: '删除' });
    await userEvent.click(deleteButtons[1]);

    expect(
      screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === '笛卡尔积预览：2 个 SKU 组合'),
    ).toBeTruthy();
    expect(
      screen.getByText((_, el) =>
        el?.tagName === 'P' && el.textContent?.includes('保存后有 2 个多余的 SKU 会被停用'),
      ),
    ).toBeTruthy();
  });
});
