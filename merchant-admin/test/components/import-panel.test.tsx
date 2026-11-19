// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ImportPanel } from '@/components/product/import-panel';

const TEMPLATE_TEXT =
  '名称,slug,品类id,描述性属性JSON\n经典圆领T恤,classic-tee,,"{""材质"":""纯棉"",""产地"":""浙江""}"';

/** 造一个带 `text()` 的文件（jsdom 的 File 不一定有 text()，显式挂上）。 */
function makeCsvFile(content: string) {
  return Object.assign(new File([content], 'a.csv', { type: 'text/csv' }), {
    text: vi.fn().mockResolvedValue(content),
  });
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('CSV 商品导入面板', () => {
  it('提交：POST /api/products/import，body 精确等于 { csv }', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ total: 1, succeeded: 1, failed: 0, results: [] })),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<ImportPanel />);
    await userEvent.type(screen.getByLabelText('CSV 内容'), '名称,slug\nA,a');
    await userEvent.click(screen.getByRole('button', { name: '开始导入' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/products/import');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ csv: '名称,slug\nA,a' });
  });

  it('CSV 为空时「开始导入」禁用，不发出请求', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(<ImportPanel />);
    const button = screen.getByRole('button', { name: '开始导入' });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('成功后显示汇总文案与逐行结果表', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          total: 2,
          succeeded: 1,
          failed: 1,
          results: [
            { row: 2, ok: true, name: 'A' },
            { row: 3, ok: false, name: 'B', error: 'slug 重复' },
          ],
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<ImportPanel />);
    await userEvent.type(screen.getByLabelText('CSV 内容'), '名称,slug\nA,a\nB,b');
    await userEvent.click(screen.getByRole('button', { name: '开始导入' }));

    await waitFor(() => {
      expect(screen.getByText('共 2 行，成功 1 行，失败 1 行')).toBeTruthy();
    });
    // 逐行结果：行号、商品名、结果文案
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('A')).toBeTruthy();
    expect(screen.getByText('成功')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('B')).toBeTruthy();
    expect(screen.getByText('slug 重复')).toBeTruthy();
  });

  it('有失败行时汇总用红色（ok=false 的样式类）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          total: 1,
          succeeded: 0,
          failed: 1,
          results: [{ row: 2, ok: false, name: 'B', error: '名称为空' }],
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<ImportPanel />);
    await userEvent.type(screen.getByLabelText('CSV 内容'), '名称,slug\n,B');
    await userEvent.click(screen.getByRole('button', { name: '开始导入' }));

    await waitFor(() => {
      expect(screen.getByText('共 1 行，成功 0 行，失败 1 行')).toBeTruthy();
    });
    const summary = screen.getByText('共 1 行，成功 0 行，失败 1 行');
    expect(summary.className).toContain('text-destructive');
  });

  it('全成功时汇总不用红色（ok=true）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          total: 1,
          succeeded: 1,
          failed: 0,
          results: [{ row: 2, ok: true, name: 'A' }],
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<ImportPanel />);
    await userEvent.type(screen.getByLabelText('CSV 内容'), '名称,slug\nA,a');
    await userEvent.click(screen.getByRole('button', { name: '开始导入' }));

    await waitFor(() => {
      expect(screen.getByText('共 1 行，成功 1 行，失败 0 行')).toBeTruthy();
    });
    const summary = screen.getByText('共 1 行，成功 1 行，失败 0 行');
    expect(summary.className).not.toContain('text-destructive');
  });

  it('后端失败显示后端 message', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: '文件解析失败：第 2 行缺列' }), { status: 400 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<ImportPanel />);
    await userEvent.type(screen.getByLabelText('CSV 内容'), '名称,slug\nA');
    await userEvent.click(screen.getByRole('button', { name: '开始导入' }));

    await waitFor(() => {
      expect(screen.getByText('文件解析失败：第 2 行缺列')).toBeTruthy();
    });
  });

  it('选择文件把内容读进 textarea', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(<ImportPanel />);
    const file = makeCsvFile('名称,slug\nA,a');
    await userEvent.upload(screen.getByLabelText('或选择文件'), file);

    const textarea = screen.getByLabelText('CSV 内容') as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe('名称,slug\nA,a'));
    expect(file.text).toHaveBeenCalledTimes(1);
  });

  it('填入模板把模板文本放进 textarea', async () => {
    render(<ImportPanel />);
    await userEvent.click(screen.getByRole('button', { name: '填入模板' }));

    const textarea = screen.getByLabelText('CSV 内容') as HTMLTextAreaElement;
    expect(textarea.value).toBe(TEMPLATE_TEXT);
  });
});
