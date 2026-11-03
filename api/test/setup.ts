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

// ⚠️ **平台默认出款渠道**（阶段 6a）—— e2e 里没有「超管去后台点一下」这一步，
//    但出款执行、解卡核实、对账都需要一个默认渠道才能解析出渠道
//    （解析不到就按设计 fail-closed 报 409，所有出款用例都会挂）。
//
//    这里走的是**真实的 env 兜底路径**（生产是「DB 优先、env 兜底」），
//    不是测试专用的旁路：`platform_settings` 没有行时本来就读它。
//    需要验证「DB 与 env 都没配 → 抛错」的用例，自己 `delete` 这个变量
//    并在 `finally` 里还原（见 `test/platform-settings.e2e-spec.ts`）。
if (!process.env.PAYOUT_PLATFORM_DEFAULT_CHANNEL) {
  process.env.PAYOUT_PLATFORM_DEFAULT_CHANNEL = 'fake-payout';
}
