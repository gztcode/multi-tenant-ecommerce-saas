'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { CategoryOption, ProductAttributes, ProductDetail, ProductStatus } from '@/components/product/types';

/**
 * 商品基本信息表单。
 *
 * 覆盖：名称、副标题、详情描述、品类、描述性属性、状态切换。
 * 规格矩阵与 SKU 价格表是另两个组件（SpecMatrixEditor / SkuPriceTable），
 * 由页面并列渲染，不在这份表单里。
 *
 * 保存走同源的 /api/products/[id] 中转——浏览器不能直连后端（没有 CORS），
 * 中转路由在服务端用 session 里的 accessToken 调后端。
 *
 * ⚠️ 保存逻辑写在本组件内部，没有从 Server Component 往下传回调：
 * Server → Client 传函数（事件处理器）在 tsc 与 next build 下都能过，
 * 只有真正渲染这一页时才 500（Event handlers cannot be passed to Client
 * Component props）。这与 ProductList 的批量操作是同一个理由。
 *
 * ⚠️ version（乐观锁）：从详情里带进来原样提交，后端不匹配返回 409。
 * 保存成功后用响应里的新 version 覆盖本地那份——后端每次更新都 +1，
 * 不更新的话下一次保存会拿旧版本号提交，必然 409。
 */

/** 中转路由的统一响应解析：错误 message 直接可以显示给人看 */
async function readResponse(response: Response, fallback: string): Promise<string | null> {
  const payload = (await response.json().catch(() => ({}))) as { message?: string };
  return response.ok ? null : (payload.message ?? fallback);
}

const STATUS_OPTIONS: Array<{ value: ProductStatus; label: string }> = [
  { value: 'DRAFT', label: '草稿' },
  { value: 'PUBLISHED', label: '已上架' },
  { value: 'UNPUBLISHED', label: '已下架' },
];

/**
 * 把描述性属性对象拍平成 textarea 里的多行「名称: 值」。
 *
 * 界面上必须用文本而不是一组动态输入框：属性名本身是商家自定义的
 * （材质/产地/克重/…），要支持新增一项就得同时维护「有哪些 key」这份状态，
 * 而 JSON 键是不可预测的。多行文本一次解决「展示 + 增删 key」两件事，
 * 代价是对格式敏感一点——所以下面 parse 时把不合法的行**丢掉而不是报错**，
 * 免得商家因为一个多余冒号就存不下去。
 */
export function attributesToText(attributes: ProductAttributes): string {
  // Object.entries 的顺序对整数样式的键（'1'、'2'）是升序而非插入序，
  // 显式排一下，避免商家来回编辑后键的顺序悄悄变样。
  return Object.keys(attributes)
    .sort()
    .map((key) => `${key}: ${attributes[key]}`)
    .join('\n');
}

/**
 * 把多行文本解析回描述性属性对象。
 *
 * 每行形如 `名称: 值`。忽略空行、忽略没有冒号的行（连同它后面的空白）。
 * 返回 null 表示有行被忽略了——调用点据此在界面上提示一句，
 * 而不是静默丢掉商家的输入。
 */
export function parseAttributesText(text: string): {
  attributes: ProductAttributes;
  ignoredLines: number;
} {
  const attributes: ProductAttributes = {};
  let ignoredLines = 0;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    const separator = line.indexOf(':') >= 0 ? line.indexOf(':') : line.indexOf('：');
    if (separator <= 0) {
      ignoredLines += 1;
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    // 「材质:」这种只有键没有值的行也丢掉：attributes 的值必须是字符串，
    // 存一个空字符串在详情页会渲染出一个只有标签的空格子。
    if (key === '' || value === '') {
      ignoredLines += 1;
      continue;
    }
    attributes[key] = value;
  }

  return { attributes, ignoredLines };
}

export function ProductEditForm({
  product,
  categories,
}: {
  product: ProductDetail;
  categories: CategoryOption[];
}) {
  const router = useRouter();

  const [name, setName] = useState(product.name);
  const [subtitle, setSubtitle] = useState(product.subtitle ?? '');
  const [description, setDescription] = useState(product.description ?? '');
  const [categoryId, setCategoryId] = useState(product.categoryId ?? '');
  const [status, setStatus] = useState<ProductStatus>(product.status);
  const [attributesText, setAttributesText] = useState(() =>
    attributesToText(product.attributes ?? {}),
  );

  const [version, setVersion] = useState(product.version);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(
    null,
  );

  
  async function save() {
    if (name.trim() === '') {
      setMessage({ tone: 'error', text: '商品名称不能为空' });
      return;
    }

    const { attributes, ignoredLines } = parseAttributesText(attributesText);

    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/products/${product.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          subtitle,
          description,
          // 空串 → null：后端只接受 string | null，null 才是「不分类」
          categoryId: categoryId === '' ? null : categoryId,
          attributes,
          status,
          version,
        }),
      });

      if (!response.ok) {
        const failure = await readResponse(response, '保存失败');
        // 409 的两种来源：乐观锁冲突（商品已被他人修改）与
        // 字段级冲突（例如 slug 占用）。文案都是后端脱敏过的，直接展示。
        throw new Error(failure ?? '保存失败');
      }

      const updated = (await response.json()) as { version: number };
      setVersion(updated.version);

      const hint =
        ignoredLines > 0
          ? `已保存（有 ${ignoredLines} 行不是「名称: 值」格式，已忽略）`
          : '已保存';
      setMessage({ tone: 'ok', text: hint });
      // 重新取服务端数据：保存后 publishedAt / minPrice 等派生值可能变了，
      // 让页面上的其余部分（面包屑、状态标签）跟上。
      router.refresh();
    } catch (cause) {
      setMessage({
        tone: 'error',
        text: cause instanceof Error ? cause.message : '保存失败',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-4 rounded-md border p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">基本信息</h3>
        <button
          type="button"
          disabled={busy}
          onClick={save}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-40"
        >
          {busy ? '保存中…' : '保存'}
        </button>
      </div>

      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        商品名称
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={120}
          className="rounded-md border px-2 py-1 text-sm"
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        副标题
        <input
          value={subtitle}
          onChange={(event) => setSubtitle(event.target.value)}
          maxLength={200}
          className="rounded-md border px-2 py-1 text-sm"
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        详情描述
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          rows={6}
          className="rounded-md border px-2 py-1 text-sm"
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        品类
        <select
          value={categoryId}
          onChange={(event) => setCategoryId(event.target.value)}
          className="rounded-md border px-2 py-1 text-sm"
        >
          <option value="">不分类</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        状态
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value as ProductStatus)}
          className="rounded-md border px-2 py-1 text-sm"
        >
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        描述性属性（每行一条，格式「名称: 值」，例如「材质: 纯棉」）
        <textarea
          value={attributesText}
          onChange={(event) => setAttributesText(event.target.value)}
          rows={5}
          placeholder={'材质: 纯棉\n产地: 浙江'}
          className="rounded-md border px-2 py-1 font-mono text-sm"
        />
      </label>

      {message && (
        <p
          role="status"
          className={
            message.tone === 'ok' ? 'text-sm text-muted-foreground' : 'text-sm text-destructive'
          }
        >
          {message.text}
        </p>
      )}

      </section>
  );
}