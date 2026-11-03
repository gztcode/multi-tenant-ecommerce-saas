/**
 * 渠道告警钩子（阶段 6b Task 13）。
 *
 * ## 它解决什么问题
 *
 * 渠道调用失败时，「打一行日志」不够 —— 运营与值班需要**结构化的告警事件**：
 * 哪个渠道、哪个动作、哪一单、第几次、结果是否确定、花了多久。
 * 本阶段**不建告警系统**（设计 §9.3），只留一个可替换的钩子：
 * 默认实现打 `logger.error`，后续接 Slack / 邮件 / 监控时只换实现。
 *
 * ## 结构化字段（设计 §9.2）
 *
 * `channel / provider / operation / referenceNo / attempt / definitive / elapsedMs`
 *
 * ⚠️ **绝不包含账号、密钥、完整回调原文** —— 告警会被转发到外部系统，
 *    一旦带上这些字段就是一次泄露。只用 `referenceNo`（业务单号）定位。
 */
import { Injectable, Logger } from '@nestjs/common';

/** `CHANNEL_ALERT_SINK` 的注入令牌 */
export const CHANNEL_ALERT_SINK = Symbol('CHANNEL_ALERT_SINK');

/** 渠道动作类型（日志与告警共用的统一口径） */
export type ChannelOperation =
  'submit' | 'query' | 'refund' | 'list' | 'reconcile' | 'verify' | 'scan';

/** 一条渠道告警事件 */
export interface ChannelAlert {
  /** 渠道名（`payouts.payoutChannel` 里存的值） */
  channel: string;
  /** 服务提供方名 */
  provider: string;
  /** 出问题的动作 */
  operation: ChannelOperation;
  /** 业务单号（`payoutNo` / 支付单号），用来定位问题单；不填表示与具体单无关 */
  referenceNo?: string;
  /** 第几次尝试（从 1 起） */
  attempt?: number;
  /**
   * 结果是否确定。
   *
   * ⚠️ `false` 表示「结果未知，钱可能已经出去了」—— 这类告警的处置方式
   * 与「确定的失败」完全不同（只能人工核对，不能自动重试）。
   */
  definitive?: boolean;
  /** 本次调用耗时（毫秒） */
  elapsedMs?: number;
  /** 人类可读的说明（中文） */
  message: string;
}

/** 告警接收方（默认实现只有日志；后续可换 Slack / 邮件 / 监控） */
export interface ChannelAlertSink {
  alert(event: ChannelAlert): void;
}

/**
 * 默认告警实现：打 `logger.error`。
 *
 * ⚠️ **只打白名单字段** —— 不把整个 `event` 展开，避免调用方不小心塞进
 *    账号 / 密钥 / 回调原文后被原样打出来。
 */
@Injectable()
export class LoggingChannelAlertSink implements ChannelAlertSink {
  private readonly logger = new Logger(LoggingChannelAlertSink.name);

  alert(event: ChannelAlert): void {
    const fields: Record<string, unknown> = {
      channel: event.channel,
      provider: event.provider,
      operation: event.operation,
    };
    // ⚠️ **可选字段没值就不打** —— 打 `undefined` 会让「没这一项」与「值为空」混淆
    if (event.referenceNo !== undefined) {
      fields.referenceNo = event.referenceNo;
    }
    if (event.attempt !== undefined) {
      fields.attempt = event.attempt;
    }
    if (event.definitive !== undefined) {
      fields.definitive = event.definitive;
    }
    if (event.elapsedMs !== undefined) {
      fields.elapsedMs = event.elapsedMs;
    }
    this.logger.error(event.message, fields);
  }
}
