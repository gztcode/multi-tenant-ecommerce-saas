import type { PayoutProvider } from './payout-provider.interface';

/**
 * 出款渠道表的注入令牌。
 *
 * ⚠️ **为什么住在 `common/`**（阶段 5m）——
 *    渠道表要在一个 `@Global()` 模块里注册（见 `payout-providers.module.ts`），
 *    这样 **billing 模块也能拿到它** —— 而 billing **绝对不能 import payment**
 *    （那会成 `order → billing → payment → order` 的环，NestJS 启动报错）。
 *    契约与实现一起下沉到 `common/`，是绕开这个死结的唯一办法。
 */
export const PAYOUT_PROVIDERS = 'PAYOUT_PROVIDERS';

/** 出款渠道表的类型别名 */
export type PayoutProviderMap = Map<string, PayoutProvider>;

/**
 * 假出款网关不可用时的统一文案（阶段 5m）。
 *
 * ⚠️ **两条独立的报错路径要用同一个常量**：
 * ① 假网关的 `listPayouts` 抛错；
 * ② 手动触发对账的端点返回 409。
 * 两处文案漂移会让运营以为是两个问题。
 */
export const FAKE_PAYOUT_UNAVAILABLE_MESSAGE = '本地假出款网关未启用';
