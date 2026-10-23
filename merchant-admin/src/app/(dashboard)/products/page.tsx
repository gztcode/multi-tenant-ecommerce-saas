import { Suspense } from 'react';
import Link from 'next/link';
import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import { ProductList, type ProductRow } from '@/components/product/product-list';

/**
 * 商品列表页（Server Component）。
 *
 * 列表数据在服务端取（apiFetchAuthed 走 session 里的 accessToken），
 * 组件只负责渲染表格与勾选、批量操作。
 */
interface ProductListResponse {
  items: ProductRow[];
  total: number;
  page: number;
  pageSize: number;
}

interface CategoryNode {
  id: string;
  name: string;
  children: CategoryNode[];
}

/** 把品类树摊平成一维，供下拉筛选与「按 id 显示名字」用 */
function flattenCategories(nodes: CategoryNode[]): Array<{ id: string; name: string }> {
  return nodes.flatMap((node) => [
    { id: node.id, name: node.name },
    ...flattenCategories(node.children),
  ]);
}

/**
 * 只接受后端认识的状态值。
 *
 * status 从查询串来，是用户可控的；不校验的话 `?status=FOO` 会被原样发给后端，
 * 后端 @Query 上的 ProductStatus 枚举转换失败会 400，页面只剩一句
 * 「商品加载失败」，看不出是自己拼错了参数。
 */
const STATUS_VALUES = ['DRAFT', 'PUBLISHED', 'UNPUBLISHED'] as const;

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{
    keyword?: string;
    status?: string;
    categoryId?: string;
    page?: string;
  }>;
}) {
  const { keyword, status, categoryId, page } = await searchParams;

  const params = new URLSearchParams();
  if (keyword) params.set('keyword', keyword);
  if (status && (STATUS_VALUES as readonly string[]).includes(status)) {
    params.set('status', status);
  }
  if (categoryId) params.set('categoryId', categoryId);
  if (page) params.set('page', page);
  const suffix = params.toString();

  let data: ProductListResponse | null = null;
  let error: string | null = null;

  try {
    data = await apiFetchAuthed<ProductListResponse>(
      `/catalog/products${suffix ? `?${suffix}` : ''}`,
    );
  } catch (cause) {
    error =
      cause instanceof ApiError
        ? `加载商品失败（${cause.status}）：${cause.message}`
        : cause instanceof Error
          ? cause.message
          : '商品加载失败';
  }

  // 品类树独立取一次：后端商品列表只回 categoryId（没有嵌套的 category 对象），
  // 名字得自己映射。品类取不到不影响主列表，只让「品类」列显示成 —。
  let categories: Array<{ id: string; name: string }> = [];
  try {
    categories = flattenCategories(await apiFetchAuthed<CategoryNode[]>('/catalog/categories'));
  } catch {
    categories = [];
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">商品</h2>
        <div className="flex gap-2">
          {/* download 属性让浏览器把响应存成文件而不是导航过去。
              中转自己已经带了 content-disposition: attachment，
              这个属性只是双保险（跨浏览器行为更一致）。 */}
          <Link
            href="/api/products/export"
            download="products.csv"
            className="rounded-md border px-3 py-1.5 text-sm"
          >
            导出 CSV
          </Link>
          <Link href="/products/import" className="rounded-md border px-3 py-1.5 text-sm">
            CSV 导入
          </Link>
          <Link
            href="/products/new"
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
          >
            新建商品
          </Link>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {data && (
        // ProductList 里用了 useSearchParams：Next.js 要求它外面包一层
        // <Suspense>，否则整页在构建时会报「useSearchParams() should be
        // wrapped in a suspense boundary」。
        <Suspense fallback={null}>
          <ProductList
            initial={data.items}
            total={data.total}
            page={data.page}
            pageSize={data.pageSize}
            categories={categories}
          />
        </Suspense>
      )}
    </div>
  );
}