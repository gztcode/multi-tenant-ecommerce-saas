'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { CsvColumnMapping, CsvImportResult } from '@/lib/reconciliation';

/**
 * CSV 渠道账单的上传表单（阶段 5m）。
 *
 * ⚠️ **真渠道没有批量查单接口** —— CSV 账单是唯一的对账途径，
 *    没有这个表单 = 这个能力对运营不存在。
 *
 * ⚠️ **所有写操作都走同源的 `/api/**` 中转**（不是直连后端）：
 *    后端没开 CORS，而且 accessToken 不该进客户端代码。
 */

/** 统一的失败文案前缀 */
const FAILURE_TEXT = '导入失败';

/**
 * 文件大小上限（与后端 `FileInterceptor` 的 `limits` 一致）。
 */
const MAX_FILE_SIZE = 5 * 1024 * 1024;

/**
 * 渠道状态词可以映射到的内部状态。
 *
 * ⚠️ **只有 `SUCCESS` 与 `FAILED` 会被比对引擎特殊对待** ——
 *    `SUCCESS` 才会触发「本地处理中的单自动改成已付款」，
 *    `FAILED` 才会触发「渠道说没打成功、本地却记着已付款」，
 *    其余一律按「非终态 → 不算差异」处理（`UNKNOWN` 是后端自己用的兜底值）。
 */
type StatusTarget = 'SUCCESS' | 'FAILED' | 'UNKNOWN';

/** 映射目标的可选值（空串 = 还没选） */
type StatusTargetChoice = '' | StatusTarget;

/** 映射目标的中文说明 */
const STATUS_TARGETS: { value: StatusTarget; label: string }[] = [
  { value: 'SUCCESS', label: '渠道已打款成功' },
  { value: 'FAILED', label: '渠道打款失败' },
  { value: 'UNKNOWN', label: '其它（非终态，不算差异）' },
];

/** 状态映射的一行 */
interface StatusRow {
  /** 稳定的行标识（删行时不串位） */
  key: number;
  /** 渠道账单里的状态词（原文，如「成功」「已付款」） */
  word: string;
  /** 映射到的内部状态 */
  target: StatusTargetChoice;
}

/** 校验结果 */
type MappingResult =
  | { ok: true; mapping: CsvColumnMapping }
  | { ok: false; problem: string };

