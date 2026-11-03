-- 阶段 6a 迁移 A：平台默认出款渠道的存储表
--
-- ⚠️ 不在迁移里插默认行：无行时由 PAYOUT_PLATFORM_DEFAULT_CHANNEL 兜底。
--    迁移里写死默认值等于把「部署时的环境差异」固化进版本历史。
CREATE TABLE "platform_settings" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "platform_settings_key_key" ON "platform_settings"("key");
