import { apiFetch } from './api-client';

/** 公开商品列表的响应形状 */
export interface PublicProductList {
  items: PublicProductCard[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PublicProductCard {
  id: string;
  name: string;
  slug: string;
  subtitle: string | null;
  minPrice: number;
  publishedAt: string | null;
  category: { id: string; name: string; slug: string } | null;
  media: Array<{
    sort: number;
    media: { id: string; url: string; mime: string };
  }>;
}

export interface PublicProductDetail {
  id: string;
  name: string;
  slug: string;
  subtitle: string | null;
  description: string | null;
  attributes: Record<string, string>;
  minPrice: number;
  publishedAt: string | null;
  category: { id: string; name: string; slug: string } | null;
  media: PublicProductCard['media'];
  specs: Array<{
    id: string;
    name: string;
    sort: number;
    values: Array<{ id: string; value: string; sort: number }>;
  }>;
  skus: Array<{
    id: string;
    price: number;
    comparePrice: number | null;
    stock: number;
    specValues: Array<{ valueId: string }>;
  }>;
}

export interface PublicCategory {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  children: PublicCategory[];
}

/**
 * 公开商品接口的调用封装。
 *
 * ⚠️ 每个请求都必须带 subdomain——匿名请求靠子域名定位租户，
 * 而容器内直连 api 的 Host 是服务名，解析不出子域名。
 */
export async function fetchPublicProducts(
  subdomain: string,
  query: Record<string, string | number | undefined> = {},
): Promise<PublicProductList> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') {
      params.set(key, String(value));
    }
  }
  const suffix = params.toString();
  return apiFetch<PublicProductList>(
    `/public/products${suffix ? `?${suffix}` : ''}`,
    { subdomain },
  );
}

export async function fetchPublicProduct(
  subdomain: string,
  slug: string,
): Promise<PublicProductDetail> {
  return apiFetch<PublicProductDetail>(`/public/products/${slug}`, {
    subdomain,
  });
}

export async function fetchPublicCategories(
  subdomain: string,
): Promise<PublicCategory[]> {
  return apiFetch<PublicCategory[]>('/public/categories', { subdomain });
}