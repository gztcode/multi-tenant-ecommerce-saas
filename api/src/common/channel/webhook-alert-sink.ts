import { Logger } from '@nestjs/common';

import { ChannelAlert, ChannelAlertSink } from './channel-alert';
import type { ChannelOperation } from './channel-alert';

/** 告警 payload 格式。`generic` 是裸 JSON，`feishu` / `dingtalk` 是各自机器人的文本消息格式 */
export type WebhookAlertFormat = 'generic' | 'feishu' | 'dingtalk';

/** 同一告警的默认去重窗口（毫秒）：窗口内同 key 的重复告警直接丢弃 */
const DEFAULT_DEDUP_WINDOW_MS = 10 * 60 * 1000;

/** 默认全局限频：每分钟最多发出的告警数（防告警风暴把接收端打挂） */
const DEFAULT_MAX_PER_MINUTE = 10;

/** webhook 请求超时（毫秒）：告警是旁路，不能拖慢业务 */
const WEBHOOK_TIMEOUT_MS = 3000;

/**
 * 把 `ChannelAlert` 渲染成一行人可读的文本（飞书/钉钉的 text 消息只有纯文本位）。
 * 只用白名单字段——与 LoggingChannelAlertSink 同一口径，绝不展开原始事件对象。
 */
export function renderAlertText(event: ChannelAlert): string {
  const parts: string[] = [`【渠道告警】${event.message}`];
  parts.push(
    `channel=${event.channel} provider=${event.provider} operation=${event.operation}`,
  );
  if (event.referenceNo !== undefined)
    parts.push(`referenceNo=${event.referenceNo}`);
  if (event.attempt !== undefined) parts.push(`attempt=${event.attempt}`);
  if (event.definitive !== undefined)
    parts.push(`definitive=${event.definitive}`);
  if (event.elapsedMs !== undefined) parts.push(`elapsedMs=${event.elapsedMs}`);
  return parts.join('\n');
}

/** 飞书自定义机器人的文本消息（https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot） */
export interface FeishuAlertPayload {
  msg_type: 'text';
  content: { text: string };
}

/** 钉钉自定义机器人的文本消息（https://open.dingtalk.com/document/robots/custom-robot-access） */
export interface DingtalkAlertPayload {
  msgtype: 'text';
  text: { content: string };
}

/** 通用接收端：结构化字段 + 文本，各字段语义见 channel-alert.ts */
export interface GenericAlertPayload {
  severity: 'critical' | 'warning';
  channel: string;
  provider: string;
  operation: ChannelOperation;
  referenceNo?: string;
  attempt?: number;
  definitive?: boolean;
  elapsedMs?: number;
  message: string;
  text: string;
}

export type AlertPayload =
  FeishuAlertPayload | DingtalkAlertPayload | GenericAlertPayload;

/** 按 `ALERT_WEBHOOK_FORMAT` 渲染请求体（重载：调用方传字面量时返回精确形状） */
export function renderAlertPayload(
  format: 'feishu',
  event: ChannelAlert,
): FeishuAlertPayload;
export function renderAlertPayload(
  format: 'dingtalk',
  event: ChannelAlert,
): DingtalkAlertPayload;
export function renderAlertPayload(
  format: 'generic',
  event: ChannelAlert,
): GenericAlertPayload;
export function renderAlertPayload(
  format: WebhookAlertFormat,
  event: ChannelAlert,
): AlertPayload;
export function renderAlertPayload(
  format: WebhookAlertFormat,
  event: ChannelAlert,
): AlertPayload {
  const text = renderAlertText(event);
  switch (format) {
    case 'feishu':
      return { msg_type: 'text', content: { text } };
    case 'dingtalk':
      return { msgtype: 'text', text: { content: text } };
    default:
      return {
        severity: event.definitive === false ? 'critical' : 'warning',
        channel: event.channel,
        provider: event.provider,
        operation: event.operation,
        ...(event.referenceNo !== undefined
          ? { referenceNo: event.referenceNo }
          : {}),
        ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
        ...(event.definitive !== undefined
          ? { definitive: event.definitive }
          : {}),
        ...(event.elapsedMs !== undefined
          ? { elapsedMs: event.elapsedMs }
          : {}),
        message: event.message,
        text,
      };
  }
}

