import { headers } from 'next/headers';
import { resolveTenantSubdomain } from '@/lib/tenant';
import { fetchPublicCategories, fetchPublicProducts } from '@/lib/catalog';
import { ProductCard } from '@/components/product/product-card';

export default async function StorefrontHome() {
  const headerList = await headers();
  const subdomain = resolveTenantSubdomain(headerList);

  let products: Awaited<ReturnType<typeof fetchPublicProducts>> | null = null;
  let categories: Awaited<ReturnType<typeof fetchPublicCategories>> = [];
  let error: string | null = null;

  try {
    const [productResult, categoryResult] = await Promise.all([
      fetchPublicProducts(subdomain, { page: 1, pageSize: 24 }),
      fetchPublicCategories(subdomain),
    ]);
    products = productResult;
    categories = categoryResult;
  } catch (cause) {
    // 商品或品类拉不到时仍然要渲染页面：店铺不存在、店铺被暂停、或者后端没起，
    // 都应该给用户一句能看懂的提示，而不是一个 500 空白页。
    error = cause instanceof Error ? cause.message : '商品加载失败';
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 p-6">
      <nav className="flex flex-wrap gap-3 text-sm">
        {categories.map((category) => (
          <a key={category.id} href={`/c/${category.slug}`} className="underline">
            {category.name}
          </a>
        ))}
      </nav>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {products && products.items.length === 0 && (
        <p className="text-muted-foreground">这家店还没有上架商品。</p>
      )}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {products?.items.map((product) => (
          <ProductCard key={product.id} product={product} />
        ))}
      </div>
    </main>
  );
}