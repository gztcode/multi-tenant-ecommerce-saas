// @vitest-environment jsdom
/**
 * CSV 账单上传表单的关键行为（阶段 5m）。
 *
 * ⚠️ **第一行必须写 `// @vitest-environment jsdom`**：
 * platform-admin 的 vitest 配置全局是 `node`（Route Handler 用 Web 标准的
 * Request / Response，不需要 DOM）。逐文件的环境注释**优先于全局配置**。
 *
 * ⚠️ **这些护栏只能在 jsdom 里测** —— 「少填一栏会不会放行」、
 *    「结果面板会不会把警告藏起来」都是「点下去会发生什么」，
 *    页面级测试（只锁服务端渲染出来的文字）测不到。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ImportCsvForm } from '@/app/(dashboard)/reconciliations/import/import-csv-form';

const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  fetchMock = vi.fn(async () =>
    jsonResponse({
      id: 'rec-1',
      diffCount: 2,
      matchedCount: 5,
      skippedRowCount: 0,
      skippedRows: [],
      skippedRowsTruncated: false,
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
});

/** 选一个账单文件 */
async function pickFile(user: ReturnType<typeof userEvent.setup>) {
  await user.upload(
    screen.getByLabelText('账单文件（CSV）'),
    new File(['交易号,金额,状态\nA,100,成功\n'], 'bill.csv', {
      type: 'text/csv',
    }),
  );
}

/** 填一份合法的列映射（不含文件） */
async function fillMapping(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('渠道交易号列'), '交易号');
  await user.type(screen.getByLabelText('金额列'), '金额');
  await user.click(screen.getByLabelText('分'));
  await user.type(screen.getByLabelText('状态列'), '状态');
  await user.type(screen.getByLabelText('渠道状态词'), '成功');
  await user.click(screen.getByLabelText('渠道已打款成功'));
}

/** 读出请求里的 FormData */
function formDataOf(index = 0): FormData {
  const [, options] = fetchMock.mock.calls[index] as [string, RequestInit];
  return options.body as FormData;
}

describe('CSV 账单上传：必填校验', () => {
  it('⚠️ 不选文件 → 不发请求，并提示选文件', async () => {
    const user = userEvent.setup();
    render(<ImportCsvForm />);

    await user.click(screen.getByRole('button', { name: '导入并对账' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('请选择账单文件');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('⚠️ 没填「状态」列 → 提示里要说清「会把处理中的单自动改成已付款」', async () => {
    const user = userEvent.setup();
    render(<ImportCsvForm />);

    await pickFile(user);
    await user.type(screen.getByLabelText('渠道交易号列'), '交易号');
    await user.type(screen.getByLabelText('金额列'), '金额');
    await user.click(screen.getByLabelText('分'));
    await user.click(screen.getByRole('button', { name: '导入并对账' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('必须指定「状态」列');
    // ⚠️ **后果必须写在提示里** —— 这是「误改钱状态」的口子，
    //    只说「必填」运营不知道自己漏配的后果。
    expect(alert.textContent).toContain('自动改成已付款');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('⚠️ 没选金额单位 → 不发请求（单位猜错就是金额差 100 倍）', async () => {
    const user = userEvent.setup();
    render(<ImportCsvForm />);

    await pickFile(user);
    await user.type(screen.getByLabelText('渠道交易号列'), '交易号');
    await user.type(screen.getByLabelText('金额列'), '金额');
    await user.click(screen.getByRole('button', { name: '导入并对账' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('必须选择金额单位');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('⚠️ 没配状态值映射 → 不发请求（配了状态列却不配映射 = 导入但没对账）', async () => {
    const user = userEvent.setup();
    render(<ImportCsvForm />);

    await pickFile(user);
    await user.type(screen.getByLabelText('渠道交易号列'), '交易号');
    await user.type(screen.getByLabelText('金额列'), '金额');
    await user.click(screen.getByLabelText('分'));
    await user.type(screen.getByLabelText('状态列'), '状态');
    await user.click(screen.getByRole('button', { name: '导入并对账' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('必须指定「状态值映射」');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('CSV 账单上传：提交', () => {
  it('⚠️ 填全 → 发 multipart 到中转路由，列映射按后端的字段名拼', async () => {
    const user = userEvent.setup();
    render(<ImportCsvForm />);

    await pickFile(user);
    await fillMapping(user);
    await user.click(screen.getByRole('button', { name: '导入并对账' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/billing/reconciliations/import');
    expect(options.method).toBe('POST');
    // ⚠️ **不能设 content-type** —— multipart 的 boundary 要让浏览器自己带
    const headers = options.headers as Record<string, string> | undefined;
    expect(headers?.['content-type']).toBeUndefined();

    const body = formDataOf();
    expect(body.get('file')).toBeInstanceOf(File);
    const mapping = JSON.parse(String(body.get('columnMapping'))) as Record<
      string,
      unknown
    >;
    expect(mapping).toMatchObject({
      txnIdColumn: '交易号',
      amountColumn: '金额',
      amountUnit: 'CENT',
      statusColumn: '状态',
      statusMapping: { 成功: 'SUCCESS' },
    });
    // ⚠️ **没填的选填列不能出现**（后端按 `undefined` 处理）
    expect(mapping.referenceNoColumn).toBeUndefined();
    expect(mapping.paidAtColumn).toBeUndefined();

    await waitFor(() => {
      expect(refreshMock).toHaveBeenCalledTimes(1);
    });
  });

  it('⚠️ 后端报错 → 显示后端给的中文提示，不刷新', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      jsonResponse({ message: '必须指定「状态值映射」' }, 400),
    );
    render(<ImportCsvForm />);

    await pickFile(user);
    await fillMapping(user);
    await user.click(screen.getByRole('button', { name: '导入并对账' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('必须指定「状态值映射」');
    expect(refreshMock).not.toHaveBeenCalled();
  });
});

describe('CSV 账单上传：结果展示', () => {
  it('⚠️ 后端给了 warning → 必须显眼地显示出来', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: 'rec-1',
        diffCount: 0,
        matchedCount: 5,
        warning: '账单里没有解析出任何「打款时间」：D 类差异检不出来。',
        skippedRowCount: 0,
        skippedRows: [],
        skippedRowsTruncated: false,
      }),
    );
    render(<ImportCsvForm />);

    await pickFile(user);
    await fillMapping(user);
    await user.click(screen.getByRole('button', { name: '导入并对账' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('D 类差异检不出来');
  });

  it('⚠️ 有被跳过的行 → 显示行号与原因，截断时说明只列了前 N 条', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: 'rec-1',
        diffCount: 1,
        matchedCount: 4,
        skippedRowCount: 120,
        skippedRows: [
          { rowNumber: 7, reason: '「交易号」列为空，无法参与匹配' },
        ],
        skippedRowsTruncated: true,
      }),
    );
    render(<ImportCsvForm />);

    await pickFile(user);
    await fillMapping(user);
    await user.click(screen.getByRole('button', { name: '导入并对账' }));

    await screen.findByText(/已生成一条「账单文件」来源的对账任务/);
    // ⚠️ **跳过的行必须报出来** —— 对账结论只基于剩下的行
    expect(screen.getByText(/有 120 行没能参与对账/)).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
    expect(
      screen.getByText('「交易号」列为空，无法参与匹配'),
    ).toBeTruthy();
    // ⚠️ **截断必须说清楚** —— 否则运营以为「就这么多行有问题」
    expect(screen.getByText(/只列出了前 1 条/)).toBeTruthy();
  });
});
