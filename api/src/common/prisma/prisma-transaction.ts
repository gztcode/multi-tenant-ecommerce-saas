import type { TenantPrismaService } from '../tenant/tenant-prisma.service';

/**
 * 事务客户端的类型：就是 `prisma.$transaction(async (tx) => ...)` 的回调参数类型。
 *
 * 从 TenantPrismaService 上 `Omit` 一个同形类型行不通，有两个原因：
 * 1. `$transaction` 有数组与回调两个重载，从它反解回调参数需要经过一层
 *    Parameters 索引，写出来比它省下的还多；
 * 2. TenantPrismaService 上没有 `$executeRaw`/`$queryRaw`——阶段 1 刻意把这几个
 *    原生 SQL 方法从 Service 上摘掉了（见该类的类注释）。而事务里的 tx 是真正的
 *    扩展 client，原生 SQL 方法是有的（它们不经过扩展，也就绕过了扩展——
 *    所以租户条件必须在这条 SQL 里手写）。
 * 所以直接向编译器要 tx 自己的类型，签名更短也不会说谎。
 *
 * 放在 common/prisma 下而不是 common/tenant 下：它是 **Prisma 事务客户端**的类型，
 * 与租户无关——租户隔离由 Prisma 扩展负责，事务客户端本身只是个普通 client。
 * （放在 common/tenant/ 下会让人误以为「事务客户端天然带租户作用域」。）
 *
 * 放在 common 下是因为**交易链路与商品中心都要用**它：
 * 商品中心用它更新最低价，交易链路用它做行锁与库存扣减。
 */
export type PrismaTransaction = Parameters<
  Parameters<TenantPrismaService['$transaction']>[0]
>[0];
