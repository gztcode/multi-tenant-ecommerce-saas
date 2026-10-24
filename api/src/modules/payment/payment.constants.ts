import type { PaymentProvider } from './payment-provider.interface';

/**
 * 渠道表的注入令牌。
 *
 * ⚠️ 用一个**字符串令牌**而不是某个具体的 provider 类：
 * 渠道表的内容是「渠道名 → provider」的映射，将来接真渠道时
 * 多注册一个 provider 就行，不必改消费方的注入方式。
 */
export const PAYMENT_PROVIDERS = 'PAYMENT_PROVIDERS';

/** 渠道表的类型别名 */
export type PaymentProviderMap = Map<string, PaymentProvider>;
