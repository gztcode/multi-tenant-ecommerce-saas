import { SetMetadata } from '@nestjs/common';

export const PUBLIC_KEY = 'public:auth';

/**
 * 标记该路由允许匿名访问。
 *
 * 与 @Skip() 的区别是**只放行身份认证，不跳过租户上下文**：
 * 租户上下文拦截器照常从子域名解析租户，因此公开读到的数据
 * 仍然经过租户隔离机制（Prisma 扩展自动附加 where.tenantId）。
 *
 * 适用：商品浏览、店铺公开信息这类「数据本来公开、但仍需按店铺隔离」的端点。
 *
 * ⚠️ 使用前提：挂 @Public() 的端点**只能返回公开数据**。
 * 若在公开端点上查本租户的数据（如订单），攻击者可以用伪造的
 * X-Tenant-Subdomain 头读到别人的数据——那时必须把端点挪到需要认证的路径上。
 */
export const Public = () => SetMetadata(PUBLIC_KEY, true);
