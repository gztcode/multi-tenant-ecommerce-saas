import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/route-helpers';
import { currentSubdomain, fetchBackend } from '@/lib/server-cart';
import type { ThemeTokenValues } from '@/lib/theme';

interface ThemeResponse {
  tokens: ThemeTokenValues;
}

/**
 * 主题查询的中转（给客户端的 ThemeWatcher 用）。
 *
 * ⚠️ 为什么要专门开一个中转而不是让浏览器直连后端：
 *    后端没开 CORS（设计上前端与 API 同源，由 Nginx 反代），
 *    浏览器直连会变成 Failed to fetch，且不带任何后端错误信息。
 *    同一个理由见 src/app/api/orders/route.ts 的说明。
 *
 * ⚠️ **租户从请求头解析**：匿名访客靠子域名定位租户，
 *    主题是租户级的——服务端才有这个上下文。
 *
 * ⚠️ **不缓存**：轮询本身已经是低频（30 秒），再加缓存就要处理失效，
 *    那会把复杂度推回「缓存失效广播」的老路。
 *
 * ⚠️ **响应头显式带 `cache-control: no-store`**：主题是最该实时的一类数据。
 *    不写的话，将来有人给 nginx 加 `proxy_cache` 就会出问题
 *    （缓存住的主题会一直生效，直到缓存过期）。
 *
 * ⚠️ **请求侧没有可透传的入参**：主题是租户级的单一资源，没有路径参数、
 *    没有查询参数、没有请求体。所以阶段 2b 确立的「白名单重建请求体」
 *    在这条路由上没有适用对象——**不要**加「原样透传查询串」之类的口子。
 */
export async function GET() {
  const subdomain = await currentSubdomain();

  try {
    const result = await fetchBackend<ThemeResponse>('/public/theme', {
      subdomain,
    });
    return NextResponse.json(result, {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
