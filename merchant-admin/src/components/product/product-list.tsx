'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { formatPrice } from '@/components/product/format';

export interface ProductRow {
  id: string;
  name: string;
  slug: string;
  status: 'DRAFT' | 'PUBLISHED' | 'UNPUBLISHED';
  /** 派生字段，由 SKU 价格算出；没有可用 SKU 时为 null */
  minPrice: number | null;
  categoryId: string | null;
}

const STATUS_LABEL: Record<ProductRow['status'], string> = {
  DRAFT: '草稿',
  PUBLISHED: '已上架',
  UNPUBLISHED: '已下架',
};

const STATUS_OPTIONS: Array<{ value: '' | ProductRow['status']; label: string }> = [
  { value: '', label: '全部状态' },
  { value: 'PUBLISHED', label: '已上架' },
  { value: 'UNPUBLISHED', label: '已下架' },
  { value: 'DRAFT', label: '草稿' },
];

/** 统一的中转路由响应解析：错误 message 直接可以显示给人看 */
async function readResponse(response: Response, fallback: string): Promise<string | null> {
  const payload = (await response.json().catch(() => ({}))) as { message?: string };
  return response.ok ? null : (payload.message ?? fallback);
}

const BATCH_LABELS = {
  PUBLISH: '批量上架',
  UNPUBLISH: '批量下架',
  DELETE: '批量删除',
} as const;

type BatchAction = keyof typeof BATCH_LABELS;

/**
 * 商品列表：勾选 + 批量上架 / 下架 / 删除。
 *
 * 所有写操作走同源的 /api/products/batch 中转——浏览器不能直连后端（没有 CORS），
 * 中转路由在服务端用 session 里的 accessToken 调后端。
 *
 * 批量逻辑写在本组件内部，没有从 Server Component 往下传回调：
 * Server → Client 传函数（事件处理器）在 tsc 与 next build 下都能过，
 * 只有真正渲染这一页时才 500（Event handlers cannot be passed to Client
 * Component props）。
 *
 * 批量操作成功后 router.refresh() 重新取服务端渲染的列表；筛选与搜索通过
 * 改 URL 查询串触发，同一份数据只有服务端这一处副本。
 */
