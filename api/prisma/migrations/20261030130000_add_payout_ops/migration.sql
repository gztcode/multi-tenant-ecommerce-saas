-- ⚠️ **枚举必须先建**（PostgreSQL 的顺序要求：建表时要用到它）
CREATE TYPE "PayoutOperationAction" AS ENUM ('RETRY', 'UNSTUCK_TO_FAILED', 'UNSTUCK_TO_APPROVED');

-- ⚠️ **先加列再回填** —— 回填要用到这句业务口径
ALTER TABLE "payouts" ADD COLUMN IF NOT EXISTS "failedBeforePayout" BOOLEAN NOT NULL DEFAULT false;

-- ⚠️ **回填历史行**：这句业务口径有**两个**产生点 ——
--    ① `payout.worker.ts` 的解密失败分支（阶段 5k）；
--    ② `payout.worker.ts` 的 `checkGates` 账户缺失闸。
--    **两个都在调渠道之前**（渠道调用在 `provider.execute`）→ 确定没打 → 置 true。
--
-- ⚠️ **只回填这一句** —— 另一句「出款金额异常，本次未打款，请联系平台核对」
--    故意**不**置 true：金额非法是脏数据，重算大概率仍 ≤ 0 → 重试会 409，
--    置 true 只会让按钮出现后再被拒，体验更差。
UPDATE "payouts"
   SET "failedBeforePayout" = true
 WHERE "status" = 'FAILED'
   AND "failureReason" = '收款账号信息异常，本次未打款，请更新收款账户后重新申请';

CREATE TABLE IF NOT EXISTS "payout_operations" (
  "id" TEXT NOT NULL,
  "payoutId" TEXT NOT NULL,
  "action" "PayoutOperationAction" NOT NULL,
  "operatorId" TEXT NOT NULL,
  "operatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reason" TEXT NOT NULL,
  "fromStatus" "PayoutStatus" NOT NULL,
  "toStatus" "PayoutStatus" NOT NULL,
  "attemptCountBefore" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payout_operations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payout_operations_payoutId_fkey" FOREIGN KEY ("payoutId")
    REFERENCES "payouts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "payout_operations_payoutId_operatedAt_idx"
  ON "payout_operations" ("payoutId", "operatedAt");
CREATE INDEX IF NOT EXISTS "payout_operations_operatorId_idx"
  ON "payout_operations" ("operatorId");
