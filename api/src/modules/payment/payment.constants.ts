import type { PaymentProvider } from './payment-provider.interface';

/**
 * 渠道表的注入令牌。
 *
 * ⚠️ 用一个**字符串令牌**而不是某个具体的 provider 类：
 * 渠道表的内容是「渠道名 → provider」的映射，将来接真渠道时
 * 多注册一个 provider 就行，不必改消费方的注入方式。
 */
export const PAYMENT_PROVIDERS = 'PAYMENT_PROVIDERS';

/**
 * 支付渠道**实现列表**的注入令牌（阶段 6a）。
 *
 * ⚠️ Map（`PAYMENT_PROVIDERS`）是兼容层；注册表要「一组实现」自己建索引。
 *    新代码只依赖注册表。
 */
export const PAYMENT_PROVIDER_LIST = 'PAYMENT_PROVIDER_LIST';

/** 渠道表的类型别名 */
export type PaymentProviderMap = Map<string, PaymentProvider>;

/**
 * ⚠️ **出款渠道表的 token（`PAYOUT_PROVIDERS`）与类型住在
 *    `common/payment/payout.constants`**（阶段 5m）。
 *
 * 原因：渠道表要在一个 `@Global()` 模块里注册，billing 才能拿到它 ——
 * 而 billing **绝对不能 import payment**（会成模块环）。
 * ⚠️ **这里不做 re-export** —— 同一个 token 从两处导出会让人分不清
 *    「它到底住在哪」；请直接 import `common/payment/payout.constants`。
 */
