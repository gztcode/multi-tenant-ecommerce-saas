import { Logger } from '@nestjs/common';
import {
  CHANNEL_ALERT_SINK,
  ChannelAlert,
  LoggingChannelAlertSink,
} from './channel-alert';

/**
 * 渠道告警钩子的单元测试（阶段 6b Task 13）。
 *
 * ⚠️ **重点是「日志里不能有敏感字段」** —— 告警会被转发到外部系统，
 *    泄漏一次账号或密钥就是安全事故。用例故意往事件里塞 `accountNo` /
 *    `secret` / `key`，断言默认实现**只打白名单字段**。
 */
describe('LoggingChannelAlertSink', () => {
  /** `[消息, 结构化字段]` —— 日志调用参数 */
  let errorSpy: jest.SpyInstance<
    void,
    [message: unknown, ...optionalParams: unknown[]]
  >;

  beforeEach(() => {
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('打 error 日志，并带统一的结构化字段', () => {
    const sink = new LoggingChannelAlertSink();

    sink.alert({
      channel: 'sandbox',
      provider: 'mock-channel',
      operation: 'submit',
      referenceNo: 'PO-001',
      attempt: 2,
      definitive: false,
      elapsedMs: 12_345,
      message: '渠道提交失败（结果未知）',
    });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toBe('渠道提交失败（结果未知）');
    expect(errorSpy.mock.calls[0][1]).toEqual({
      channel: 'sandbox',
      provider: 'mock-channel',
      operation: 'submit',
      referenceNo: 'PO-001',
      attempt: 2,
      definitive: false,
      elapsedMs: 12_345,
    });
  });

  it('可选字段没值时不打（不把 undefined 混进日志）', () => {
    const sink = new LoggingChannelAlertSink();

    sink.alert({
      channel: 'sandbox',
      provider: 'mock-channel',
      operation: 'list',
      message: '渠道对账超时',
    });

    expect(errorSpy.mock.calls[0][1]).toEqual({
      channel: 'sandbox',
      provider: 'mock-channel',
      operation: 'list',
    });
  });

  it('⚠️ 绝不输出账号 / 密钥 / 回调原文（只打白名单字段）', () => {
    const sink = new LoggingChannelAlertSink();
    // ⚠️ **故意绕过类型塞敏感字段** —— 调用方可能把整个请求对象展开进来
    const unsafe = {
      channel: 'sandbox',
      provider: 'mock-channel',
      operation: 'submit',
      referenceNo: 'PO-001',
      message: '渠道提交失败',
      accountNo: '6222020000001234',
      secret: 'sk-live-should-never-leak',
      key: 'aes-key-should-never-leak',
      rawCallback: '{"accountNo":"6222020000001234"}',
    } as unknown as ChannelAlert;

    sink.alert(unsafe);

    const serialized = JSON.stringify(errorSpy.mock.calls[0]);
    expect(serialized).not.toContain('6222020000001234');
    expect(serialized).not.toContain('sk-live-should-never-leak');
    expect(serialized).not.toContain('aes-key-should-never-leak');
    expect(serialized).not.toContain('rawCallback');
    // 只保留白名单里的五个字段
    expect(errorSpy.mock.calls[0][1]).toEqual({
      channel: 'sandbox',
      provider: 'mock-channel',
      operation: 'submit',
      referenceNo: 'PO-001',
    });
  });
});

describe('CHANNEL_ALERT_SINK 注入令牌', () => {
  it('是 Symbol（不会与其他字符串 token 撞名）', () => {
    expect(typeof CHANNEL_ALERT_SINK).toBe('symbol');
  });
});
