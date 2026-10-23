import { headers } from 'next/headers';
import { resolveTenantSubdomain } from '@/lib/tenant';
import { fetchPublicProducts } from '@/lib/catalog';
import { ProductCard } from '@/components/product/product-card';

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  // Next.js 15 起 searchParams 是异步的，必须 await
  const { q } = await searchParams;
  const headerList = await headers();
  const subdomain = resolveTenantSubdomain(headerList);

  const products = q
    ? await fetchPublicProducts(subdomain, { keyword: q, pageSize: 48 }).catch(
        () => null,
      )
    : null;

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-bold">{q ? `搜索「${q}」` : '搜索'}</h1>
      <form action="/search" className="flex gap-2">
        <input
          name="q"
          defaultValue={q ?? ''}
          placeholder="搜索商品"
          className="flex-1 rounded-md border px-3 py-2"
        />
        <button
          type="submit"
          className="rounded-md bg-primary px-4 text-primary-foreground"
        >
          搜索
        </button>
      </form>
      {products && products.items.length === 0 && (
        <p className="text-muted-foreground">没有找到相关商品。</p>
      )}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {products?.items.map((product) => (
          <ProductCard key={product.id} product={product} />
        ))}
      </div>
    </main>
  );
}