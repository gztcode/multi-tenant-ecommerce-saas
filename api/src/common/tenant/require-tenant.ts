import { ForbiddenException } from '@nestjs/common';
import { getTenantContext } from './tenant-context';

/**
 * 取当前租户 id；拿不到就 403。
 *
 * ⚠️ 这里统一的是 **service 层**的语义（已认证但上下文里没有 tenantId，
 * 通常是角色越界调到了租户接口）——匿名请求解析不到子域名的 404
 * 是 TenantContextInterceptor 的职责（文案「无法确定店铺，请通过店铺子域名访问」），
 * 那条路径 e2e 有精确断言，本函数绝不改变它。
 *
 * ⚠️ **「上下文完全不存在」不在本函数的管辖内**：那种情况
 * `getTenantContext()` 自己抛普通 Error（→ 500，通常是队列消费者
 * 忘了 `runForTenant()` 重建作用域）。本函数只管「上下文在、但里面没有
 * tenantId」这一种情况 → 403。
 */
export function requireTenantId(): string {
  const { tenantId } = getTenantContext();
  if (!tenantId) {
    throw new ForbiddenException('无法确定店铺');
  }
  return tenantId;
}
