import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import { CategoryManager } from '@/components/product/category-manager';

/**
 * 品类页（Server Component）。
 *
 * 树在服务端取：品类是首屏就要看的数据，走后端渲染免掉一次客户端瀑布，
 * 而且创建/改名/删除后客户端只要 router.refresh() 就会重新走这里，
 * 不需要自己维护一份树的副本。
 */
interface CategoryNode {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  sort: number;
  children: CategoryNode[];
}

export default async function CategoriesPage() {
  let tree: CategoryNode[] = [];
  let error: string | null = null;

  try {
    tree = await apiFetchAuthed<CategoryNode[]>('/catalog/categories');
  } catch (cause) {
    error =
      cause instanceof ApiError
        ? `加载品类失败（${cause.status}）：${cause.message}`
        : cause instanceof Error
          ? cause.message
          : '品类加载失败';
  }

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-bold">品类</h2>
      <p className="text-sm text-muted-foreground">
        层级最多 3 层，由后端校验；有子品类或商品的品类删不掉。
        slug 参与前台 URL，创建后不可修改。
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <CategoryManager initial={tree} />
    </div>
  );
}