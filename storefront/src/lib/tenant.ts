/**
 * 店铺子域名解析。
 *
 * 独立成文件是为了让「页面渲染」和「登录」两条路径用**同一套**判断——
 * 之前登录读的是环境变量、页面读的是 host，两边不一致会导致
 * 「页面显示 A 店、登录却限定到 B 店」这种错位。
 */

/** 解析不出子域名时的兜底（本地开发用；生产应由网关注入该头） */
const FALLBACK_SUBDOMAIN = process.env.NEXT_PUBLIC_TENANT_SUBDOMAIN ?? 'demo';

/**
 * 判断 host 是否不可能承载店铺子域名。
 *
 * 与后端 `TenantResolverService` 的同名判断保持一致：裸 IPv4、IPv6、
 * localhost 都不含子域名，直接取第一段会得到 "127"、"1" 这类无意义值。
 */
function isHostWithoutSubdomain(hostname: string): boolean {
  if (hostname === 'localhost') return true;
  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true;
  // IPv6（含方括号包裹形式与压缩写法）
  if (hostname.includes(':')) return true;
  return false;
}

/** 从 host 里剥掉端口；IPv6 的 [::1]:3000 形式单独处理 */
function stripPort(host: string): string {
  const lowered = host.toLowerCase();
  if (lowered.startsWith('[')) {
    const end = lowered.indexOf(']');
    return end === -1 ? lowered : lowered.slice(1, end);
  }
  return lowered.split(':')[0];
}

/**
 * 从请求头解析店铺子域名。
 *
 * 优先用 `X-Tenant-Subdomain`（由网关从 Host 反推后注入，客户端设的不可信），
 * 其次从 Host 的第一段取。取不到时返回兜底值而不是 null：没有店铺身份的
 * 请求（例如中心域名上的登录）交由后端处理，前端不擅自拒绝。
 */
export function resolveTenantSubdomain(headers: {
  get(name: string): string | null;
}): string {
  const explicit = headers.get('x-tenant-subdomain')?.trim();
  if (explicit) {
    return explicit.toLowerCase();
  }

  const host = headers.get('host');
  if (!host) {
    return FALLBACK_SUBDOMAIN;
  }

  const hostname = stripPort(host);
  if (isHostWithoutSubdomain(hostname)) {
    return FALLBACK_SUBDOMAIN;
  }

  const parts = hostname.split('.');
  if (parts.length < 2) {
    return FALLBACK_SUBDOMAIN;
  }

  return parts[0];
}
