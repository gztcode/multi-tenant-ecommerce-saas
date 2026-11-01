import { BadRequestException, ConflictException } from '@nestjs/common';
import Papa from 'papaparse';
import type { ChannelPayoutRecord } from '../../common/payment/payout-provider.interface';

/** 金额单位 */
export type CsvAmountUnit = 'CENT' | 'YUAN';

/**
 * CSV 的列映射（超管上传时指定）。
 *
 * ⚠️ **真渠道的 CSV 字段千差万别** → 不能用固定模板
 *    （要超管先整理成模板，等于把对账的价值打没）。
 */
export interface CsvColumnMapping {
  /** 渠道交易号列（**必填** —— 否则无法匹配） */
  txnIdColumn: string;
  /** 业务单号列（选填，`payoutNo` 匹配用） */
  referenceNoColumn?: string;
  /** 金额列（**必填**） */
  amountColumn: string;
  /**
   * ⚠️ **金额单位** —— 猜错就是金额差 100 倍。
   */
  amountUnit: CsvAmountUnit;
  /**
   * 状态列（**必填**）。
   *
   * ⚠️ **为什么改成必填** —— 不配状态列就**无从判断渠道是否真的打了款**。
   *    比对引擎只在渠道状态**恰好是 `'SUCCESS'`** 时才判 A 类
   *    （`payout-reconcile.engine.ts` 的 `authoritative.status === 'SUCCESS'` 分支）
   *    → A 类是**唯一会自动改钱状态**的差异（`PROCESSING → PAID`）。
   *    → 曾经的做法是「不配就当 SUCCESS」→ **所有渠道流水都被当成渠道已打款成功**
   *    → 本地还卡在 `PROCESSING` 的单全被判成 A 类 → **自动改成已付款**。
   *    → 那等于**系统替运营做了一个可能错的假设**，是最不能接受的一类默认。
   *    → 现在改成必填：配不了就别导，不给「误改钱状态」留口子。
   */
  statusColumn: string;
  /**
   * ⚠️ **状态值映射** —— 渠道的状态词五花八门（成功/已付/打款成功/0/1）。
   *    **与状态列同进同出** —— 配了状态列却不配映射 → 每个状态词原样落进
   *    `status` → 引擎只认 `'SUCCESS'` / `'FAILED'` 两个精确值 →
   *    全落进 g 档「渠道非终态 → 不算差异」→ **A/B/C/F 四类差异全部检不出来**，
   *    而响应里 `diffCount` 仍是 0 → 运营当成「一切正常」。
   *    → 不配映射等于「导入了但没对账」，比不导还糟（它假装做了）。
   */
  statusMapping: Record<string, string>;
  /**
   * 打款时间列（选填）。
   *
   * ⚠️ **不配这一列有严重后果** —— 比对引擎的 **D 类**（「渠道有、本地没有」，
   *    也就是**渠道打了钱而本地没记录**）判定依赖「这条流水的时刻是否落在
   *    扩大窗口内」，**没有时刻就无从判断** → 引擎会直接跳过这类记录。
   *    → **不配 `paidAtColumn` 的账单，所有 D 类差异都是不可见的**。
   *
   * ⚠️ **同一后果还有第二处** —— 归组排序也用 `paidAt`：全部记录都没有时刻时，
   *    排序退化成按 `providerTxnId` 的字典序（引擎有 tie-break，结论仍然确定，
   *    但「取 `paidAt` 最晚的那条」这条兜底就变成了「取交易号最大的那条」）。
   *
   * → **本阶段仍保持选填**（真实渠道的账单未必有时间列），
   *    但**导入端必须提示运营**：不配时间列 → D 类差异检不出来。
   *
   * ⚠️ **「配了列」不等于「有时刻」** —— 那一列可能整列是空值、或者是运营
   *    搞错了格式（渠道写 `2026/03/02 10:00` 而我们只认 ISO）→ 每行的
   *    `paidAt` 都是 `undefined` → **后果与不配一模一样**（D 类全检不出来），
   *    而运营看到的 `diffCount` 是 0 → 当成「一切正常」。
   *    → **提示必须基于「实际解析出了几个时刻」，不能只看「配没配列」**。
   */
  paidAtColumn?: string;
}

