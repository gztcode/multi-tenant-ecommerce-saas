import Link from 'next/link';
import { formatPrice } from '@/lib/format';
import type { PublicProductCard } from '@/lib/catalog';

export function ProductCard({ product }: { product: PublicProductCard }) {
  // 封面就是媒体列表里 sort 最小的那张——商品表不单独存封面字段，
  // 避免两个地方抢着决定谁是封面。
  // 后端已按 sort asc 返回，所以第一张就是封面。
  const cover = product.media[0]?.media;

  return (
    <Link
      href={`/p/${product.slug}`}
      className="flex flex-col overflow-hidden rounded-lg border transition hover:shadow-base"
    >
      <div className="aspect-square bg-muted">
        {cover ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={cover.url}
            alt={product.name}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            暂无图片
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1 p-3">
        <h3 className="line-clamp-2 font-medium">{product.name}</h3>
        {product.subtitle && (
          <p className="line-clamp-1 text-sm text-muted-foreground">
            {product.subtitle}
          </p>
        )}
        <p className="font-semibold text-primary">
          {formatPrice(product.minPrice)}
        </p>
      </div>
    </Link>
  );
}