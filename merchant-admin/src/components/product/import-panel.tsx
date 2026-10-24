'use client';

import { useState } from 'react';

/**
 * CSV 导入面板。
 *
 * 整个组件是 'use client'，逻辑全在内部——导入页是 Server Component，
 * **不能**往下传函数（传事件处理器在 tsc 与 next build 下都能过，
 * 只有真正渲染这一页时才 500），所以父组件只渲染标题。
 */

interface ImportResult {
  /** CSV 里的物理行号（含表头，表头是第 1 行） */
  row: number;
  ok: boolean;
  name?: string;
  error?: string;
}

/**
 * 模板。
 *
 * 列名必须与导出文件的列名一致，中转按**列名**匹配而不是按位置，
 * 多余的列会被忽略（导出里的「状态」「最低价(分)」就是这么被跳过的）。
 *
 * ⚠️「描述性属性JSON」这一格含逗号，**必须**用双引号包起来、内部引号翻倍，
 * 否则解析器会按逗号切列，拿到 `{""材质""` 这种半截 JSON 而报
 * 「描述性属性不是合法 JSON」。这一行是照着能跑通的格式写的，不是示意。
 */
const TEMPLATE =
  '名称,slug,品类id,描述性属性JSON\n经典圆领T恤,classic-tee,,"{""材质"":""纯棉"",""产地"":""浙江""}"';

export function ImportPanel() {
  const [csv, setCsv] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ImportResult[] | null>(null);
  const [summary, setSummary] = useState<{ text: string; ok: boolean } | null>(null);

  async function readFile(file: File) {
    try {
      const text = await file.text();
      setCsv(text);
      setResults(null);
      setSummary(null);
    } catch {
      setSummary({ text: '文件读不出来，请确认是 UTF-8 编码的 CSV', ok: false });
    }
  }

  async function submit() {
    setBusy(true);
    setResults(null);
    setSummary(null);
    try {
      const response = await fetch('/api/products/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ csv }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        message?: string;
        total?: number;
        succeeded?: number;
        failed?: number;
        results?: ImportResult[];
      };
      if (!response.ok) {
        throw new Error(payload.message ?? '导入失败');
      }
      const failed = payload.failed ?? 0;
      setResults(payload.results ?? []);
      setSummary({
        text: `共 ${payload.total ?? 0} 行，成功 ${payload.succeeded ?? 0} 行，失败 ${failed} 行`,
        // 全成功时不必用红色吓人；只要有一行失败就点出来，商家得知道去看明细。
        ok: failed === 0,
      });
    } catch (cause) {
      setSummary({ text: cause instanceof Error ? cause.message : '导入失败', ok: false });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        <p>
          表头必须包含「名称」与「slug」两列；「品类id」「描述性属性JSON」是可选的。
          描述性属性那一格写 JSON 对象，值必须都是字符串。
        </p>
        <p>
          每一行独立处理：某一行失败（slug 重复、名称为空等）不会影响其他行，
          结果表会逐行列出行号与原因。新建的商品一律是「草稿」状态，
          状态与价格不在这里改。
        </p>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span>CSV 内容</span>
        <textarea
          value={csv}
          rows={10}
          onChange={(event) => setCsv(event.target.value)}
          placeholder={TEMPLATE}
          spellCheck={false}
          className="rounded-md border bg-background px-3 py-2 font-mono text-xs"
        />
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span>或选择文件</span>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void readFile(file);
            }}
            className="text-sm"
          />
        </label>

        <button
          type="button"
          onClick={submit}
          disabled={busy || csv.trim() === ''}
          className="mt-5 w-fit rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-40"
        >
          {busy ? '导入中…' : '开始导入'}
        </button>

        <button
          type="button"
          onClick={() => {
            setCsv(TEMPLATE);
            setResults(null);
            setSummary(null);
          }}
          className="mt-5 rounded-md border px-3 py-2 text-sm"
        >
          填入模板
        </button>
      </div>

      {summary && (
        <p className={summary.ok ? 'text-sm text-muted-foreground' : 'text-sm text-destructive'}>
          {summary.text}
        </p>
      )}

      {results !== null && results.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] border-collapse text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2 pr-2 font-medium">行号</th>
                <th className="py-2 pr-2 font-medium">商品</th>
                <th className="py-2 font-medium">结果</th>
              </tr>
            </thead>
            <tbody>
              {results.map((result) => (
                <tr key={result.row} className="border-b">
                  <td className="py-2 pr-2 tabular-nums text-muted-foreground">{result.row}</td>
                  <td className="py-2 pr-2">{result.name ?? '—'}</td>
                  <td className={result.ok ? 'py-2' : 'py-2 text-destructive'}>
                    {result.ok ? '成功' : (result.error ?? '失败')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}