import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import { ProductEditForm } from '@/components/product/product-edit-form';
import { SpecMatrixEditor } from '@/components/product/spec-matrix-editor';
import { SkuPriceTable } from '@/components/product/sku-price-table';
import { MediaUploader } from '@/components/product/media-uploader';
import type { CategoryOption, ProductDetail, ResolvedMediaItem } from '@/components/product/types';
import { PRODUCT_STATUS_LABEL } from '@/components/product/types';

/**
 * 商品编辑页（Server Component）。
 *
 * 详情在服务端取（apiFetchAuthed 走 session 里的 accessToken），只把**数据**
 * 往下传给客户端表单，绝不传函数——Server → Client 传事件处理器在 tsc 与
 * next build 下都能过，只有真正渲染这一页时才 500。
 *
 * 这一版是骨架：基本信息表单 + 规格/SKU 的中转就绪提示。
 * 规格矩阵编辑器与 SKU 价格表由下一步接入。
 */
interface CategoryNode {
  id: string;
  name: string;
  children: CategoryNode[];
}

/** 把品类树摊平成一维，供下拉框用 */
function flattenCategories(nodes: CategoryNode[]): CategoryOption[] {
  return nodes.flatMap((node) => [
    { id: node.id, name: node.name },
    ...flattenCategories(node.children),
  ]);
}

export default async function ProductEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let product: ProductDetail;
  try {
    product = await apiFetchAuthed<ProductDetail>(`/catalog/products/${id}`);
  } catch (cause) {
    // 404（商品不存在 / 已软删 / 不属于本租户）交给 notFound()：
    // 渲染一个 404 页面比显示「加载失败」诚实，也不该把 id 探测的结果泄出去。
    if (cause instanceof ApiError && cause.status === 404) {
      notFound();
    }
    return (
      <div className="flex flex-col gap-4">
        <Breadcrumb />
        <p className="text-sm text-destructive">
          {cause instanceof ApiError
            ? `加载商品失败（${cause.status}）：${cause.message}`
            : cause instanceof Error
              ? cause.message
              : '商品加载失败'}
        </p>
      </div>
    );
  }

  // 品类树独立取一次：后端商品详情只回 categoryId（没有嵌套的 category 对象），
  // 名字得自己映射。品类取不到不影响基本信息（只是下拉框空了），
  // 所以不因此让整页失败。
  let categories: CategoryOption[] = [];
  try {
    categories = flattenCategories(await apiFetchAuthed<CategoryNode[]>('/catalog/categories'));
  } catch {
    categories = [];
  }

  /**
   * 商品图片的 url 要**另外**取一次。
   *
   * 商品详情里的 media 只是 ProductMedia 关联行，只有 mediaId 没有 url
   * （后端 findOne 没有 include 嵌套的 media，详见 types.ts 的
   * ProductMediaEntry 注释）。而 GET /media 列表返回完整的 Media（含 url），
   * 所以按 mediaId 关联一次。
   *
   * ⚠️ 媒体列表是**按创建时间倒序、分页**的，pageSize 上限 100。
   * 一个商品最多 20 张图（后端 SetProductMediaDto 的 @ArrayMaxSize），
   * 但这个商品引用的图可能是很早之前传的，早于列表第一页。
   * 所以这里翻页翻到找齐（或最多 5 页）为止，宁可多几次往返，
   * 也不能让「第 2 页才找得到」的图片静默消失——那看起来像图丢了。
   *
   * 取不到就让图片区为空并提示，而不是让整页 500：
   * 图片挂了不该挡住商家改标题、改价。
   */
  const { items: resolvedMedia, failed: mediaLoadFailed } = await resolveMedia(product.media);

  return (
    <div className="flex flex-col gap-6">
      <Breadcrumb />

      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-bold">{product.name}</h2>
        <p className="text-xs text-muted-foreground">
          /{product.slug} · {PRODUCT_STATUS_LABEL[product.status]} · 版本 {product.version}
        </p>
      </div>

      <ProductEditForm product={product} categories={categories} />

      {/* 规格矩阵与 SKU 价格表。两者都是 'use client'，逻辑全在各自组件内部，
          这里只往下传数据——Server → Client 传函数在 tsc 与 next build 下都能过，
          只有真正渲染这一页时才 500。规格编辑器的乐观锁版本自持，
          保存成功后自己 +1 并 router.refresh()。 */}
      <SpecMatrixEditor
        productId={product.id}
        version={product.version}
        specs={product.specs}
      />

      <SkuPriceTable productId={product.id} skus={product.skus} specs={product.specs} />

      {/* 商品图片。MediaUploader 是 'use client'，签发凭证 → 浏览器直传 MinIO
          → confirm → 写回有序列表的整套流程都在它内部，这里只传数据。
          顺序在保存时整份 PUT 回后端（PUT /catalog/products/:id/media），
          不与规格矩阵共享乐观锁——媒体没有 version 字段。 */}
      <MediaUploader productId={product.id} initial={resolvedMedia} />
      {mediaLoadFailed && (
        <p className="text-sm text-destructive">
          图片列表加载失败，上传与排序暂时不可用（商品的其它信息不受影响）。
        </p>
      )}
    </div>
  );
}

/** GET /media 列表的一页 */
interface MediaListResponse {
  items: Array<{ id: string; url: string; deletedAt: string | null }>;
  total: number;
  page: number;
  pageSize: number;
}

/** 翻页上限。一个商品最多 20 张图，翻 5 页（500 条）足够找到它们。 */
const MEDIA_LOOKUP_MAX_PAGES = 5;

/**
 * 把商品的 media 关联行解析成「带 url 的有序图片列表」。
 *
 * 返回 `{ items, failed }`：failed 表示**连媒体列表都拉不到**
 * （后端挂了 / 网络问题），此时 items 为空。找不到 url 的单张图会被跳过，
 * 不算 failed——那说明这张图确实已经不在媒体表里了，商家该看到的是少一张图。
 */
async function resolveMedia(entries: ProductDetail['media']): Promise<{
  items: ResolvedMediaItem[];
  failed: boolean;
}> {
  if (entries.length === 0) {
    return { items: [], failed: false };
  }

  const wanted = new Set(entries.map((entry) => entry.mediaId));
  const urlById = new Map<string, string>();

  try {
    for (let page = 1; page <= MEDIA_LOOKUP_MAX_PAGES; page += 1) {
      const result = await apiFetchAuthed<MediaListResponse>(
        `/media?page=${page}&pageSize=100`,
      );
      for (const media of result.items) {
        if (wanted.has(media.id) && media.deletedAt === null) {
          urlById.set(media.id, media.url);
        }
      }
      // 找齐了就停，不必把整个媒体表翻完。
      if (urlById.size === wanted.size) break;
      if (result.items.length < result.pageSize) break;
    }
  } catch {
    return { items: [], failed: true };
  }

  // 按 sort 升序输出——sort 就是封面顺序，第一个是封面。
  const items = entries
    .slice()
    .sort((a, b) => a.sort - b.sort)
    .map((entry) => ({ id: entry.mediaId, url: urlById.get(entry.mediaId) }))
    .filter((item): item is ResolvedMediaItem => typeof item.url === 'string');

  return { items, failed: false };
}

/** 面包屑 + 返回列表 */
function Breadcrumb() {
  return (
    <nav className="flex items-center gap-2 text-sm text-muted-foreground">
      <Link href="/products" className="underline-offset-4 hover:underline">
        商品
      </Link>
      <span aria-hidden>›</span>
      <span>编辑</span>
    </nav>
  );
}