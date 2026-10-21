import { AsyncLocalStorage } from 'node:async_hooks';
import { UserRole } from '@prisma/client';

/**
 * 租户上下文：HTTP 请求的租户范围靠它传给隔离版 PrismaClient。
 *
 * ⚠️ 最关键的一条约束：所有 `tenantContext.run(...)` 的回调**必须是 async 函数**。
 *
 * 原因：Prisma 6 的 query 调用返回的是 PrismaPromise（thenable 而非原生 Promise），
 * 真正的 SQL 执行发生在它的 then() 被调用时。AsyncLocalStorage 只能沿**原生 Promise**
 * 的 then 链传播上下文；回调是同步函数时，它返回的 thenable 在被 await 的那一刻
 * 已经脱离 run() 的作用域，getStore() 返回 undefined，租户上下文整个丢失——
 * 隔离机制会**静默失效**，不会抛错。不要为了「少写个 async」把它改成同步回调。
 *
 * 上下文只存在于当前异步调用链内。跨越进程边界的地方（队列消费者、定时任务、
 * 消息处理器）没有上下文可用，必须显式重建，用 `runForTenant()`；
 * 忘了重建就会在查租户作用域模型时抛 TenantScopeError（响亮失败，不会静默泄露）。
 *
 * 作用域栈语义：
 * - `run(ctx, fn)` 进入时**替换**当前上下文，`fn` 完成后**自动还原**调用前的上下文
 * - 因此可以安全地嵌套：外层租户作用域 → 内层平台作用域 → 出内层自动回到租户作用域
 * - 但不要在 `run()` 回调内依赖回调之外的服务层上下文
 * - 跨进程边界（队列消费者、定时任务）完全没有上下文，必须用 `runForTenant()` 显式重建
 */

export interface TenantContextValue {
  /** 当前租户 ID；null 表示平台作用域（仅 platform_admin 可用） */
  tenantId: string | null;
  /** 当前登录用户 ID；匿名请求为 null */
  userId: string | null;
  /** 当前用户角色；匿名请求为 null */
  role: UserRole | null;
}

export const tenantContext = new AsyncLocalStorage<TenantContextValue>();

export function getTenantContext(): TenantContextValue {
  const context = tenantContext.getStore();
  if (!context) {
    throw new Error('租户上下文不存在：请求未经过 TenantContextInterceptor');
  }
  return context;
}

/** 是否处于显式的平台作用域（可跨租户读） */
export function isPlatformScope(
  context: TenantContextValue | undefined,
): boolean {
  return (
    !!context &&
    context.tenantId === null &&
    context.role === UserRole.PLATFORM_ADMIN
  );
}

/**
 * 显式的平台作用域上下文。
 *
 * 跨租户读取必须显式调用本函数包裹，把跨租户行为收敛到可审计的少数几处。
 * 目前的使用点：登录时按邮箱跨租户查账号、JWT 验签后按 ID 查用户、
 * 按子域名公开查询店铺。
 */
export function platformScope(): TenantContextValue {
  return { tenantId: null, userId: null, role: UserRole.PLATFORM_ADMIN };
}

/**
 * 在指定租户的上下文里执行一段逻辑。
 *
 * ⚠️ 它**不是万能的上下文重建入口**，边界很窄：
 * - 只用于**单一租户**的上下文重建。要进平台作用域（跨租户读）请直接
 *   `tenantContext.run(platformScope(), ...)`，不要试图用 `tenantId: null` 变通。
 * - 队列任务里的 `tenantId` **必须来自可信源**：任务由已认证的后端创建，
 *   绝不能取自客户端提交的内容——否则「重建上下文」本身就成了越权通道。
 * - 跨进程任务的 `tenantId` 由创建方签发，消费者重建时应当校验它与创建时一致。
 *
 * 存在的理由：AsyncLocalStorage 的上下文只存在于当前异步调用链内。
 * 跨越进程边界的地方（队列消费者、定时任务、消息处理器）完全没有上下文，
 * 此时必须显式重建，否则查租户作用域模型会抛 TenantScopeError。
 *
 * 回调必须是返回 Promise 的函数——Prisma 6 的 PrismaPromise 是 thenable，
 * 同步回调会导致上下文在查询执行时丢失、隔离机制静默失效。
 */
export function runForTenant<T>(
  tenantId: string,
  fn: () => Promise<T>,
  extra?: { userId?: string | null; role?: UserRole | null },
): Promise<T> {
  return tenantContext.run(
    {
      tenantId,
      userId: extra?.userId ?? null,
      role: extra?.role ?? null,
    },
    async () => fn(),
  );
}
