import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { ApiError, apiFetch } from '@/lib/api-client';
import { readJson, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * CSV 导入商品基础信息的中转。
 *
 * 逐行独立：某一行失败不影响其他行，响应返回每一行的结果。
 * 只支持基础信息（名称、slug、品类 id、描述性属性）——
 * 规格矩阵与媒体用扁平表格表达会立刻变得不可读，那部分不做。
 *
 * ⚠️ 白名单纪律：不整体透传请求体。这里只有 `csv` 一个字段，
 * 整体透传等于允许客户端往这个接口塞任意字段（哪怕后端只读 csv）。
 */

/** 一次导入最多处理多少行。逐行串行打后端，300 行就是 300 个往返。 */
const MAX_ROWS = 200;

interface ImportResult {
  /** CSV 里的物理行号（含表头，表头是第 1 行）。与商家在编辑器里看到的行号一致。 */
  row: number;
  ok: boolean;
  name?: string;
  error?: string;
}

/** 后端 CreateProductDto 的字段约束（见 api/src/modules/catalog/dto/create-product.dto.ts） */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 120;

/** 表头列名 → 内部字段。刻意**按列名**而不是按位置匹配。 */
const COLUMNS = {
  name: '名称',
  slug: 'slug',
  categoryId: '品类id',
  attributes: '描述性属性JSON',
} as const;

export async function POST(request: Request) {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }

  const parsed: unknown = await readJson(request);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return NextResponse.json({ message: '请求体必须是 JSON 对象' }, { status: 400 });
  }
  // 白名单重建：只取 csv 这一个字段。
  const csv = (parsed as Record<string, unknown>).csv;
  if (typeof csv !== 'string' || csv.trim() === '') {
    return NextResponse.json({ message: '缺少 csv 字段' }, { status: 400 });
  }

  // Excel 导出的文件带 BOM。不剥掉的话第一行的表头会变成「﻿名称」，
  // 按列名匹配就找不到「名称」这一列，整份文件静默地导入 0 行。
  const text = csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv;

  const rows = parseCsv(text);
  if (rows.length === 0) {
    return NextResponse.json({ message: 'CSV 是空的' }, { status: 400 });
  }

  const header = rows[0].cells.map((cell) => cell.trim());
  const columnIndex: Record<keyof typeof COLUMNS, number> = {
    name: -1,
    slug: -1,
    categoryId: -1,
    attributes: -1,
  };
  for (const key of Object.keys(COLUMNS) as Array<keyof typeof COLUMNS>) {
    const position = header.indexOf(COLUMNS[key]);
    if (position !== -1) columnIndex[key] = position;
  }

  if (columnIndex.name === -1 || columnIndex.slug === -1) {
    return NextResponse.json(
      {
        message: `表头必须包含「${COLUMNS.name}」与「${COLUMNS.slug}」两列。识别到的表头是：${header.join('、')}`,
      },
      { status: 400 },
    );
  }

  const dataRows = rows.slice(1).filter((row) => row.cells.some((cell) => cell.trim() !== ''));
  if (dataRows.length === 0) {
    return NextResponse.json(
      { message: 'CSV 只有表头，没有数据行' },
      { status: 400 },
    );
  }
  if (dataRows.length > MAX_ROWS) {
    return NextResponse.json(
      { message: `一次最多导入 ${MAX_ROWS} 行，当前有 ${dataRows.length} 行` },
      { status: 400 },
    );
  }

  const results: ImportResult[] = [];

  for (const row of dataRows) {
    const line = row.line;
    const name = cellAt(row, columnIndex.name);
    const slug = cellAt(row, columnIndex.slug);

    if (name === '') {
      results.push({ row: line, ok: false, error: '名称不能为空' });
      continue;
    }
    if (name.length > MAX_NAME_LENGTH) {
      results.push({ row: line, ok: false, name, error: `名称超过 ${MAX_NAME_LENGTH} 个字符` });
      continue;
    }
    if (slug === '') {
      results.push({ row: line, ok: false, name, error: 'slug 不能为空' });
      continue;
    }
    if (!SLUG_PATTERN.test(slug)) {
      results.push({
        row: line,
        ok: false,
        name,
        error: 'slug 只能包含小写字母、数字与连字符',
      });
      continue;
    }

    let attributes: Record<string, string> | undefined;
    const attributesJson = cellAt(row, columnIndex.attributes);
    if (attributesJson !== '') {
      let decoded: unknown;
      try {
        decoded = JSON.parse(attributesJson);
      } catch {
        results.push({ row: line, ok: false, name, error: '描述性属性不是合法 JSON' });
        continue;
      }
      if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
        results.push({ row: line, ok: false, name, error: '描述性属性必须是 JSON 对象' });
        continue;
      }
      if (Object.values(decoded).some((value) => typeof value !== 'string')) {
        results.push({ row: line, ok: false, name, error: '描述性属性的值必须都是字符串' });
        continue;
      }
      attributes = decoded as Record<string, string>;
    }

    const categoryId = cellAt(row, columnIndex.categoryId);

    // 白名单重建：只发后端 CreateProductDto 认识的四个字段。
    // 特别是不发 status——新建商品一律是 DRAFT，状态只能后续 PATCH。
    const body: Record<string, unknown> = { name, slug };
    if (categoryId !== '') body.categoryId = categoryId;
    if (attributes !== undefined && Object.keys(attributes).length > 0) {
      body.attributes = attributes;
    }

    try {
      await apiFetch('/catalog/products', {
        method: 'POST',
        body,
        token: session.accessToken,
      });
      results.push({ row: line, ok: true, name });
    } catch (cause) {
      // ⚠️ 单行失败不中断整体：后端的 message 已经是脱敏的业务提示
      // （例如 slug 已存在），直接透传给商家看。
      results.push({
        row: line,
        ok: false,
        name,
        error:
          cause instanceof ApiError ? cause.message : '创建失败，请稍后重试',
      });
    }
  }

  return NextResponse.json({
    total: results.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  });
}

