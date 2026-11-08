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
    const requestId = req.requestId;
    return next.handle().pipe(
      tap({
        next: () => {
          const res = context.switchToHttp().getResponse<Response>();
          this.emit(
            'log',
            method,
            url,
            res.statusCode,
            startedAt,
            undefined,
            requestId,
          );
        },
        error: (error: unknown) => {
          // ⚠️ **不打 error.message**：未知异常里常带表名、SQL 片段、文件路径。
          //    AllExceptionsFilter 也是这个口径（只记日志、不回显原文）——
          //    同一仓库两种口径会让日志变成信息泄露的口子。
          const status = (error as { status?: number })?.status ?? 500;
          const name = error instanceof Error ? error.name : 'UnknownError';
          this.emit('warn', method, url, status, startedAt, name, requestId);
        },
      }),
    );
  }

  /**
   * 阶段 11：人读的字符串保留（本地开发直接看 docker logs），
   * 同时把结构化字段作为第二个参数传给全局 Logger——
   * 全局换成 PinoLoggerService 后这些字段会原样落进 JSON。
   */
  private emit(
    level: 'log' | 'warn',
    method: string,
    url: string,
    status: number,
    startedAt: number,
    errorName: string | undefined,
    requestId: string | undefined,
  ): void {
    const fields = {
      requestId,
      method,
      url,
      status,
      durationMs: Date.now() - startedAt,
      ...(errorName !== undefined ? { errorName } : {}),
    };
    const line = `${method} ${url} ${status} ${fields.durationMs}ms${
      errorName !== undefined ? ` ${errorName}` : ''
    }`;
    if (level === 'log') {
      this.logger.log(line, fields);
    } else {
      this.logger.warn(line, fields);
    }
  }
}
