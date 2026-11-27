import { defineConfig } from '@playwright/test';

import {
  API_BASE_URL,
  API_PORT,
  AUTH_SECRET,
  DATABASE_URL,
  MERCHANT_ADMIN_URL,
  STOREFRONT_PORT,
  STOREFRONT_URL,
} from './support/env';

/**
 * 浏览器级端到端测试配置（阶段 11c）。
 *
 * ## 与 api/test（jest e2e）的分工
 *
 * - api/test：进程内起 AppModule，测**后端契约**（鉴权/隔离/状态机/资金）；
 * - 本目录：真实浏览器（Chromium）打真实 storefront，测**全链路**——
 *   登录会话、加购按钮、结算表单、跳转支付这类「UI 断链没人守」的环节。
 *
 * ## 两个 webServer 的编排
 *
 * - **api**（端口 3100）：独立库 `ecommerce_browser`（与开发/测试库物理隔离，
 *   也避免测试库里的历史出款快照触发账目密钥自检失败），migrate + seed 后启动；
 *   开着 FAKE_PAYMENT（假网关支付页只在非生产存在）。
 * - **storefront**（端口 3001，dev 脚本固定端口）：API_BASE_URL 指向 3100；
 *   localhost 的 Host 不带子域名 → tenant.ts 兜底到 demo，正好是 seed 的店铺。
 * - **merchant-admin**（端口 3002，dev 脚本固定端口）：同样是中心域名，
 *   商家后台登录**不带** `x-tenant-subdomain`，租户由 token 决定。
 *
 * 端口与库地址单源在 `support/env.ts`：spec 里要用绝对地址访问 3002，
 * 两处各写一份迟早会漂。
 *
 * ⚠️ 密钥与 CI 的 e2e job 保持同源（ci-*-前缀），历史密文才解得开。
 */
const apiEnv = {
  DATABASE_URL,
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:16380',
  BULLMQ_PREFIX: 'bull-browser',
  JWT_SECRET: 'ci-jwt-secret-with-enough-entropy-0123456789',
  PAYOUT_ACCOUNT_ENCRYPTION_KEY: 'browser-payout-encryption-key-0123456789',
  // 假网关支付页无需登录就能把订单付掉，只存在于非生产
  FAKE_PAYMENT_ENABLED: 'true',
  FAKE_PAYMENT_SECRET: 'browser-e2e-fake-payment-secret-32-chars',
  NODE_ENV: 'development',
  PORT: String(API_PORT),
};

export default defineConfig({
  testDir: './specs',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: STOREFRONT_URL,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command:
        'npm run prisma:deploy --workspace api && npm run prisma:seed --workspace api && npm run start --workspace api',
      cwd: '..',
      url: `http://localhost:${API_PORT}/api/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: apiEnv,
    },
    {
      command: 'npm run dev --workspace storefront',
      cwd: '..',
      url: `http://localhost:${STOREFRONT_PORT}/`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: {
        API_BASE_URL,
        AUTH_SECRET,
        AUTH_TRUST_HOST: 'true',
        NEXT_PUBLIC_TENANT_SUBDOMAIN: 'demo',
      },
    },
    {
      command: 'npm run dev --workspace merchant-admin',
      cwd: '..',
      url: `${MERCHANT_ADMIN_URL}/login`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: {
        API_BASE_URL,
        AUTH_SECRET,
        AUTH_URL: MERCHANT_ADMIN_URL,
        AUTH_TRUST_HOST: 'true',
      },
    },
  ],
});
