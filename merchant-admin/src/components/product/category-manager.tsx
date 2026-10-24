'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface CategoryNode {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  sort: number;
  children: CategoryNode[];
}

/** 创建表单挂在哪个父品类下；null 表示新增一级品类 */
type Adding = { parentId: string | null } | null;
/** 正在改名的节点 id；null 表示没有改名表单打开着 */
type Renaming = { id: string; name: string } | null;

/** 统一的中转路由响应解析：错误 message 直接可以显示给人看 */
async function readResponse(response: Response, fallback: string): Promise<string | null> {
  const payload = (await response.json().catch(() => ({}))) as { message?: string };
  return response.ok ? null : (payload.message ?? fallback);
}

/**
 * 品类树管理：新增、删除、改名。
 *
 * 所有写操作都走同源的 /api/** 中转（不是直连后端）：
 * 后端没开 CORS，客户端直连会被预检拦掉成 `Failed to fetch`，
 * 而且 accessToken 不该进客户端代码。中转路由在服务端用 auth() 取 token。
 *
 * 保存后调 router.refresh() 让 Server Component 重新取树——
 * 树是服务端渲染的，本组件不持有树的副本，避免两份状态不同步。
 *
 * 层级最多 3 层、以及「有子品类或有商品不能删」都由后端判定，
 * 这里的错误提示是把后端的 message 原样显示出来。
 */
export function CategoryManager({ initial }: { initial: CategoryNode[] }) {
  const router = useRouter();
  const [adding, setAdding] = useState<Adding>(null);
  const [renaming, setRenaming] = useState<Renaming>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    if (!name.trim() || !slug.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/categories', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          slug: slug.trim(),
          ...(adding?.parentId ? { parentId: adding.parentId } : {}),
        }),
      });
      const failure = await readResponse(response, '创建失败');
      if (failure) throw new Error(failure);

      setAdding(null);
      setName('');
      setSlug('');
      router.refresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '创建失败');
    } finally {
      setBusy(false);
    }
  }

  async function rename() {
    if (!renaming || !renaming.name.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/categories/${renaming.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: renaming.name.trim() }),
      });
      const failure = await readResponse(response, '改名失败');
      if (failure) throw new Error(failure);

      setRenaming(null);
      router.refresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '改名失败');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string, label: string) {
    if (!confirm(`确定删除「${label}」？有子品类或商品的品类删不掉。`)) return;
    setMessage(null);
    try {
      const response = await fetch(`/api/categories/${id}`, { method: 'DELETE' });
      // DELETE 成功时是 204，没有响应体，json() 会抛——所以只在非 2xx 时解析。
      if (!response.ok) {
        const failure = await readResponse(response, '删除失败');
        throw new Error(failure ?? '删除失败');
      }
      router.refresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '删除失败');
    }
  }

  function renderNode(node: CategoryNode, depth: number) {
    const isRenaming = renaming?.id === node.id;
    return (
      <li key={node.id} className="flex flex-col gap-1">
        <div
          className="flex items-center gap-2 py-0.5"
          style={{ paddingLeft: `${depth * 20}px` }}
        >
          {isRenaming ? (
            <span className="flex items-center gap-2">
              <input
                value={renaming.name}
                aria-label={`改名 ${node.name}`}
                onChange={(e) => setRenaming({ id: node.id, name: e.target.value })}
                className="rounded-md border px-2 py-1"
              />
              <button
                type="button"
                onClick={rename}
                disabled={busy}
                className="text-xs underline disabled:opacity-40"
              >
                保存
              </button>
              <button
                type="button"
                onClick={() => setRenaming(null)}
                className="text-xs underline"
              >
                取消
              </button>
            </span>
          ) : (
            <>
              <span>{node.name}</span>
              <span className="text-xs text-muted-foreground">/{node.slug}</span>
              {depth < 2 && (
                <button
                  type="button"
                  onClick={() => {
                    setAdding({ parentId: node.id });
                    setName('');
                    setSlug('');
                    setMessage(null);
                  }}
                  className="text-xs underline"
                >
                  加子品类
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setRenaming({ id: node.id, name: node.name });
                  setMessage(null);
                }}
                className="text-xs underline"
              >
                改名
              </button>
              <button
                type="button"
                onClick={() => remove(node.id, node.name)}
                className="text-xs text-destructive underline"
              >
                删除
              </button>
            </>
          )}
        </div>
        {node.children.length > 0 && (
          <ul className="flex flex-col gap-1">
            {node.children.map((child) => renderNode(child, depth + 1))}
          </ul>
        )}
      </li>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {initial.length === 0 ? (
        <p className="text-sm text-muted-foreground">还没有品类，先新增一个一级品类。</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {initial.map((node) => renderNode(node, 0))}
        </ul>
      )}

      {adding === null ? (
        <button
          type="button"
          onClick={() => {
            setAdding({ parentId: null });
            setName('');
            setSlug('');
            setMessage(null);
          }}
          className="w-fit rounded-md border px-3 py-1.5 text-sm"
        >
          新增一级品类
        </button>
      ) : (
        <div className="flex flex-col gap-2 rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">
            {adding.parentId ? '在所选品类下新增子品类' : '新增一级品类'}
          </p>
          <div className="flex flex-wrap gap-2">
            <input
              value={name}
              aria-label="品类名"
              placeholder="品类名"
              onChange={(e) => setName(e.target.value)}
              className="rounded-md border px-2 py-1"
            />
            <input
              value={slug}
              aria-label="slug"
              placeholder="slug（小写字母、数字、连字符）"
              onChange={(e) => setSlug(e.target.value)}
              className="rounded-md border px-2 py-1"
            />
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={create}
              disabled={busy || !name.trim() || !slug.trim()}
              className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-40"
            >
              {busy ? '提交中…' : '保存'}
            </button>
            <button
              type="button"
              onClick={() => setAdding(null)}
              className="rounded-md border px-3 py-1.5 text-sm"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {message && (
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
      )}
    </div>
  );
}