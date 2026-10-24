'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * 新建商品页（Client Component）。
 *
 * 这一版最简：只填名称 + slug，创建成功后 router.push 到编辑页去补规格与价格。
 * 之所以不做成 Server Component + 表单 action，是因为创建成功后必须**客户端导航**
 * 到编辑页（`router.push`），而重定向逻辑放在客户端组件里最直接。
 *
 * 创建走同源的 /api/products 中转——浏览器不能直连后端（没有 CORS），
 * 中转路由在服务端用 session 里的 accessToken 调后端。
 *
 * slug 与中转里的正则一致（`^[a-z0-9]+(?:-[a-z0-9]+)*$`）：前端先挡一次，
 * 省一次往返；但真正的唯一性校验在后端（租户内部分唯一索引），
 * 撞了会返回 409「商品 slug 已被占用，换一个再试」，原样展示。
 */
export default function NewProductPage() {
  const router = useRouter();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    const trimmedName = name.trim();
    const trimmedSlug = slug.trim();
    if (trimmedName === '') {
      setError('商品名称不能为空');
      return;
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trimmedSlug)) {
      setError('slug 只能包含小写字母、数字与连字符');
      return;
    }

    setBusy(true);
    try {
      const response = await fetch('/api/products', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: trimmedName, slug: trimmedSlug }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(payload.message ?? '创建失败');
      }

      const created = (await response.json()) as { id: string };
      router.push(`/products/${created.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建失败');
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <nav className="flex items-center gap-2 text-sm text-muted-foreground">
        <Link href="/products" className="underline-offset-4 hover:underline">
          商品
        </Link>
        <span aria-hidden>›</span>
        <span>新建</span>
      </nav>

      <h2 className="text-2xl font-bold">新建商品</h2>
      <p className="text-sm text-muted-foreground">
        先把商品建出来（名称 + slug），然后在编辑页补规格、SKU 与图片。
        slug 参与前台 URL，创建后不可修改。
      </p>

      <form onSubmit={create} className="flex max-w-md flex-col gap-4">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          商品名称
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={120}
            placeholder="重磅纯棉T恤"
            className="rounded-md border px-2 py-1 text-sm"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          slug（URL 片段，小写字母 / 数字 / 连字符）
          <input
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            maxLength={120}
            placeholder="heavy-cotton-tee"
            className="rounded-md border px-2 py-1 text-sm"
          />
        </label>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-40"
          >
            {busy ? '创建中…' : '创建并继续编辑'}
          </button>
          <Link href="/products" className="text-sm underline">
            取消
          </Link>
        </div>
      </form>
    </div>
  );
}