/** 导入的行数上限（与渠道记录数上限一致） */
export const CSV_MAX_ROWS = 10_000;

/**
 * 响应里最多回多少条「被跳过的行」的明细。
 *
 * ⚠️ **回明细是为了让运营能回去查原账单** —— 只给一个总数，运营还得自己
 *    数第几行有问题。
 * ⚠️ **超出的部分必须带 `skippedRowsTruncated` 标记** —— 静默截断会让人
 *    以为「就这么多行有问题」（与 `RECONCILIATION_MAX_ITEMS` 同一原则）。
 */
export const CSV_MAX_SKIPPED_ROWS_REPORTED = 100;

/**
 * 没有解析出任何「打款时间」时给运营的提示。
 *
 * ⚠️ **必须提示，不能静默** —— D 类（「渠道打了钱而本地没记录」）的判定
 *    依赖流水的时刻是否落在扩大窗口内。没有时刻 → 引擎的 D 类判定直接跳过
 *    → **渠道多打的钱一笔都检不出来**，而运营看到的是「差异数 0，一切正常」。
 *    静默就是给出「钱没问题的假象」。
 *
 * ⚠️ **不区分「没配列」与「配列全空」** —— 两者的后果**完全一样**
 *    （D 类都检不出来），对运营来说也只需要同一个动作：去补时刻。
 *    → 用同一句话覆盖两种情形，别让运营去分辨「是配置问题还是数据问题」。
 */
export const CSV_NO_PAID_AT_WARNING =
  '账单里没有解析出任何「打款时间」：渠道流水的时刻全部缺失，' +
  'D 类差异（渠道已打款、本地无记录）检不出来 —— ' +
  '请确认列映射里的 `paidAtColumn` 是否指向了真正的打款时间列、' +
  '且该列的格式能被解析后重新导入。';

/**
 * 校验列映射。
 *
 * @throws BadRequestException 映射不合法时抛
 */
export function assertColumnMapping(value: unknown): CsvColumnMapping {
  if (typeof value !== 'object' || value === null) {
    throw new BadRequestException('列映射不能为空');
  }
  const raw = value as Record<string, unknown>;
  const txnIdColumn = raw.txnIdColumn;
  const amountColumn = raw.amountColumn;
  const amountUnit = raw.amountUnit;

  if (typeof txnIdColumn !== 'string' || txnIdColumn.trim() === '') {
    throw new BadRequestException('必须指定「渠道交易号」列');
  }
  if (typeof amountColumn !== 'string' || amountColumn.trim() === '') {
    throw new BadRequestException('必须指定「金额」列');
  }
  if (amountUnit !== 'CENT' && amountUnit !== 'YUAN') {
    throw new BadRequestException('必须指定金额单位（分 或 元）');
  }
  // ⚠️ **状态列必填** —— 不配状态列就无从判断渠道是否真的打了款。
  //    比对引擎只在渠道状态**恰好是 `'SUCCESS'`** 时才判 A 类，
  //    而 A 类是**唯一会自动改钱状态**的差异（`PROCESSING → PAID`）。
  //    → 曾经「不配就当 SUCCESS」等于替运营做了一个可能错的假设，
  //    会把本地卡在 `PROCESSING` 的单**自动改成已付款**。
  //    → 现在不配就拒：宁可不让导，也不给误改钱留口子。
  const statusColumn = raw.statusColumn;
  if (typeof statusColumn !== 'string' || statusColumn.trim() === '') {
    throw new BadRequestException(
      '必须指定「状态」列：不配这一列就无从判断渠道是否真的打了款 —— ' +
        '所有渠道流水都会被当成「渠道已打款成功」，' +
        '本地还卡在处理中的出款单会被自动改成已付款。' +
        '请在列映射里补上 `statusColumn` 与配套的 `statusMapping` 后重新导入。',
    );
  }
  // ⚠️ **状态值映射与状态列同进同出** —— 配了状态列却不配映射，
  //    渠道的状态词会原样落进 `status` → 引擎只认 `'SUCCESS'` / `'FAILED'`
  //    两个精确值 → 全落进 g 档「渠道非终态 → 不算差异」
  //    → **A/B/C/F 四类差异全部检不出来**，而响应里 `diffCount` 仍是 0
  //    → 运营当成「一切正常」。那等于「导入了但没对账」，比不导还糟。
  const statusMapping = raw.statusMapping;
  if (
    typeof statusMapping !== 'object' ||
    statusMapping === null ||
    Array.isArray(statusMapping) ||
    Object.keys(statusMapping).length === 0
  ) {
    throw new BadRequestException(
      '必须指定「状态值映射」：配了状态列却不配映射，' +
        '渠道的状态词不会被引擎认成成功或失败 → ' +
        'A/B/C/F 四类差异全部检不出来，而差异数仍是 0。',
    );
  }
  return {
    txnIdColumn: txnIdColumn.trim(),
    referenceNoColumn:
      typeof raw.referenceNoColumn === 'string'
        ? raw.referenceNoColumn.trim()
        : undefined,
    amountColumn: amountColumn.trim(),
    amountUnit,
    statusColumn: statusColumn.trim(),
    statusMapping: statusMapping as Record<string, string>,
    paidAtColumn:
      typeof raw.paidAtColumn === 'string'
        ? raw.paidAtColumn.trim()
        : undefined,
  };
}

