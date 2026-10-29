import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const envPath = resolve(__dirname, '..', '.env');
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

// e2e 全部跑在测试库上
if (process.env.DATABASE_URL_TEST) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}

jest.setTimeout(30_000);

// ⚠️ **假出款网关要打开**（阶段 5h-2）—— 不打开的话
//    `FakePayoutProvider.execute` 会返回 rejected promise，出款永远失败。
process.env.FAKE_PAYOUT_ENABLED = 'true';

// ⚠️ **重试退避调小** —— 默认 30 秒 × 3 次 = 3 分钟，e2e 等不起。
//    100ms × 3 次 = 600ms。
process.env.PAYOUT_RETRY_BASE_DELAY_MS = '100';
