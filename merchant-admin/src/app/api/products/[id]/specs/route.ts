import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { readJson, toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 商品规格矩阵的整体替换（PUT）。
 *
 * 这是「替换」而不是「增删改」：前端提交一份完整的规格结构，后端在一个事务里
 * 匹配既有 SKU、新增缺失的、删除多余的。增量接口会让前端自己算笛卡尔积再发
 * 一串请求，中途失败会留下「值删了但 SKU 还在」这类不一致状态。
 *
 * ⚠️ **PUT 是破坏性的**：提交一份「颜色: 只有红色」的矩阵，会把原来的
 * 「颜色 × 尺码」整个换掉，多余的 SKU 被软删。调用方（下一步的规格矩阵编辑器）
 * 必须提交**完整的**当前结构，不能只提交改动的那部分；
 * 值对象里的 id 会被这里丢掉（后端按文本匹配），所以「拿着详情页的 specs
 * 原样回传」是安全的，但「只回传某一维」会把其他维删掉。
 *
 * 后续的规格矩阵编辑器（components/product/spec-matrix-editor.tsx）走这个中转。
 */

/** 后端 ReplaceSpecsDto 的上限：最多 2 个维度 */
const MAX_SPECS = 2;
/** 后端 SpecInputDto.values 的 ArrayMaxSize(20) */
const MAX_VALUES = 20;
/** 后端对维度名与规格值都限了 40 个字符 */
const MAX_TEXT_LENGTH = 40;

/**
 * 校验一段非空文本，返回 trim 后的值。
 *
 * 返回值用 `null` 表示不合法：调用点都要自己给一条指明字段位置的错误提示，
 * 传进去 label 也没地方用，反而让签名变胖。
 */
function readText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > MAX_TEXT_LENGTH) return null;
  return trimmed;
}

/**
 * 整体替换规格矩阵。
 *
 * 请求体按白名单重建，不整体透传：ValidationPipe 开了 forbidNonWhitelisted，
 * 多传一个字段就是 400。
 *
 * ⚠️ **specs[].values[] 里绝不能带 id**：后端 SpecValueInputDto 没有 id 字段，
 * 而且规格值是按 `(specId, value)` 的**文本**匹配的（理由见 DTO 注释）。
 * 这里显式只取 value，多余的 id 被丢掉——既不会 400，也堵掉
 * 「把 A 商品的规格值挂到 B 商品上」这条路。
 *
 * version 是乐观锁，必传；不匹配返回 409「商品已被他人修改，请刷新后重试」。
 * 保存成功后后端会把商品 version 递增。
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }
  const { id } = await params;

  const parsed: unknown = await readJson(request);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return NextResponse.json({ message: '请求体必须是 JSON 对象' }, { status: 400 });
  }
  const body = parsed as Record<string, unknown>;

  const version = body.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return NextResponse.json(
      { message: 'version 必须是 ≥ 1 的整数（乐观锁必传）' },
      { status: 400 },
    );
  }

  const specs = body.specs;
  if (!Array.isArray(specs)) {
    return NextResponse.json({ message: 'specs 必须是数组' }, { status: 400 });
  }
  if (specs.length > MAX_SPECS) {
    return NextResponse.json({ message: `规格维度最多 ${MAX_SPECS} 个` }, { status: 400 });
  }

  const sanitizedSpecs: Array<{ name: string; values: Array<{ value: string }>; sort: number }> =
    [];

  for (const [index, rawSpec] of specs.entries()) {
    if (typeof rawSpec !== 'object' || rawSpec === null || Array.isArray(rawSpec)) {
      return NextResponse.json(
        { message: `specs[${index}] 必须是对象` },
        { status: 400 },
      );
    }
    const spec = rawSpec as Record<string, unknown>;

    const name = readText(spec.name);
    if (name === null) {
      return NextResponse.json(
        { message: `specs[${index}].name 必须是非空字符串（≤ ${MAX_TEXT_LENGTH} 字）` },
        { status: 400 },
      );
    }

    const rawValues = spec.values;
    if (!Array.isArray(rawValues) || rawValues.length === 0) {
      return NextResponse.json(
        { message: `specs[${index}].values 必须是非空数组` },
        { status: 400 },
      );
    }
    if (rawValues.length > MAX_VALUES) {
      return NextResponse.json(
        { message: `specs[${index}].values 最多 ${MAX_VALUES} 个` },
        { status: 400 },
      );
    }

    const values: Array<{ value: string }> = [];
    for (const [valueIndex, rawValue] of rawValues.entries()) {
      // 既接受 { value: '红色' } 也接受裸字符串 '红色'：
      // 前者是 DTO 的形状，后者是编辑器内部更顺手的数据形状，
      // 在中转这一层做一次归一，省得两个调用方各写一遍。
      const candidate =
        typeof rawValue === 'string'
          ? rawValue
          : typeof rawValue === 'object' && rawValue !== null && !Array.isArray(rawValue)
            ? (rawValue as Record<string, unknown>).value
            : undefined;
      const value = readText(candidate);
      if (value === null) {
        return NextResponse.json(
          {
            message: `specs[${index}].values[${valueIndex}] 必须是非空字符串（≤ ${MAX_TEXT_LENGTH} 字）`,
          },
          { status: 400 },
        );
      }
      // 同一维度内的重复值没有意义（后端按文本匹配，重复项会得到同一个值），
      // 在中转去重，省一次往返。
      if (!values.some((v) => v.value === value)) {
        values.push({ value });
      }
    }

    // sort 是后端 DTO 里的可选字段；这里按数组顺序补上，
    // 保证「编辑器里的上下顺序」就是「数据库里的展示顺序」。
    const sort = spec.sort;
    if (sort !== undefined && (!Number.isInteger(sort) || (sort as number) < 0)) {
      return NextResponse.json(
        { message: `specs[${index}].sort 必须是非负整数` },
        { status: 400 },
      );
    }
    sanitizedSpecs.push({
      name,
      values,
      sort: sort === undefined ? index : (sort as number),
    });
  }

  try {
    const result = await apiFetch(`/catalog/products/${id}/specs`, {
      method: 'PUT',
      body: { version, specs: sanitizedSpecs },
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}