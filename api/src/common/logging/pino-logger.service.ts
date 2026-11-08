import { Injectable, LoggerService, Optional } from '@nestjs/common';
import pino from 'pino';
import type { Logger as PinoInstance } from 'pino';

/**
 * pino 结构化日志（阶段 11：可观测性）。
 *
 * ## 为什么是「替换全局 Logger」而不是 nestjs-pino
 *
 * 全仓业务代码都是 `new Logger(XxxService.name)` 的写法。pino 实现了
 * Nest 的 `LoggerService` 接口，`app.useLogger()` 之后 Nest 会把**所有**
 * `new Logger()` 实例的 log/warn/error 委托给这里——业务代码零改动，
 * 输出却从纯文本变成带时间戳/级别/上下文的 JSON。
 *
 * ## 安全口径（沿用 LoggingInterceptor / AllExceptionsFilter 的约定）
 *
 * - **不打请求/响应 body**——密码、token、账户信息落日志就是泄露；
 * - 自定义字段（各服务往 `logger.error(msg, fields)` 里塞的第二个参数）
 *   经过 `sanitizeValue` 递归脱敏：键名命中
 *   password / token / secret / authorization / cookie / credential 的值
 *   一律替换为 `[REDACTED]`。键名模式而非键值判断——值可能是任何形态；
 * - error 的第二个参数若是栈字符串（含 `\n    at `），按 `stack` 字段落，
 *   不与上下文名混淆。
 *
 * ## 输出形态
 *
 * - 默认 JSON（生产与测试）；`LOG_PRETTY=true` 时走 pino-pretty（本机调试）；
 *   未显式设置时，非生产且 TTY 且非 jest 进程也默认开 pretty。
 * - 级别由 `LOG_LEVEL` 控制（默认 info；测试环境 jest 下自动降为 warn，
 *   避免几百条用例的 info 噪音——需要看时可显式 `LOG_LEVEL=info npm test`）。
 */

/** 敏感键名模式：命中即脱敏（不区分大小写） */
const SENSITIVE_KEY_PATTERN =
  /(password|passwd|secret|token|authorization|cookie|credential)/i;

/** 递归脱敏的最大深度——超过就不再往下走（日志对象不该很深） */
const SANITIZE_MAX_DEPTH = 5;

/** 数组/对象展开的最大宽度，防巨型对象拖垮日志 */
const SANITIZE_MAX_ITEMS = 50;

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (depth >= SANITIZE_MAX_DEPTH) return '[TRUNCATED]';
  if (Array.isArray(value)) {
    return value
      .slice(0, SANITIZE_MAX_ITEMS)
      .map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (count >= SANITIZE_MAX_ITEMS) {
        out['…'] = '[TRUNCATED]';
        break;
      }
      count += 1;
      out[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? '[REDACTED]'
        : sanitizeValue(item, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 2000) {
    return `${value.slice(0, 2000)}…[TRUNCATED]`;
  }
  return value;
}

/** Nest 传参里「像是异常栈」的特征：缩进的 at 帧 */
const STACK_FRAME_PATTERN = /\n\s+at /;

function looksLikeStack(value: string): boolean {
  return STACK_FRAME_PATTERN.test(value);
}

/** pino 实例工厂（单独导出是为了测试可以注入替身） */
export function createRootPinoLogger(): PinoInstance {
  const isTest = process.env.JEST_WORKER_ID !== undefined;
  const pretty =
    process.env.LOG_PRETTY !== undefined
      ? process.env.LOG_PRETTY === 'true'
      : process.env.NODE_ENV !== 'production' &&
        !isTest &&
        process.stdout.isTTY === true;
  const level = process.env.LOG_LEVEL ?? (isTest ? 'warn' : 'info');

  return pino({
    level,
    base: { app: 'ecommerce-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
          },
        }
      : {}),
  });
}

@Injectable()
export class PinoLoggerService implements LoggerService {
  private readonly pino: PinoInstance;

  /** 显式注入 pino 实例仅用于单测；生产走工厂默认值。
   *  ⚠️ @Optional() 必须加：emitDecoratorMetadata 会把这个接口参数
   *  当成 DI 令牌去解析，不加的话 Nest 启动直接报无法解析依赖。 */
  constructor(@Optional() pinoInstance?: PinoInstance) {
    this.pino = pinoInstance ?? createRootPinoLogger();
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('info', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams);
  }

  /** Nest 的 verbose 级别映射到 pino 的 trace */
  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write('trace', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write('fatal', message, optionalParams);
  }

  setLogLevels(levels: string[]): void {
    // Nest 在 setLogLevel() 时调用；我们的级别由 LOG_LEVEL 决定，忽略之
    void levels;
  }

  private write(
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',
    message: unknown,
    optionalParams: unknown[],
  ): void {
    const fields: Record<string, unknown> = {};
    let msg: string;
    let err: Error | undefined;

    if (message instanceof Error) {
      err = message;
      msg = message.message;
    } else {
      msg = String(message);
    }

    for (const param of optionalParams) {
      if (param === undefined || param === null) continue;
      if (param instanceof Error) {
        err = param;
        continue;
      }
      if (typeof param === 'string') {
        // Nest 的约定：log(msg, context) / error(msg, stack, context)。
        // 栈字符串按 stack 落，其余字符串按上下文名落。
        if (looksLikeStack(param)) {
          fields.stack = param;
        } else if (fields.context === undefined) {
          fields.context = param;
        }
        continue;
      }
      if (typeof param === 'object') {
        // 各服务塞进来的结构化字段（如渠道告警的白名单字段）
        const sanitized = sanitizeValue(param) as Record<string, unknown>;
        if (sanitized && typeof sanitized === 'object') {
          Object.assign(fields, sanitized);
        }
      }
    }

    if (err !== undefined) {
      fields.err = { name: err.name, message: err.message, stack: err.stack };
    }

    this.pino[level](fields, msg);
  }
}