/**
 * 一条被跳过的行。
 *
 * ⚠️ **必须带行号** —— 运营要能回到**原账单**里查这一行到底怎么了。
 *    只说「跳过了 500 行」等于让人自己去数行号。
 */
export interface CsvSkippedRow {
  /** 行号（**账单文件里的物理行号**，第 1 行是表头 → 第一条数据是第 2 行） */
  rowNumber: number;
  /** 跳过的原因（中文，给运营看） */
  reason: string;
}

/** CSV 解析的结果 */
export interface CsvParseResult {
  /** 解析出来的渠道流水 */
  records: ChannelPayoutRecord[];
  /** 被跳过的行（⚠️ **不是空数组就说明账单有行没能参与对账**） */
  skippedRows: CsvSkippedRow[];
  /**
   * ⚠️ **实际解析出了几个打款时刻** —— 不是「配没配列」。
   *
   * → 配了列但整列是空值/格式不对时，这个数是 0 → **后果与不配列完全一样**
   *    （D 类差异全检不出来）→ 提示必须看这个数。
   */
  parsedPaidAtCount: number;
}

/**
 * 把 CSV 解析成渠道流水。
 *
 * ⚠️ **只取白名单列** —— 不做公式展开等富文本特性（解析上传文件是攻击面）。
 * ⚠️ **超行数上限直接报错**，不静默截断 —— 截断出来的对账结论是错的。
 * ⚠️ **跳过的行必须报告出来** —— 一份账单里若有 500 行金额格式不对，
 *    对账结论是**基于剩下的行**算的；运营不知道被跳过了几行 →
 *    看到「差异数 0」就以为钱没问题。
 *    → **静默丢行 = 给出「钱没问题的假象」**，与「不提示 D 类检不出来」同罪。
 */
