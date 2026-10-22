import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantPrismaService } from '../../../common/tenant/tenant-prisma.service';

/**
 * 事务客户端的类型：就是 `prisma.$transaction(async (tx) => ...)` 的回调参数类型。
 *
 * 从 TenantPrismaService 上 `Omit` 一个同形类型行不通，有两个原因：
 * 1. `$transaction` 有数组与回调两个重载，从它反解回调参数需要经过一层
 *    Parameters 索引，写出来比它省下的还多；
 * 2. TenantPrismaService 上没有 `$executeRaw`——阶段 1 刻意把这几个原生 SQL
 *    方法从 Service 上摘掉了（见该类的类注释）。而事务里的 tx 是真正的扩展
 *    client，$executeRaw 是有的（它不经过扩展，也就绕过了扩展——所以租户条件
 *    必须在这条 SQL 里手写）。
 * 所以直接向编译器要 tx 自己的类型，签名更短也不会说谎。
 */
export type PrismaTransaction = Parameters<
  Parameters<TenantPrismaService['$transaction']>[0]
>[0];

/**
 * 商品最低价的维护。
 *
 * `Product.minPrice` 是**派生字段**：真实价格在 SKU 上，商品本身没有价格。
 * 之所以冗余它，是因为 Prisma 不支持按关系字段排序
 * （`orderBy: { skus: { price: 'asc' } }` 不可用），而按价格排序是商品列表
 * 最常用的排序方式。绕过去的唯一办法是原生 SQL——那会绕过整个 Prisma 扩展，
 * 等于手写隔离条件，是阶段 1 花了大力气避免的事。
 *
 * 价格区间筛选也用它，与排序共用同一个字段，保证「筛选后」与「排序后」
 * 的语义一致（都用商品最低价）。
 *
 * ⚠️ 维护规则：
 * 1. 只有 ACTIVE 且未删除的 SKU 参与计算；
 * 2. 重算与价格写入必须在同一事务内；
 * 3. 重算用一条 SQL 完成，不在应用层循环 SKU。
 */
/**
 * 无状态服务：不注入 prisma。
 *
 * recalculate 只用调用方传进来的 tx —— 注入一个用不到的 client 既会让人误以为
 * 「这个方法也可以自己开事务跑」（那就丢掉了「与价格写入同事务」这条硬要求），
 * 也会给 DI 图添一条多余的边。
 */
@Injectable()
export class MinPriceService {
  /**
   * 重算指定商品的最低价。
   *
   * 必须在调用方的事务内执行（传入同一个 tx），
   * 否则会出现「价格已改、最低价还是旧值」的中间态被读到的窗口。
   *
   * ⚠️ `$executeRaw` **绕过了 Prisma 扩展**——扩展只作用于 Prisma 的模型
   * 查询，裸 SQL 不经过它。所以租户条件必须在这条 SQL 里手写：
   * 子查询的 `tenantId` 与外层的 `p.tenantId` 都要有。
   * 漏掉任何一处，跨租户改价就会污染别人的商品最低价。
   *
   * ⚠️ 列名是 **camelCase 且必须加双引号**：schema 里只有 `@@map` 把表名映成了
   * `products` / `skus`，字段本身没有 `@map`，所以列名就是 `"productId"`、
   * `"tenantId"`、`"minPrice"`、`"deletedAt"`。两个坑叠在一起——
   *   1. 写 snake_case（`product_id`）会报 42703 column does not exist；
   *   2. 写 camelCase 但不加引号，Postgres 会把未加引号的标识符折叠成小写，
   *      报的是 42703 column "productid" does not exist——字面上完全看不出
   *      「你只是少了一对引号」。
   * 表名 `products` / `skus` 全小写，不加引号反而是对的。
   *
   * 顺带一提：这条 SQL 里的 `${tenantId}` / `${Prisma.join(...)}` 是参数化
   * 占位符，值不会被拼进 SQL 文本，所以不存在注入面。
   */
  async recalculate(
    tx: PrismaTransaction,
    tenantId: string,
    productIds: string[],
  ): Promise<void> {
    if (productIds.length === 0) return;

    // 用相关子查询而不是 UPDATE ... FROM (SELECT ... GROUP BY)：
    // 后者在「该商品没有任何 ACTIVE 的 SKU」时子查询无行，**整条 UPDATE 都不会
    // 命中该商品**，`minPrice` 就卡在旧值上。而这恰恰是规格清空或规格缩减到
    // 一个都没有时的真实状态——商品对外会显示一个买家根本买不到的价格。
    //
    // COALESCE(MIN(...), 0) 处理「没有 ACTIVE SKU」：没有可售变体时最低价就是 0。
    await tx.$executeRaw`
      UPDATE products p
      SET "minPrice" = COALESCE((
        SELECT MIN(price) FROM skus
        WHERE "productId" = p.id
          AND "tenantId" = ${tenantId}
          AND status = 'ACTIVE'
          AND "deletedAt" IS NULL
      ), 0)
      WHERE p.id IN (${Prisma.join(productIds)}) AND p."tenantId" = ${tenantId}
    `;
  }
}