export function ProductList({
  initial,
  total,
  page,
  pageSize,
  categories,
}: {
  initial: ProductRow[];
  total: number;
  page: number;
  pageSize: number;
  categories: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // 筛选条件变化后清掉上一批勾选与提示：筛选由服务端重新渲染列表，
  // 旧勾选可能指向已经不在当前结果里的商品，留着只会让人误操作。
  const filterKey = searchParams.toString();
  useEffect(() => {
    setSelected(new Set());
    setMessage(null);
  }, [filterKey]);

  const categoryName = new Map(categories.map((c) => [c.id, c.name]));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => {
      const allSelected = initial.every((row) => prev.has(row.id));
      const next = new Set(prev);
      for (const row of initial) {
        if (allSelected) {
          next.delete(row.id);
        } else {
          next.add(row.id);
        }
      }
      return next;
    });
  }

  async function runBatch(action: BatchAction) {
    if (selected.size === 0) return;
    if (
      action === 'DELETE' &&
      !confirm(`确定删除选中的 ${selected.size} 个商品？删除是软删除，公开页面立刻不再展示。`)
    ) {
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/products/batch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: [...selected], action }),
      });
      const failure = await readResponse(response, '批量操作失败');
      if (failure) throw new Error(failure);

      setSelected(new Set());
      setMessage(`${BATCH_LABELS[action]}：已处理 ${selected.size} 个商品`);
      router.refresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '批量操作失败');
    } finally {
      setBusy(false);
    }
  }

  /** 把三个筛选值拼成查询串做客户端导航 */
  function applyFilter(form: HTMLFormElement) {
    const data = new FormData(form);
    const params = new URLSearchParams();
    const keyword = data.get('keyword');
    const status = data.get('status');
    const categoryId = data.get('categoryId');
    if (typeof keyword === 'string' && keyword.trim()) {
      params.set('keyword', keyword.trim());
    }
    if (typeof status === 'string' && status) {
      params.set('status', status);
    }
    if (typeof categoryId === 'string' && categoryId) {
      params.set('categoryId', categoryId);
    }
    const suffix = params.toString();
    router.push(`/products${suffix ? `?${suffix}` : ''}`);
  }

  /**
   * 翻页。
   *
   * 沿用筛选的同一套 URL 参数方式，不另开 state——筛选与分页都是「服务端
   * 重新渲染列表」的输入，分成两套状态迟早会不一致（比如筛选变了但 page
   * 还停在第 5 页，第 5 页可能已经越界）。
   */
  function goPage(target: number) {
    const params = new URLSearchParams(searchParams.toString());
    params.set('page', String(Math.max(1, target)));
    const suffix = params.toString();
    router.push(`/products${suffix ? `?${suffix}` : ''}`);
  }

  const allSelected = initial.length > 0 && initial.every((row) => selected.has(row.id));
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="flex flex-col gap-4">
      {/* 筛选是纯服务端渲染的：提交后查询串变化，Server Component 重新取数。
          用 onSubmit + preventDefault 而不是普通 GET 表单跳转，是为了在客户端
          导航（保留页面状态），并且能把空值从查询串里剔掉。 */}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          applyFilter(event.currentTarget);
        }}
        className="flex flex-wrap items-end gap-2"
      >
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          关键词
          <input
            name="keyword"
            defaultValue={searchParams.get('keyword') ?? ''}
            placeholder="商品名或 slug"
            className="rounded-md border px-2 py-1 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          状态
          <select
            name="status"
            defaultValue={searchParams.get('status') ?? ''}
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
          品类
          <select
            name="categoryId"
            defaultValue={searchParams.get('categoryId') ?? ''}
            className="rounded-md border px-2 py-1 text-sm"
          >
            <option value="">全部品类</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
        >
          筛选
        </button>
      </form>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">已选 {selected.size} 个</span>
        <button
          type="button"
          disabled={busy || selected.size === 0}
          onClick={() => runBatch('PUBLISH')}
          className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-40"
        >
          批量上架
        </button>
        <button
          type="button"
          disabled={busy || selected.size === 0}
          onClick={() => runBatch('UNPUBLISH')}
          className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-40"
        >
          批量下架
        </button>
        <button
          type="button"
          disabled={busy || selected.size === 0}
          onClick={() => runBatch('DELETE')}
          className="rounded-md border px-3 py-1.5 text-sm text-destructive disabled:opacity-40"
        >
          批量删除
        </button>
        <span className="text-xs text-muted-foreground">共 {total} 个商品</span>
      </div>

      {message && (
        <p role="status" className="text-sm text-muted-foreground">
          {message}
        </p>
      )}

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left">
            <th className="w-10">
              <input
                type="checkbox"
                aria-label="全选本页"
                checked={allSelected}
                onChange={toggleAll}
              />
            </th>
            <th>名称</th>
            <th>品类</th>
            <th>最低价</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          {initial.length === 0 ? (
            <tr>
              <td colSpan={5} className="py-4 text-muted-foreground">
                没有符合条件的商品。
              </td>
            </tr>
          ) : (
            initial.map((row) => (
              <tr key={row.id} className="border-b">
                <td>
                  <input
                    type="checkbox"
                    aria-label={`选择 ${row.name}`}
                    checked={selected.has(row.id)}
                    onChange={() => toggle(row.id)}
                  />
                </td>
                <td>
                  <Link href={`/products/${row.id}`} className="underline">
                    {row.name}
                  </Link>
                  <span className="ml-2 text-xs text-muted-foreground">/{row.slug}</span>
                </td>
                <td>
                  {row.categoryId ? (categoryName.get(row.categoryId) ?? '—') : '—'}
                </td>
                <td>{formatPrice(row.minPrice)}</td>
                <td>{STATUS_LABEL[row.status]}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <p className="text-muted-foreground">
            共 {total} 个商品 · 第 {page} / {totalPages} 页
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={page <= 1 || busy}
              onClick={() => goPage(page - 1)}
              className="rounded border px-3 py-1 disabled:opacity-40"
            >
              上一页
            </button>
            <button
              type="button"
              disabled={page >= totalPages || busy}
              onClick={() => goPage(page + 1)}
              className="rounded border px-3 py-1 disabled:opacity-40"
            >
              下一页
            </button>
          </div>
        </div>
      )}
    </div>
  );
}