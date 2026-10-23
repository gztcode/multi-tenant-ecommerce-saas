import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import { InventoryPanel } from '@/components/product/inventory-panel';

/**
 * 库存页（Server Component）。
 *
 * 库存汇总按 productId 查（后端 GET /inventory/summary 必填 productId），
 * 所以从商品编辑页带 ?productId= 进来才有 SKU 可选；
 * 没有参数时页面仍然渲染，只是只能看流水列表。
 */
interface SkuRow {
  skuId: string;
  code: string | null;
  stock: number;
  status: string;
}

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ productId?: string }>;
}) {
  const { productId } = await searchParams;

  let skus: SkuRow[] = [];
  let error: string | null = null;

  if (productId) {
    try {
      skus = await apiFetchAuthed<SkuRow[]>(
        `/inventory/summary?productId=${encodeURIComponent(productId)}`,
      );
    } catch (cause) {
      error =
        cause instanceof ApiError
          ? `加载库存失败（${cause.status}）：${cause.message}`
          : cause instanceof Error
            ? cause.message
            : '库存加载失败';
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-bold">库存</h2>
      <p className="text-sm text-muted-foreground">
        从商品编辑页进入可带上商品参数；没有商品参数时下方只能看流水。
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <InventoryPanel skus={skus} />
    </div>
  );
}