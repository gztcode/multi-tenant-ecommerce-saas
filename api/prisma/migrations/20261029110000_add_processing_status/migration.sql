-- 阶段 5h-2：给 PayoutStatus 枚举补上 PROCESSING
--
-- ⚠️ **单独一个迁移文件**，不改 `20261029100000_add_payout_execution` ——
--    那个文件已经被 `prisma migrate resolve --applied` 登记过，
--    改它会让 `_prisma_migrations` 的 checksum 失配。
--
-- ⚠️ **为什么需要它**：阶段 5h-1 的 `PayoutStatus` 只有
--    REQUESTED / APPROVED / REJECTED / CANCELLED / PAID / FAILED，
--    没有「打款中」这个状态 —— 而 5h-2 的整个状态机
--    （APPROVED → PROCESSING → PAID / FAILED / APPROVED）都依赖它。
--
-- ⚠️ **PG 12+ 允许 `ALTER TYPE ... ADD VALUE` 在事务块里跑**
--    （`prisma migrate deploy` 会把每个迁移包进一个事务），
--    但**新增的枚举值不能在同一个事务里被使用** ——
--    本文件只加值、不用它，所以没问题。

-- AlterEnum
ALTER TYPE "PayoutStatus" ADD VALUE IF NOT EXISTS 'PROCESSING';
