import type { NormalizedWebhookEvent } from './payment-provider.interface';

/**
 * 从事件行还原出归一化事件。
 *
 * ⚠️ **payload 的形状由 `insertEvent` 决定**（`channel` / `referenceNo` /
 *    `amount` / `success`）。字段缺失或类型不对时返回 null ——
 *    宁可少投一条，也不能把一个**结构不对**的事件投进队列
 *    （消费端会拿到 `amount: undefined`，金额核对必然不过，
 *    白白在队列里滚一圈）。
 *
 * ⚠️ **这份还原有两处读者**（单一事实来源，别各写一份）：
 *    1. 补偿扫描：把「上次没处理完」的事件行重新入队；
 *    2. 消费端复核（审计 P0-6 ③）：用事件行重建事件，
 *       **不采信队列任务里的内容**。
 */
export function eventFromRow(row: {
  provider: string;
  eventId: string;
  providerTxnId: string | null;
  payload: unknown;
}): NormalizedWebhookEvent | null {
  if (
    typeof row.payload !== 'object' ||
    row.payload === null ||
    Array.isArray(row.payload)
  ) {
    return null;
  }
  const payload = row.payload as Record<string, unknown>;
  const referenceNo = payload.referenceNo;
  const amount = payload.amount;
  const success = payload.success;
  const channel = payload.channel;
  if (
    typeof referenceNo !== 'string' ||
    typeof amount !== 'number' ||
    typeof success !== 'boolean' ||
    typeof channel !== 'string'
  ) {
    return null;
  }
  return {
    provider: row.provider,
    channel,
    eventId: row.eventId,
    // ⚠️ 事件行的 `providerTxnId` 可空，而归一化事件要求字符串
    providerTxnId: row.providerTxnId ?? '',
    referenceNo,
    amount,
    success,
    // ⚠️ **退款事件重放必须带上类型与状态**（阶段 6c）：
    //    少了它们，退款事件会被当成支付事件重投 —— 查不到订单，
    //    这笔退款就永远停在 `REFUNDING`。
    ...(payload.eventType === 'REFUND' ? { eventType: 'REFUND' as const } : {}),
    ...(typeof payload.refundTxnId === 'string'
      ? { refundTxnId: payload.refundTxnId }
      : {}),
    ...(payload.refundStatus === 'SUCCESS' ||
    payload.refundStatus === 'FAILED' ||
    payload.refundStatus === 'PROCESSING'
      ? { refundStatus: payload.refundStatus }
      : {}),
    ...(typeof payload.definitive === 'boolean'
      ? { definitive: payload.definitive }
      : {}),
  };
}
