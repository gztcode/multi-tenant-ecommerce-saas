import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';

/** `req.requestId` 的挂载点（Express 的 Request 上没有这个字段） */
declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
  }
}

/**
 * 请求 ID 中间件（阶段 11：可观测性）。
 *
 * - 优先透传上游的 `x-request-id`（Nginx / 网关 / 前一跳生成），
 *   没有才生成 UUID——跨服务排查时能用同一个 ID 串起来；
 * - 回写响应头 `x-request-id`，调用方报障时把 ID 发来就能定位到具体请求；
 * - LoggingInterceptor 的访问日志与异常日志都会带上它。
 *
 * ⚠️ 这个值**只是排查关联键，不是认证凭证**——客户端可以自带任意
 * `x-request-id`，不能拿它做任何权限判断。
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.headers['x-request-id'];
    const requestId =
      typeof incoming === 'string' &&
      incoming.length > 0 &&
      incoming.length <= 128
        ? incoming
        : randomUUID();
    req.requestId = requestId;
    res.setHeader('x-request-id', requestId);
    next();
  }
}
