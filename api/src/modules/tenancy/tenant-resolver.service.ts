import { Injectable, NotFoundException } from '@nestjs/common';
import { Tenant, TenantStatus } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import {
  isValidSubdomain,
  RESERVED_SUBDOMAINS,
} from '../../common/tenant/tenant-models';

/**
 * 判断 host 是否不可能承载店铺子域名。
 *
 * 裸 IPv4、IPv6、本机名都不含子域名——本地直连、容器间调用、
 * 负载均衡健康检查都会走这些 host，如果照常「取第一个点号段」，
 * `127.0.0.1:3000` 会被解析成子域名 `127` 并白白查一次租户表。
 */
function isHostWithoutSubdomain(hostname: string): boolean {
  if (hostname === 'localhost') return true;
  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true;
  // IPv6：含冒号（含方括号包裹形式 [::1]，此时不带端口也走不到这里）
  if (hostname.includes(':')) return true;
  return false;
}

/**
 * 读取显式的子域名头。
 *
 * ⚠️ 该头由**网关/内部服务**写入（从 Host 反推后注入），不是给客户端用的。
 * 客户端可以自行设置这个头，而子域名只是路由标识、不是凭证——
 * 猜到别人的子域名就能以那个租户的身份发起请求。
 * 因此真正的访问控制必须来自认证，而不是这个头；
 * 网关侧必须先剥除客户端传来的同名头再注入自己的值。
 *
 * 返回值三态：
 * - undefined：未提供该头，调用方应回退到 Host 解析
 * - null：请求异常（重复头、逗号合并），调用方应直接拒绝
 * - string：解析出的子域名
 *
 * 显式处理数组是必要的：Node 对重复头会合并成逗号字符串或数组两种形式，
 * 只判断 `typeof === 'string'` 会让数组悄悄回退到 Host 解析，行为不可预测。
 */
function readExplicitSubdomain(
  headers: Record<string, string | string[] | undefined>,
): string | null | undefined {
  const raw = headers['x-tenant-subdomain'];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' && !Array.isArray(raw)) return null;

  const values = (typeof raw === 'string' ? [raw] : raw)
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v.length > 0);

  // 没有任何有效值：当作未提供，交给 host 解析
  if (values.length === 0) return undefined;
  // 多个值（重复头或逗号合并后被拆开）说明请求异常，直接拒绝
  if (values.length > 1) return null;

  const [only] = values;
  return only.includes(',') ? null : only;
}

@Injectable()
export class TenantResolverService {
  constructor(private readonly prisma: TenantPrismaService) {}

  /**
   * 根据子域名解析租户。
   * 注意：租户表本身不是租户作用域模型，此处查询不经过隔离扩展。
   */
  async resolveBySubdomain(subdomain: string): Promise<Tenant> {
    const normalized = subdomain.trim().toLowerCase();
    if (!normalized) {
      throw new NotFoundException('未指定店铺子域名');
    }

    // 这里也要挡保留字，不能只依赖 extractSubdomain：
    // 本方法是 public，可能被绕过 extractSubdomain 直接调用
    // （例如 storefront 的公开店铺查询）。
    // 措辞刻意与「店铺不存在」一致，避免形成「已保留 vs 未注册」的侧信道。
    if (RESERVED_SUBDOMAINS.has(normalized)) {
      throw new NotFoundException('店铺不存在');
    }

    const tenant = await this.prisma.tenant.findFirst({
      where: { subdomain: normalized },
    });

    // 错误信息一律不回显用户输入：子域名来自 Host 头，是不可信输入，
    // 原样回显等于把未转义的内容塞进响应体。
    if (!tenant) {
      throw new NotFoundException('店铺不存在');
    }
    if (tenant.status === TenantStatus.SUSPENDED) {
      throw new NotFoundException('店铺已被暂停');
    }

    return tenant;
  }

  /**
   * 从请求头或 host 中提取子域名；无法确定时返回 null。
   *
   * 优先级：`X-Tenant-Subdomain` 显式头 > Host 解析。
   * 让显式头优先，是为了支持**内部调用**：storefront 的服务端渲染请求由内部服务发起，
   * 手上没有可用的店铺 Host（服务到服务的请求不经过浏览器的域名跳转），
   * 必须显式指定租户。
   *
   * ⚠️ 这不代表该头是可信的。子域名是路由标识、不是凭证——
   * 任何客户端都能设置它，猜到别人的子域名就能以那个租户的身份发起请求。
   * 网关必须剥除客户端传来的同名头再注入自己的值；访问控制来自认证。
   */
  static extractSubdomain(
    headers: Record<string, string | string[] | undefined>,
    host: string | undefined,
  ): string | null {
    const explicit = readExplicitSubdomain(headers);
    if (explicit === null) return null;
    if (explicit !== undefined) {
      if (!isValidSubdomain(explicit)) return null;
      return RESERVED_SUBDOMAINS.has(explicit) ? null : explicit;
    }

    if (!host) return null;

    // IPv6 的 Host 形如 `[::1]:3000`，先剥掉方括号与端口再判断
    let hostname = host.trim().toLowerCase();
    if (hostname.startsWith('[')) {
      const end = hostname.indexOf(']');
      hostname = end === -1 ? hostname : hostname.slice(1, end);
    } else {
      hostname = hostname.split(':')[0];
    }
    if (!hostname) return null;
    if (isHostWithoutSubdomain(hostname)) return null;

    // 形如 <tenant>.platform.test / <tenant>.localhost / <tenant>.example.com
    const parts = hostname.split('.');
    if (parts.length < 2) return null;

    const candidate = parts[0];
    if (!isValidSubdomain(candidate)) return null;
    // 保留子域名一律按「无法确定店铺」处理，且不查库。
    // 错误措辞与「租户不存在」完全一致，攻击者无法通过响应差异
    // 判断某个子域名是被保留还是没人注册，从而枚举出商家目录。
    return RESERVED_SUBDOMAINS.has(candidate) ? null : candidate;
  }
}
