/**
 * 交互事务（`$transaction(async (tx) => ...)`）的公共选项（阶段 9）。
 *
 * ⚠️ 默认 **10 秒**（Prisma 自带默认只有 5 秒）：行锁等待会吃掉这个预算，
 *    收得太紧会让正常排队的事务被误判成过期。
 *
 * ⚠️ **`PRISMA_TX_TIMEOUT_MS` 是慢环境的逃生口，不是业务参数**：
 *    CI 的 2 核 runner 上，5 个并发下单会在同一行 SKU 锁上排队，
 *    最后一个事务可能超过 10 秒（Prisma 报 `P2028`）。
 *    生产不设这个变量，行为与原来完全一致。
 */
export function transactionOptions(): { maxWait: number; timeout: number } {
  const raw = Number(process.env.PRISMA_TX_TIMEOUT_MS);
  const timeout = Number.isFinite(raw) && raw > 0 ? raw : 10_000;
  return { maxWait: timeout, timeout };
}
