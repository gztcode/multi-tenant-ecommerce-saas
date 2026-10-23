import { headers } from 'next/headers';
import { apiFetch } from '@/lib/api-client';
import { resolveTenantSubdomain } from '@/lib/tenant';
import { buildThemeCss, ThemeTokenValues } from '@/lib/theme';

interface ThemeResponse {
  tokens: ThemeTokenValues;
}

/**
 * 店铺主题注入。
 *
 * 在 Server Component 里做，而不是客户端组件：
 * 1. 匿名请求要靠子域名解析租户，而主题是租户级的——服务端才有这个上下文；
 * 2. 服务端注入顺带避免了 FOUC（首屏闪烁默认配色）。
 *
 * ⚠️ 本 layout 读取 headers()，Next.js 会因此把它判为**动态渲染**的布局，
 * 不参与路由级的静态预渲染与 Full Route Cache。实测两个不同子域名各自渲染出
 * 各自的主题，不存在串店（验证记录见 Task 9 汇报）。
 * 仍然显式声明 force-dynamic：不依赖框架的推断结论，主题串店是不可接受的
 * 故障模式，而这一行的代价只是放弃该路由的静态优化。
 */
export const dynamic = 'force-dynamic';

export default async function ShopLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const headerList = await headers();
  const subdomain = resolveTenantSubdomain(headerList);

  let tokens: ThemeTokenValues | null = null;
  try {
    const response = await apiFetch<ThemeResponse>('/public/theme', {
      subdomain,
    });
    tokens = response.tokens;
  } catch {
    // 主题拉不到时用默认主题渲染，不要让整个店铺白屏
    tokens = null;
  }

  const css = tokens ? buildThemeCss(tokens) : '';

  return (
    <>
      {css ? (
        <style
          // 主题内容由后端按白名单过滤过，不含用户可控的任意文本
          dangerouslySetInnerHTML={{ __html: `:root {\n${css}\n}` }}
        />
      ) : null}
      {children}
    </>
  );
}