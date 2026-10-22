import { SetMetadata } from '@nestjs/common';

export const SKIP_KEY = 'skip:interceptors';

/**
 * 标记该路由不经过租户上下文拦截器（健康检查等公共端点）。
 *
 * ⚠️ 与 @Public() 语义严格分离，不要混用：
 * - @Skip()：**不建立租户上下文**。只适用于完全不碰租户作用域模型的端点
 *   （如健康检查）。用在需要查业务表的地方会直接 500——
 *   隔离机制是 fail-closed 的，缺上下文时扩展会抛 TenantScopeError。
 * - @Public()：建立租户上下文（从子域名解析），只是不做身份认证。
 *   商品浏览这类「匿名但要按店铺隔离」的端点用它。
 */
export const Skip = () => SetMetadata(SKIP_KEY, true);