/** 取某列的值；列不存在（表头没这一列）时返回空串 */
function cellAt(row: ParsedRow, index: number): string {
  if (index < 0) return '';
  return (row.cells[index] ?? '').trim();
}

interface ParsedRow {
  /** 物理行号，含表头，表头是第 1 行 */
  line: number;
  cells: string[];
}

/**
 * RFC 4180 CSV 解析器。
 *
 * ⚠️ 计划里给的版本按 `split(/\r?\n/)` 先切行——那会把**带引号包裹的换行**
 * （商品描述里换行是常态）拦腰截断，后半截变成一条莫名其妙的「数据行」，
 * 然后造出一个名字为空或 slug 不合法的假商品。
 *
 * 这里是单遍状态机：引号内的换行归到当前单元格，只有引号外的换行才是行分隔符。
 * \r\n 与裸 \n 等价处理，保证表头是第 1 行、报出来的行号与商家在编辑器里看到的一致。
 */
function parseCsv(text: string): ParsedRow[] {
  const rows: ParsedRow[] = [];
  let cells: string[] = [];
  let current = '';
  let inQuotes = false;
  let line = 1;
  /** 当前行起始的物理行号——引号内换行不会推进它 */
  let rowStartLine = 1;
  let sawAnyChar = false;

  const pushRow = () => {
    cells.push(current);
    rows.push({ line: rowStartLine, cells });
    cells = [];
    current = '';
    rowStartLine = line + 1;
    sawAnyChar = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        // 两个连续的引号 = 转义后的一个字面引号
        if (text[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (char === '\n') line += 1;
        current += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      sawAnyChar = true;
      continue;
    }
    if (char === ',') {
      cells.push(current);
      current = '';
      sawAnyChar = true;
      continue;
    }
    if (char === '\r') {
      // 行尾的 \r\n 归一化成 \n。引号外的裸 \r 也当行尾。
      if (text[i + 1] === '\n') i += 1;
      pushRow();
      line += 1;
      continue;
    }
    if (char === '\n') {
      pushRow();
      line += 1;
      continue;
    }
    current += char;
    sawAnyChar = true;
  }

  // 末尾没有换行时的最后一行。sawAnyChar 判掉「文件以换行结尾」多出来的空行。
  if (current !== '' || cells.length > 0 || sawAnyChar) {
    cells.push(current);
    rows.push({ line: rowStartLine, cells });
  }

  return rows;
}