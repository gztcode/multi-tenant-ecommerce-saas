import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { resolveTenantSubdomain } from '@/lib/tenant';
import { fetchPublicProduct } from '@/lib/catalog';
import { SpecSelector } from '@/components/product/spec-selector';

export default async function ProductPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  // Next.js 15 起 params 是异步的，必须 await
  const { slug } = await params;
  const headerList = await headers();
  const subdomain = resolveTenantSubdomain(headerList);

  let product: Awaited<ReturnType<typeof fetchPublicProduct>> | null = null;
  try {
    product = await fetchPublicProduct(subdomain, slug);
  } catch {
    // 商品不存在、还是草稿、还是店铺被暂停，后端一律回 404。
    // 对匿名访客来说这几种情况没有区别，都渲染 404 页面。
    notFound();
  }

  const gallery = product.media.map((m) => m.media);
  const attributes = Object.entries(product.attributes ?? {});

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-8 p-6">
      <div className="grid gap-8 md:grid-cols-2">
        <div className="flex flex-col gap-2">
          {gallery.length === 0 ? (
            <div className="aspect-square flex items-center justify-center rounded-lg bg-muted text-muted-foreground">
              暂无图片
            </div>
          ) : (
            gallery.map((media) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={media.id}
                src={media.url}
                alt={product.name}
                className="w-full rounded-lg border"
              />
            ))
          )}
        </div>

        <div className="flex flex-col gap-4">
          <h1 className="text-2xl font-bold">{product.name}</h1>
          {product.subtitle && (
            <p className="text-muted-foreground">{product.subtitle}</p>
          )}
          <SpecSelector product={product} />
          {product.description && (
            <p className="whitespace-pre-wrap text-sm">{product.description}</p>
          )}
          {attributes.length > 0 && (
            <table className="text-sm">
              <tbody>
                {attributes.map(([key, value]) => (
                  <tr key={key}>
                    <td className="w-24 pr-4 text-muted-foreground">{key}</td>
                    <td>{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </main>
  );
}