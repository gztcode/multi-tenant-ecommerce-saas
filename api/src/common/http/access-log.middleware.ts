import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

/** `req.user` 上访问日志关心的字段（由 JwtStrategy.validate 的返回值填充）。 */
interface AccessLogUser {
  userId?: unknown;
  tenantId?: unknown;
}

/**
 * HTTP 访问日志（阶段 11 缺口的收口）。
 *
 * ## 为什么是中间件而不是拦截器
 *
 * 原实现是 `LoggingInterceptor`，但 Nest 的守卫在拦截器链**之外**执行——
 * 守卫直接拒绝的 401/403 请求永远走不到拦截器，也就永远没有访问日志。
 * 中间件在守卫之前执行、在 `res 'finish'` 时读**最终状态码**，
 * 因此 200、401、403、404、500 都能各落一条。这与 `MetricsMiddleware`
 * 是同一个思路（指标早已下沉，日志这次补齐）。
 *
 * ## 安全口径（与原 LoggingInterceptor 一致）
 *
 * ⚠️ **绝不记录请求/响应 body**——登录密码、令牌、账户信息落进日志
 * 就是泄露；`req.user` 也只取 `userId` / `tenantId` 两个标识，
 * 其余字段（邮箱、角色之外的信息）一律不带。
 * 要看请求内容请走调试器或专门的链路追踪。
 *
 * ## 字段与级别
 *
 * 字段沿用原访问日志：`requestId` / `method` / `url` / `status` /
 * `clientIp` / `durationMs`，登录用户额外带 `userId` / `tenantId`。
 * 4xx / 5xx 用 warn（原拦截器对抛出的异常也是 warn），其余用 log。
 *
 * ⚠️ 注册顺序：必须排在 `RequestIdMiddleware` **之后**，
 * 否则 `finish` 时拿不到 `req.requestId`（见 app.module.ts 的 configure）。
 */
@Injectable()
export class AccessLogMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: Request, res: Response, next: NextFunction): void {
    const startedAt = Date.now();
    const method = req.method ?? 'UNKNOWN';

    // 监听注册在守卫之前，`finish` 在响应真正写完时触发，
    // 此时 `res.statusCode` 是最终值（含守卫拒绝、过滤器改写后的）。
    res.once('finish', () => {
      const status = res.statusCode;
      const durationMs = Date.now() - startedAt;
      // 登录用户由 passport 在守卫阶段挂到 req 上；401 时自然为空。
      const identity = identityOf(req);
      const fields = {
        requestId: req.requestId,
        method,
        url: req.originalUrl ?? req.url,
        status,
        clientIp: req.ip,
        durationMs,
        ...identity,
      };
      const line = `${method} ${req.originalUrl ?? req.url} ${status} ${durationMs}ms ${
        req.ip ?? '-'
      }`;
      if (status >= 400) {
        this.logger.warn(line, fields);
      } else {
        this.logger.log(line, fields);
      }
    });

    next();
  }
}

/** 只提取非空的字符串标识；`tenantId` 为 null（平台用户）时不带。 */
function identityOf(req: Request): { userId?: string; tenantId?: string } {
  const user = (req as Request & { user?: AccessLogUser }).user;
  if (user === null || typeof user !== 'object') return {};
  return {
    ...(typeof user.userId === 'string' && user.userId.length > 0
      ? { userId: user.userId }
      : {}),
    ...(typeof user.tenantId === 'string' && user.tenantId.length > 0
      ? { tenantId: user.tenantId }
      : {}),
  };
}
