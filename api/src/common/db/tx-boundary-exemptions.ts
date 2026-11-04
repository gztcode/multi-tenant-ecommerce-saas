import type { TxBoundaryExemption } from './tx-boundary-scanner';

/**
 * 已登记的、无法消除的借用点。
 *
 * ⚠️ **新增条目必须写清 `why`** —— 护栏要让「没有理由的例外」无法存在。
 *    将来有人想改它时，会先看到当初不能改的理由。
 *
 * ⚠️ **锚点用「文件 + 方法名 + 表达式」，不用行号**：
 *    行号会随任何改动漂移，豁免会莫名其妙失效（或误放行）。
 *
 * ⚠️ **当前清单为空**：阶段 10 初稿曾把「平台券查询」列为豁免项，
 *    理由是「事务客户端 tx 没有租户扩展」—— **实测证明这个前提是错的**：
 *    Prisma 6 的 `defineExtension` 扩展会应用到交互事务客户端，
 *    平台作用域在 tx 上完全生效（探针：事务内 + 平台作用域 + tx 的扩展
 *    拦截 scope 判定与 where 条件，与普通 client 完全一致）。
 *    `coupon.service.ts` 的 `findClaimableCoupon` 早有「平台券走 tx」的先例。
 *    所以 9 个根因全部修掉了，没有例外。
 */
export const TX_BOUNDARY_EXEMPTIONS: readonly TxBoundaryExemption[] = [];