/**
 * webhook 告警接收方（阶段 11：可观测性）。
 *
 * ## 定位
 *
 * `ChannelAlertSink` 的第二个实现——阶段 6 留的钩子终于有了真的接收端。
 * 卡住的出款单、问不出结论的退款、对账超预算这些事件，从「打一条日志
 * 没人看」变成「推到飞书/钉钉/自建值班群」。
 *
 * ## 两道防线（缺一不可）
 *
 * 1. **去重**：同一问题（channel+operation+referenceNo）在窗口内只报一次。
 *    渠道挂了时,每一笔在途单都会触发告警——不去重就是几百条刷屏，
 *    而刷屏的告警等于没有告警。
 * 2. **限频**：全局每分钟最多 N 条。去重防「同一条重复」，限频防
 *    「很多条不同的问题一起爆」。超限的告警**丢弃并记日志**——
 *    接收端的价值随噪声递减，宁可丢也要保住前 N 条的可见性。
 *
 * ## 安全口径
 *
 * - `ALERT_WEBHOOK_URL` 是出站配置，从环境读取，不落日志；
 * - payload 只含白名单字段（`renderAlertPayload`），与日志 sink 同款约束；
 * - 发送是 fire-and-forget：任何失败（网络/超时/非 2xx）都只记 warn，
 *   绝不抛回调用方——告警系统自己坏了不能影响业务。
 */
export class WebhookAlertSink implements ChannelAlertSink {
  private readonly logger = new Logger(WebhookAlertSink.name);

  private readonly url: string | undefined;
  private readonly format: WebhookAlertFormat;
  private readonly dedupWindowMs: number;
  private readonly maxPerMinute: number;

  /** 去重表：key → 上次发送时间（进程内存即可，重启清空可接受） */
  private readonly lastSentAtByKey = new Map<string, number>();
  /** 限频：最近一分钟内每次发送的时间戳 */
  private readonly sentTimestamps: number[] = [];

  constructor(options?: {
    url?: string;
    format?: WebhookAlertFormat;
    dedupWindowMs?: number;
    maxPerMinute?: number;
  }) {
    this.url = options?.url ?? process.env.ALERT_WEBHOOK_URL;
    const format = options?.format ?? process.env.ALERT_WEBHOOK_FORMAT;
    this.format =
      format === 'feishu' || format === 'dingtalk' || format === 'generic'
        ? format
        : 'generic';
    this.dedupWindowMs =
      options?.dedupWindowMs ??
      Number(process.env.ALERT_DEDUP_WINDOW_MS ?? DEFAULT_DEDUP_WINDOW_MS);
    this.maxPerMinute =
      options?.maxPerMinute ??
      Number(process.env.ALERT_MAX_PER_MINUTE ?? DEFAULT_MAX_PER_MINUTE);
  }

  alert(event: ChannelAlert): void {
    if (!this.url) {
      // 没配 URL 就不该实例化（工厂里已判断）；兜底只记日志
      this.logger.warn('ALERT_WEBHOOK_URL 未配置，告警被丢弃');
      return;
    }

    const key = `${event.channel}:${event.operation}:${event.referenceNo ?? ''}`;
    if (this.isDuplicate(key)) {
      return;
    }
    if (!this.tryAcquireRateBudget()) {
      this.logger.warn(
        `告警限频触发（>${this.maxPerMinute}/分钟），丢弃：${key}`,
      );
      return;
    }

    // ⚠️ 运行时按变量调用 → 走宽签名（字面量重载只服务测试/静态调用点）
    const payload: AlertPayload = renderAlertPayload(this.format, event);
    // fire-and-forget：告警失败不影响业务路径
    void this.deliver(key, payload);
  }

  /** 窗口内发过同 key 就返回 true；顺手清理过期项防 Map 无限增长 */
  private isDuplicate(key: string): boolean {
    const now = Date.now();
    const last = this.lastSentAtByKey.get(key);
    this.lastSentAtByKey.set(key, now);
    if (this.lastSentAtByKey.size > 1000) {
      for (const [k, at] of this.lastSentAtByKey) {
        if (now - at > this.dedupWindowMs) {
          this.lastSentAtByKey.delete(k);
        }
      }
    }
    return last !== undefined && now - last < this.dedupWindowMs;
  }

  private tryAcquireRateBudget(): boolean {
    const now = Date.now();
    const minuteAgo = now - 60_000;
    while (
      this.sentTimestamps.length > 0 &&
      this.sentTimestamps[0] < minuteAgo
    ) {
      this.sentTimestamps.shift();
    }
    if (this.sentTimestamps.length >= this.maxPerMinute) {
      return false;
    }
    this.sentTimestamps.push(now);
    return true;
  }

  private async deliver(key: string, payload: AlertPayload): Promise<void> {
    try {
      const response = await fetch(this.url as string, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.logger.warn(`告警 webhook 返回 ${response.status}（key=${key}）`);
      }
    } catch (error) {
      this.logger.warn(
        `告警 webhook 发送失败（key=${key}）：${
          error instanceof Error ? error.name : 'UnknownError'
        }`,
      );
    }
  }
}
