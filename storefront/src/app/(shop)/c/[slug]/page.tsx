import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
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
  let categories: Awaited<ReturnType<typeof fetchPublicCategories>> = [];
  let categoriesError: string | null = null;
  try {
    categories = await fetchPublicCategories(subdomain);
  } catch (cause) {
    // 品类树拉不到不能当成「品类不存在」，否则后端故障会被伪装成 404。
    categoriesError =
      cause instanceof Error ? cause.message : '品类加载失败';
  }

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

  if (categoriesError) {
    return (
      <main className="mx-auto flex min-h-screen max-w-6xl flex-col items-start gap-4 p-6">
        <p className="text-sm text-destructive">{categoriesError}</p>
        <Link href={`/c/${slug}`} className="underline">
          重试
        </Link>
        <Link href="/" className="text-sm text-muted-foreground underline">
          返回首页
        </Link>
      </main>
    );
  }

  if (!category) {
    notFound();
  }

  let products: Awaited<ReturnType<typeof fetchPublicProducts>> | null = null;
  let productsError: string | null = null;
  try {
    products = await fetchPublicProducts(subdomain, {
      categoryId: category.id,
      pageSize: 48,
    });
  } catch (cause) {
    productsError =
      cause instanceof Error ? cause.message : '商品加载失败';
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-bold">{category.name}</h1>
      {productsError && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-destructive">{productsError}</p>
          <Link href={`/c/${slug}`} className="underline">
            重试
          </Link>
        </div>
      )}
      {!productsError && products && products.items.length === 0 && (
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