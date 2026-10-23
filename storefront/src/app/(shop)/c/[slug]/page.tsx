import { headers } from 'next/headers';
import { resolveTenantSubdomain } from '@/lib/tenant';
import { fetchPublicCategories, fetchPublicProducts } from '@/lib/catalog';
import { ProductCard } from '@/components/product/product-card';

export default async function CategoryPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  // Next.js 15 起 params 是异步的，必须 await
  const { slug } = await params;
  const headerList = await headers();
  const subdomain = resolveTenantSubdomain(headerList);

  // 品类页按 slug 查商品：公开接口目前只支持按 categoryId 过滤，
  // 这里先用公开的品类树把 slug 解析成 id，再按 id 查。
  const categories = await fetchPublicCategories(subdomain).catch(() => []);
  const flat: Array<{
    id: string;
    slug: string;
    name: string;
    parentId: string | null;
  }> = [];
  const walk = (nodes: typeof categories) => {
    for (const node of nodes) {
      flat.push(node);
      walk(node.children);
    }
  };
  walk(categories);
  const category = flat.find((c) => c.slug === slug);

  const products = category
    ? await fetchPublicProducts(subdomain, {
        categoryId: category.id,
        pageSize: 48,
      }).catch(() => null)
    : null;

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-bold">{category?.name ?? '品类不存在'}</h1>
      {category && products && products.items.length === 0 && (
        <p className="text-muted-foreground">这个品类下还没有上架商品。</p>
      )}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {products?.items.map((product) => (
          <ProductCard key={product.id} product={product} />
        ))}
      </div>
    </main>
  );
}