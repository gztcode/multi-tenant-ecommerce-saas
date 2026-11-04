import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { Request, Response } from 'express';

/**
 * HTTP 访问日志：方法 + 路径 + 状态码 + 耗时。
 *
 * ⚠️ **不打 body**——请求/响应体里可能有密码、token、账户信息，
 * 落进日志就是泄露。要看请求内容请走调试器或专门的链路追踪。
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const startedAt = Date.now();
    const req = context.switchToHttp().getRequest<Request>();
    const { method, url } = req;
    return next.handle().pipe(
      tap({
        next: () => {
          const res = context.switchToHttp().getResponse<Response>();
          this.logger.log(
            `${method} ${url} ${res.statusCode} ${Date.now() - startedAt}ms`,
          );
        },
        error: (error: unknown) => {
          // ⚠️ **不打 error.message**：未知异常里常带表名、SQL 片段、文件路径。
          //    AllExceptionsFilter 也是这个口径（只记日志、不回显原文）——
          //    同一仓库两种口径会让日志变成信息泄露的口子。
          const status = (error as { status?: number })?.status ?? 500;
          const name = error instanceof Error ? error.name : 'UnknownError';
          this.logger.warn(
            `${method} ${url} ${status} ${Date.now() - startedAt}ms ${name}`,
          );
        },
      }),
    );
  }
}