export function ImportCsvForm() {
  const router = useRouter();
  const busyRef = useRef(false);
  const nextKeyRef = useRef(1);

  const [file, setFile] = useState<File | null>(null);
  const [channel, setChannel] = useState('');
  const [txnIdColumn, setTxnIdColumn] = useState('');
  const [referenceNoColumn, setReferenceNoColumn] = useState('');
  const [amountColumn, setAmountColumn] = useState('');
  const [amountUnit, setAmountUnit] = useState<'' | 'CENT' | 'YUAN'>('');
  const [statusColumn, setStatusColumn] = useState('');
  const [statusRows, setStatusRows] = useState<StatusRow[]>([
    { key: 0, word: '', target: '' },
  ]);
  const [paidAtColumn, setPaidAtColumn] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [result, setResult] = useState<CsvImportResult | null>(null);

  function updateRow(key: number, patch: Partial<StatusRow>) {
    setStatusRows((rows) =>
      rows.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    );
  }

  function removeRow(key: number) {
    setStatusRows((rows) => rows.filter((row) => row.key !== key));
  }

  function addRow() {
    const key = nextKeyRef.current;
    nextKeyRef.current += 1;
    setStatusRows((rows) => [...rows, { key, word: '', target: '' }]);
  }

  /**
   * 校验并拼出列映射。
   *
   * ⚠️ **校验口径必须与后端 `assertColumnMapping` 一致** ——
   *    前端少拦一道，运营要白等一次往返才知道自己填错了哪一栏。
   */
  function buildMapping(): MappingResult {
    if (!txnIdColumn.trim()) {
      return { ok: false, problem: '必须指定「渠道交易号」列' };
    }
    if (!amountColumn.trim()) {
      return { ok: false, problem: '必须指定「金额」列' };
    }
    // ⚠️ **金额单位不预选** —— 猜错就是金额差 100 倍，
    //    宁可让运营明确选一次，也不要拿默认值替他做这个假设。
    if (!amountUnit) {
      return { ok: false, problem: '必须选择金额单位（分 或 元）' };
    }
    if (!statusColumn.trim()) {
      return {
        ok: false,
        problem:
          '必须指定「状态」列：不配这一列就无从判断渠道是否真的打了款 —— ' +
          '所有渠道流水都会被当成「渠道已打款成功」，' +
          '本地还卡在处理中的出款单会被自动改成已付款。',
      };
    }
    const statusMapping: Record<string, string> = {};
    for (const row of statusRows) {
      const word = row.word.trim();
      if (!word) continue;
      if (!row.target) {
        return {
          ok: false,
          problem: `请为状态词「${word}」选择映射到的内部状态`,
        };
      }
      if (statusMapping[word]) {
        return { ok: false, problem: `状态词「${word}」重复了` };
      }
      statusMapping[word] = row.target;
    }
    if (Object.keys(statusMapping).length === 0) {
      return {
        ok: false,
        problem:
          '必须指定「状态值映射」：配了状态列却不配映射，' +
          '渠道的状态词不会被引擎认成成功或失败 → ' +
          'A/B/C/F 四类差异全部检不出来，而差异数仍是 0。',
      };
    }
    return {
      ok: true,
      mapping: {
        txnIdColumn: txnIdColumn.trim(),
        referenceNoColumn: referenceNoColumn.trim() || undefined,
        amountColumn: amountColumn.trim(),
        amountUnit,
        statusColumn: statusColumn.trim(),
        statusMapping,
        paidAtColumn: paidAtColumn.trim() || undefined,
      },
    };
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // ⚠️ **闸门读 ref 不是 state**（与既有写操作同款）：
    //    state 同一 tick 内还是旧值，连点两次会一起通过检查发出两次请求。
    if (busyRef.current) return;

    if (!file) {
      setFailure('请选择账单文件');
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setFailure('账单文件不能超过 5MB');
      return;
    }
    const built = buildMapping();
    if (!built.ok) {
      setFailure(built.problem);
      return;
    }
    // ⚠️ **时间窗的口径与后端一致** —— `<input type="date">` 交出来的是
    //    `YYYY-MM-DD`，后端按 UTC 零点解析，这里用同样的解析方式比。
    if (from && to && new Date(from).getTime() >= new Date(to).getTime()) {
      setFailure('时间窗的终点必须晚于起点');
      return;
    }

    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    setResult(null);

    const formData = new FormData();
    formData.set('file', file);
    formData.set('columnMapping', JSON.stringify(built.mapping));
    if (channel.trim()) formData.set('channel', channel.trim());
    if (from) formData.set('from', from);
    if (to) formData.set('to', to);

    try {
      const response = await fetch('/api/billing/reconciliations/import', {
        method: 'POST',
        // ⚠️ **不设 content-type** —— multipart 必须让浏览器自己带 boundary
        body: formData,
      });
      const payload = (await response.json().catch(() => ({}))) as Partial<
        CsvImportResult
      > & { message?: string };
      if (!response.ok) {
        setFailure(payload.message ?? FAILURE_TEXT);
        return;
      }
      setResult(payload as CsvImportResult);
      // ⚠️ **成功后刷新** —— 对账列表是服务端渲染的，不刷新看不到新任务
      router.refresh();
    } catch {
      setFailure(FAILURE_TEXT);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>账单文件</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col gap-1">
              <Label htmlFor="csv-file">账单文件（CSV）</Label>
              <Input
                id="csv-file"
                type="file"
                accept=".csv,text/csv"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
              <p className="text-xs text-muted-foreground">
                上限 5MB、最多 10000 行。原始文件不落盘，只保存解析出的流水与列映射。
              </p>
            </div>

            <div className="flex flex-col gap-1">
              <Label htmlFor="csv-channel">渠道名（选填）</Label>
              <Input
                id="csv-channel"
                value={channel}
                onChange={(event) => setChannel(event.target.value)}
                placeholder="fake-payout"
              />
              <p className="text-xs text-muted-foreground">
                不填默认 fake-payout。这个名字只记在这次对账任务上，
                用来分辨是哪个渠道的账单。
              </p>
            </div>

            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="csv-from">时间窗起点（含）</Label>
                <Input
                  id="csv-from"
                  type="date"
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="csv-to">时间窗终点（不含）</Label>
                <Input
                  id="csv-to"
                  type="date"
                  value={to}
                  onChange={(event) => setTo(event.target.value)}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              不填 = 最近 24 小时。按 UTC 自然日计算，终点当天不计入；
              跨度不能超过 31 天。
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>列映射</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="csv-txn-id">渠道交易号列</Label>
                <Input
                  id="csv-txn-id"
                  value={txnIdColumn}
                  onChange={(event) => setTxnIdColumn(event.target.value)}
                  placeholder="如：交易号"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="csv-reference-no">业务单号列（选填）</Label>
                <Input
                  id="csv-reference-no"
                  value={referenceNoColumn}
                  onChange={(event) => setReferenceNoColumn(event.target.value)}
                  placeholder="如：商户单号"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="csv-amount">金额列</Label>
                <Input
                  id="csv-amount"
                  value={amountColumn}
                  onChange={(event) => setAmountColumn(event.target.value)}
                  placeholder="如：金额"
                />
              </div>
              <fieldset className="space-y-1">
                <legend className="text-sm font-medium">金额单位</legend>
                <div className="flex items-center gap-3">
                  <Label htmlFor="csv-unit-cent" className="font-normal">
                    <input
                      type="radio"
                      id="csv-unit-cent"
                      name="csv-amount-unit"
                      checked={amountUnit === 'CENT'}
                      onChange={() => setAmountUnit('CENT')}
                    />
                    分
                  </Label>
                  <Label htmlFor="csv-unit-yuan" className="font-normal">
                    <input
                      type="radio"
                      id="csv-unit-yuan"
                      name="csv-amount-unit"
                      checked={amountUnit === 'YUAN'}
                      onChange={() => setAmountUnit('YUAN')}
                    />
                    元
                  </Label>
                </div>
              </fieldset>
            </div>
            <p className="text-xs text-muted-foreground">
              ⚠️ 金额单位猜错就是金额差 100 倍 —— 账单写「100.00」是 100 元，
              不是 100 分。请照渠道账单上的口径选。
            </p>

            <div className="flex flex-col gap-1">
              <Label htmlFor="csv-status">状态列</Label>
              <Input
                id="csv-status"
                value={statusColumn}
                onChange={(event) => setStatusColumn(event.target.value)}
                placeholder="如：状态"
              />
              <p className="text-xs text-muted-foreground">
                ⚠️ 必填。不配这一列就无从判断渠道是否真的打了款 ——
                所有渠道流水都会被当成「渠道已打款成功」，
                本地还卡在处理中的出款单会被自动改成已付款。
              </p>
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium">状态值映射</p>
              {statusRows.map((row) => (
                <div key={row.key} className="flex flex-wrap items-end gap-3">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor={`csv-status-word-${row.key}`}>
                      渠道状态词
                    </Label>
                    <Input
                      id={`csv-status-word-${row.key}`}
                      value={row.word}
                      onChange={(event) =>
                        updateRow(row.key, { word: event.target.value })
                      }
                      placeholder="如：成功"
                      className="w-40"
                    />
                  </div>
                  <fieldset className="space-y-1">
                    <legend className="text-sm font-medium">映射到</legend>
                    <div className="flex items-center gap-3">
                      {STATUS_TARGETS.map((target) => (
                        <Label
                          key={target.value}
                          htmlFor={`csv-status-target-${row.key}-${target.value}`}
                          className="font-normal"
                        >
                          <input
                            type="radio"
                            id={`csv-status-target-${row.key}-${target.value}`}
                            name={`csv-status-target-${row.key}`}
                            checked={row.target === target.value}
                            onChange={() =>
                              updateRow(row.key, { target: target.value })
                            }
                          />
                          {target.label}
                        </Label>
                      ))}
                    </div>
                  </fieldset>
                  {statusRows.length > 1 ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => removeRow(row.key)}
                    >
                      删除
                    </Button>
                  ) : null}
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" onClick={addRow}>
                添加一行
              </Button>
              <p className="text-xs text-muted-foreground">
                ⚠️ 只有「渠道已打款成功」会触发「本地处理中的单自动改成已付款」；
                「渠道打款失败」用于检出「渠道说没打成功、本地却记着已付款」。
                没有列出的状态词一律按「非终态」处理（不算差异，
                也不会改出款单的状态）。
              </p>
            </div>

            <div className="flex flex-col gap-1">
              <Label htmlFor="csv-paid-at">打款时间列（选填）</Label>
              <Input
                id="csv-paid-at"
                value={paidAtColumn}
                onChange={(event) => setPaidAtColumn(event.target.value)}
                placeholder="如：打款时间"
              />
              <p className="text-xs text-muted-foreground">
                ⚠️ 不填的后果：渠道「打了钱、本地没记录」这类差异检不出来，
                而差异数仍是 0 —— 运营会当成「一切正常」。
                真实渠道的账单未必有时间列，所以不强填。
              </p>
            </div>
          </CardContent>
        </Card>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={busy}>
            {busy ? '导入中…' : '导入并对账'}
          </Button>
          {busy ? (
            <p className="text-sm text-muted-foreground">
              正在解析账单并对账，最长约 30 秒。
            </p>
          ) : null}
        </div>

        {failure ? (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        ) : null}
      </form>

      {result ? <ImportResult result={result} /> : null}
    </div>
  );
}

/**
 * 导入结果（阶段 5m）。
 *
 * ⚠️ **三样东西必须都显示** ——
 *    「没解析出打款时刻」的警告（否则运营把差异数 0 当成「一切正常」）、
 *    被跳过的行数与明细（否则对账结论只基于剩下的行这件事被藏起来了）、
 *    以及「明细被截断」的标记（否则运营以为就这么多行有问题）。
 */
function ImportResult({ result }: { result: CsvImportResult }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>导入结果</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p>
          已生成一条「账单文件」来源的对账任务：差异 {result.diffCount} 条、
          一致 {result.matchedCount} 条。
        </p>
        <p>
          <Link
            href={`/reconciliations/${result.id}`}
            className="underline-offset-4 hover:underline"
          >
            查看这次对账的差异明细
          </Link>
        </p>

        {result.warning ? (
          <p role="alert" className="text-destructive">
            ⚠️ {result.warning}
          </p>
        ) : null}

        {result.skippedRowCount > 0 ? (
          <div className="space-y-2">
            <p className="text-destructive">
              ⚠️ 有 {result.skippedRowCount} 行没能参与对账 ——
              这次的结论只基于剩下的行。
            </p>
            <div className="max-h-96 overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>行号</TableHead>
                    <TableHead>原因</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.skippedRows.map((row) => (
                    <TableRow key={row.rowNumber}>
                      <TableCell>{row.rowNumber}</TableCell>
                      <TableCell className="text-xs">{row.reason}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {result.skippedRowsTruncated ? (
              <p className="text-xs text-muted-foreground">
                只列出了前 {result.skippedRows.length} 条，
                其余的行没列出来 —— 请回原账单核对。
              </p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