export function parseCsvToChannelRecords(
  csvText: string,
  mapping: CsvColumnMapping,
): CsvParseResult {
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    // ⚠️ **不跳空行** —— 空行要**占着位置**，
    //    否则后面所有行的行号都会偏移（运营拿着行号回原账单查会对不上）。
    //    空行在下面按「整行皆空」过滤掉，但**索引保留**。
    skipEmptyLines: false,
    // ⚠️ **不启用 dynamicTyping** —— 值全部当字符串，金额与时间我们自己处理
    dynamicTyping: false,
  });

  // ⚠️ **行号 = 物理行号** —— `parsed.data[0]` 对应文件的第 2 行
  //    （第 1 行是表头）→ 行号 = 索引 + 2。
  const rows = parsed.data
    .map((row, index) => ({
      row,
      rowNumber: index + 2,
    }))
    .filter(
      ({ row }) =>
        row && Object.values(row).some((v) => (v ?? '').trim() !== ''),
    );
  if (rows.length > CSV_MAX_ROWS) {
    throw new ConflictException(
      `账单文件有 ${rows.length} 行，超过上限 ${CSV_MAX_ROWS} 行`,
    );
  }

  const records: ChannelPayoutRecord[] = [];
  const skippedRows: CsvSkippedRow[] = [];
  let parsedPaidAtCount = 0;
  for (const { row, rowNumber } of rows) {
    const providerTxnId = (row[mapping.txnIdColumn] ?? '').trim();
    if (!providerTxnId) {
      // ⚠️ **没有交易号的行无法参与匹配** —— 但必须**报告**，
      //    不能静默丢（它可能是渠道多打的一笔钱）。
      skippedRows.push({
        rowNumber,
        reason: `「${mapping.txnIdColumn}」列为空，无法参与匹配`,
      });
      continue;
    }
    const amount = parseAmount(row[mapping.amountColumn], mapping.amountUnit);
    if (amount === null) {
      skippedRows.push({
        rowNumber,
        reason: `「${mapping.amountColumn}」列的金额无法解析（空值或非数字）`,
      });
      continue;
    }
    // ⚠️ **状态列必填**（`assertColumnMapping` 已拒掉不配的）→
    //    这里**不存在**「没有状态」的分支 → **永远不会凭空造出 `'SUCCESS'`**。
    const status = mapStatus(row[mapping.statusColumn], mapping.statusMapping);
    const paidAt = mapping.paidAtColumn
      ? parsePaidAt(row[mapping.paidAtColumn])
      : undefined;
    if (paidAt) {
      parsedPaidAtCount += 1;
    }

    records.push({
      providerTxnId,
      referenceNo: mapping.referenceNoColumn
        ? (row[mapping.referenceNoColumn] ?? '').trim() || undefined
        : undefined,
      amount,
      status,
      paidAt,
    });
  }
  return { records, skippedRows, parsedPaidAtCount };
}

/** 解析金额（按单位换算；解析不出返回 `null`） */
function parseAmount(
  raw: string | undefined,
  unit: CsvAmountUnit,
): number | null {
  const text = (raw ?? '').trim();
  if (text === '') {
    return null;
  }
  const value = Number(text);
  if (!Number.isFinite(value)) {
    return null;
  }
  // ⚠️ **元 → 分要四舍五入** —— 直接截断会少给商家钱
  return unit === 'YUAN' ? Math.round(value * 100) : Math.round(value);
}

/**
 * 按映射表把渠道的状态词翻成内部状态。
 *
 * ⚠️ **翻不出就落 `'UNKNOWN'`，绝不落 `'SUCCESS'`** ——
 *    引擎只在渠道状态**恰好是 `'SUCCESS'`** 时才判 A 类
 *    （`payout-reconcile.engine.ts`：`authoritative.status === 'SUCCESS'`），
 *    而 A 类会**自动把本地出款单从 `PROCESSING` 改成 `PAID`**。
 *    → `'UNKNOWN'` 走引擎的 g 档「渠道非终态 → 不算差异」→ **不改钱**。
 *    → 反过来说：**宁可漏判，也不能误判成「渠道已打款」**。
 */
function mapStatus(
  raw: string | undefined,
  mapping: Record<string, string>,
): string {
  const text = (raw ?? '').trim();
  if (!text) {
    return 'UNKNOWN';
  }
  return mapping[text] ?? 'UNKNOWN';
}

/** 解析打款时刻（解析不出返回 `undefined`） */
function parsePaidAt(raw: string | undefined): Date | undefined {
  const text = (raw ?? '').trim();
  if (text === '') {
    return undefined;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
