import { ImportPanel } from '@/components/product/import-panel';

/**
 * CSV 导入商品页（Server Component）。
 *
 * 全部逻辑在 ImportPanel（'use client'）里，这里只渲染标题与说明——
 * Server → Client 传事件处理器在 tsc 与 next build 下都能过，
 * 只有真正渲染这一页时才 500，所以这一层刻意什么都不传。
 */
export default function ProductImportPage() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-bold">CSV 导入商品</h2>
        <p className="text-sm text-muted-foreground">
          只支持商品基础信息。规格矩阵与图片请在商品编辑页单独维护——
          用扁平表格表达规格结构会立刻变得不可读。
        </p>
      </div>

      <ImportPanel />
    </div>
  );
}