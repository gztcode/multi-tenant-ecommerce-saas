/**
 * 商品编辑相关的共享类型。
 *
 * 单独成文件而不是塞进页面或某个组件：编辑页（Server Component）、基本信息表单、
 * 以及后续的规格矩阵编辑器 / SKU 价格表都要用同一份形状。
 * 三处各写一遍 interface 迟早会漂移——某一处少写个字段，
 * TypeScript 不会报错（结构类型只要求「至少这么多」），
 * 而缺失的字段在运行时表现为「详情页上这个值是 undefined」。
 */

export type ProductStatus = 'DRAFT' | 'PUBLISHED' | 'UNPUBLISHED';
export type SkuStatus = 'ACTIVE' | 'INACTIVE';

/** 描述性属性：材质、产地这类不决定 SKU 组合的参数 */
export type ProductAttributes = Record<string, string>;

/** GET /catalog/products/:id 的返回（只列编辑页关心的字段） */
export interface ProductDetail {
  id: string;
  name: string;
  slug: string;
  subtitle: string | null;
  description: string | null;
  status: ProductStatus;
  version: number;
  attributes: ProductAttributes;
  categoryId: string | null;
  specs: ProductSpec[];
  skus: ProductSku[];
  media: ProductMediaEntry[];
}

export interface ProductSpec {
  id: string;
  name: string;
  values: Array<{ id: string; value: string }>;
}

export interface ProductSku {
  id: string;
  price: number;
  comparePrice: number | null;
  code: string | null;
  status: SkuStatus;
  specValues: Array<{ valueId: string }>;
}

/**
 * 商品详情里的 media 数组项（ProductMedia 关联行）。
 *
 * ⚠️ **这里没有嵌套的 media 对象**，只有 `mediaId`：
 * 后端 `products.service.ts` 的 findOne 写的是
 * `media: { where: { media: { deletedAt: null } }, orderBy: { sort: 'asc' } }`
 * ——那是在**过滤和排序** ProductMedia 关联，并没有 `include: { media: true }`，
 * 所以返回的每项只有 id / mediaId / sort，拿不到图片 url。
 *
 * 之前这里声明成 `{ media: { id; url; mime } }` 是照着「关系会嵌套返回」想当然
 * 写的，TypeScript 不会报错（运行时 undefined 照样满足结构类型），
 * 结果商品编辑页一渲染就 500（Cannot read properties of undefined）。
 *
 * 需要 url 时由编辑页另外拉 GET /media 列表，按 mediaId 关联（见 page.tsx）。
 */
export interface ProductMediaEntry {
  id: string;
  mediaId: string;
  sort: number;
}

/** MediaUploader 用的、url 已解析好的图片 */
export interface ResolvedMediaItem {
  /** Media 的 id（写回后端用的是它） */
  id: string;
  url: string;
}

/** 品类树的一维摊平结果，供下拉框与「按 id 显示名字」用 */
export interface CategoryOption {
  id: string;
  name: string;
}

export const PRODUCT_STATUS_LABEL: Record<ProductStatus, string> = {
  DRAFT: '草稿',
  PUBLISHED: '已上架',
  UNPUBLISHED: '已下架',
};