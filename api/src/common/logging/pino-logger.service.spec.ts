import type { Logger as PinoInstance } from 'pino';

import { PinoLoggerService } from './pino-logger.service';

/**
 * PinoLoggerService 的单元测试（阶段 11：可观测性）。
 *
 * ⚠️ **重点与 LoggingChannelAlertSink 的测试同款：日志里不能有敏感字段。**
 * 各服务往 `logger.error(msg, fields)` 的第二个参数里塞什么都有可能，
 * 脱敏是日志服务的最后一道闸。
 */
describe('PinoLoggerService', () => {
  type PinoMethod = (fields: object, msg: string) => void;

  /** 按 pino 级别收集调用的替身实例 */
  let calls: Record<string, Array<{ fields: object; msg: string }>>;
  let stub: PinoInstance;
  let service: PinoLoggerService;

  beforeEach(() => {
    calls = {};
    const methodNames = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
    stub = {} as PinoInstance;
    for (const name of methodNames) {
      calls[name] = [];
      (stub as unknown as Record<string, PinoMethod>)[name] = (
        fields: object,
        msg: string,
      ) => {
        calls[name].push({ fields, msg });
      };
    }
    service = new PinoLoggerService(stub);
  });

  it('log/warn/error 落到对应 pino 级别', () => {
    service.log('普通信息');
    service.warn('警告');
    service.error('错误');

    expect(calls.info).toHaveLength(1);
    expect(calls.info[0].msg).toBe('普通信息');
    expect(calls.warn).toHaveLength(1);
    expect(calls.error).toHaveLength(1);
  });

  it('verbose 映射到 trace（Nest 与 pino 的级别名不同）', () => {
    service.verbose('详细日志');
    expect(calls.trace).toHaveLength(1);
  });

  it('第二个参数是字符串时按上下文名落（Nest 的 log(msg, context) 约定）', () => {
    service.log('消息', 'XxxService');
    expect(calls.info[0].fields).toMatchObject({ context: 'XxxService' });
  });

  it('第二个参数是栈字符串时按 stack 落（error(msg, stack) 约定）', () => {
    service.error('出错了', 'Error: x\n    at foo (/app/x.ts:1:1)');
    expect(calls.error[0].fields).toMatchObject({
      stack: 'Error: x\n    at foo (/app/x.ts:1:1)',
    });
  });

  it('Error 对象落 err 字段（name/message/stack）', () => {
    const err = new Error('boom');
    service.error(err);
    expect(calls.error[0].msg).toBe('boom');
    expect(calls.error[0].fields).toMatchObject({
      err: { name: 'Error', message: 'boom' },
    });
  });

  it('对象参数的结构化字段原样落盘（渠道告警的白名单字段）', () => {
    service.error('渠道调用失败', { channel: 'sandbox', attempt: 2 });
    expect(calls.error[0].fields).toMatchObject({
      channel: 'sandbox',
      attempt: 2,
    });
    // context 未传时不应出现该键
    expect(calls.error[0].fields).not.toHaveProperty('context');
  });

  it('⚠️ 对象参数里的敏感键被脱敏（password/token/secret/authorization/cookie）', () => {
    service.error('登录失败', {
      email: 'user@example.com',
      password: 'SuperSecret123!',
      accessToken: 'eyJhbGciOi...',
      refreshToken: 'rotated-token',
      clientSecret: 'shhh',
      authorization: 'Bearer xyz',
      cookie: 'session=abc',
      nested: { credential: 'leak-me', safe: 'ok' },
    });

    const fields = calls.error[0].fields as Record<string, unknown>;
    expect(fields['email']).toBe('user@example.com'); // 非敏感键不受影响
    expect(fields['password']).toBe('[REDACTED]');
    expect(fields['accessToken']).toBe('[REDACTED]');
    expect(fields['refreshToken']).toBe('[REDACTED]');
    expect(fields['clientSecret']).toBe('[REDACTED]');
    expect(fields['authorization']).toBe('[REDACTED]');
    expect(fields['cookie']).toBe('[REDACTED]');
    expect(fields['nested']).toMatchObject({
      credential: '[REDACTED]',
      safe: 'ok',
    });
  });

  it('脱敏不会改动调用方传入的原对象', () => {
    const fields = { password: 'plain' };
    service.warn('x', fields);
    expect(fields['password']).toBe('plain');
  });

  it('超长字符串被截断（防巨型对象拖垮日志）', () => {
    service.warn('x', { blob: 'a'.repeat(5000) });
    const fields = calls.warn[0].fields as Record<string, string>;
    expect(fields['blob'].length).toBeLessThan(5000);
    expect(fields['blob']).toMatch(/\[TRUNCATED\]$/);
  });
});
