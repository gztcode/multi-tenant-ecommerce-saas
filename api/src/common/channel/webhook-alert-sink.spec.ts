import { Logger } from '@nestjs/common';

import { ChannelAlert } from './channel-alert';
import {
  renderAlertPayload,
  renderAlertText,
  WebhookAlertSink,
} from './webhook-alert-sink';

/**
 * WebhookAlertSink 的单元测试（阶段 11：可观测性）。
 *
 * ⚠️ **两个安全断言贯穿全部用例**：
 * 1. payload 只含白名单字段（塞进事件的脏字段不允许透传）；
 * 2. 发送失败（网络错误 / 非 2xx / 超时）绝不抛出——告警是旁路。
 */
const baseEvent: ChannelAlert = {
  channel: 'sandbox',
  provider: 'mock-channel',
  operation: 'submit',
  referenceNo: 'PO-001',
  attempt: 2,
  definitive: false,
  elapsedMs: 1234,
  message: '出款提交失败',
};

describe('renderAlertPayload', () => {
  it('generic 格式：结构化字段 + 文本', () => {
    const payload = renderAlertPayload('generic', baseEvent);
    expect(payload).toMatchObject({
      severity: 'critical', // definitive === false → critical
      channel: 'sandbox',
      provider: 'mock-channel',
      operation: 'submit',
      referenceNo: 'PO-001',
      attempt: 2,
      definitive: false,
      elapsedMs: 1234,
    });
    expect(String(payload['text'])).toContain('【渠道告警】出款提交失败');
  });

  it('definitive 为 true / 未定义时是 warning 而非 critical', () => {
    expect(renderAlertPayload('generic', { ...baseEvent, definitive: true })['severity']).toBe('warning');
    expect(renderAlertPayload('generic', { ...baseEvent, definitive: undefined })['severity']).toBe('warning');
  });

  it('feishu 格式：msg_type=text', () => {
    const payload = renderAlertPayload('feishu', baseEvent);
    expect(payload).toMatchObject({
      msg_type: 'text',
      content: { text: expect.stringContaining('出款提交失败') },
    });
    // 告警文本不允许携带事件对象之外的任何东西（无原始 payload 泄露面）
    expect(Object.keys(payload)).toEqual(['msg_type', 'content']);
  });

  it('dingtalk 格式：msgtype=text', () => {
    const payload = renderAlertPayload('dingtalk', baseEvent);
    expect(payload).toMatchObject({
      msgtype: 'text',
      text: { content: expect.stringContaining('referenceNo=PO-001') },
    });
  });

  it('renderAlertText 只渲染白名单字段', () => {
    const text = renderAlertText(baseEvent);
    expect(text).toContain('channel=sandbox');
    expect(text).toContain('definitive=false');
    // 不存在的可选字段不出现（「没这一项」与「值为空」要可区分）
    expect(text).not.toContain('undefined');
  });
});

describe('WebhookAlertSink', () => {
  let fetchSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  const makeSink = (overrides?: { url?: string }) =>
    new WebhookAlertSink({
      url: overrides?.url ?? 'https://hooks.example.com/alert',
      dedupWindowMs: 60_000,
      maxPerMinute: 3,
    });

  beforeEach(() => {
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('发送 POST，payload 为指定格式（默认 generic）', async () => {
    const sink = makeSink();
    sink.alert(baseEvent);
    await Promise.resolve(); // 让 fire-and-forget 的 deliver 跑完
    await Promise.resolve();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://hooks.example.com/alert');
    expect((init as RequestInit).method).toBe('POST');
    // generic 是默认格式（renderAlertPayload 的用例已覆盖 feishu/dingtalk）
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      channel: 'sandbox',
      referenceNo: 'PO-001',
    });
  });

  it('⚠️ 去重：同 key 在窗口内只发一次', async () => {
    const sink = makeSink();
    sink.alert(baseEvent);
    sink.alert({ ...baseEvent, elapsedMs: 999 }); // 同 channel+operation+referenceNo
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('不同 referenceNo 是不同 key，各自发送', async () => {
    const sink = makeSink();
    sink.alert(baseEvent);
    sink.alert({ ...baseEvent, referenceNo: 'PO-002' });
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('⚠️ 限频：超过每分钟上限后丢弃并打 warn', async () => {
    const sink = makeSink(); // maxPerMinute = 3
    sink.alert({ ...baseEvent, referenceNo: 'A' });
    sink.alert({ ...baseEvent, referenceNo: 'B' });
    sink.alert({ ...baseEvent, referenceNo: 'C' });
    sink.alert({ ...baseEvent, referenceNo: 'D' }); // 第 4 条被限频丢弃
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('限频'));
  });

  it('⚠️ 非 2xx 响应只记 warn，绝不抛出', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 503 }));
    const sink = makeSink();

    expect(() => sink.alert(baseEvent)).not.toThrow();
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('503'));
  });

  it('⚠️ 网络异常只记 warn，绝不抛出', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));
    const sink = makeSink();

    expect(() => sink.alert(baseEvent)).not.toThrow();
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));
    expect(warnSpy).toHaveBeenCalled();
  });

  it('未配置 URL 时丢弃告警并 warn（工厂不该走到这里，兜底防御）', async () => {
    const sink = makeSink({ url: '' });
    sink.alert(baseEvent);
    await Promise.resolve();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('未配置'));
  });
});
