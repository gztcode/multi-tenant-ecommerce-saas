/** 支付超时释放预占的延迟任务队列 */
export const PAYMENT_TIMEOUT_QUEUE = 'payment-timeout';

/** 支付回调的异步消费队列 */
export const PAYMENT_WEBHOOK_QUEUE = 'payment-webhook';

/** 计费的每日扫描队列（生成账单 + 自动扣款） */
export const BILLING_QUEUE = 'billing';
