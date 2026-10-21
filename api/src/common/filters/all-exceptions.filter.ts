import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { TenantScopeError } from '../tenant/tenant-scope.error';
import { ERROR_CODES, ErrorCode } from './error-codes';

interface ErrorBody {
  code: ErrorCode;
  message: string;
  details?: unknown;
  traceId: string;
}

/**
 * 全局异常过滤器：把所有异常收敛成同一种响应体。
 *
 * 未注册这个过滤器时，NestJS 的默认错误格式是
 * `{ statusCode, message, error }`，其中 `message` 既可能是字符串也可能是
 * 字符串数组（ValidationPipe 聚合多条校验失败时），客户端必须写两套解析分支。
 * 这里统一成 `{ code, message, details?, traceId }`：
 * - `code`：稳定的业务错误码，客户端分支判断用；
 * - `message`：永远是字符串，可直接展示；
 * - `details`：仅在校验失败等场景出现，保留原始数组供前端定位字段；
 * - `traceId`：链路追踪号，同时从请求头 `X-Trace-Id` 透传，
 *   用户报障时报这个号即可在日志里定位到那一次请求。
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();

    // 上游（网关 / 前端）已经带了追踪号就沿用，没有才自己生成，
    // 这样跨服务的日志可以用同一个号串起来。
    const traceId =
      request.header('x-trace-id') ??
      `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code: ErrorCode = ERROR_CODES.INTERNAL_ERROR;
    let message = '服务器内部错误';
    let details: unknown;

    if (exception instanceof TenantScopeError) {
      // 租户越权是「代码写错了」而不是「用户请求错了」——它表示某个服务
      // 用了 findUnique/update 这类无法附加 tenantId 的方法，属于程序缺陷。
      // 因此消息里保留了具体原因（对排障有用），同时用独立的错误码区分开。
      status = HttpStatus.FORBIDDEN;
      code = ERROR_CODES.TENANT_SCOPE_VIOLATION;
      message = exception.message;
      this.logger.error(`[${traceId}] 租户越权拦截：${exception.message}`);
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const payload = exception.getResponse();

      if (typeof payload === 'string') {
        message = payload;
      } else if (payload && typeof payload === 'object') {
        const body = payload as { message?: unknown; error?: unknown };
        // ValidationPipe 会把多条校验错误聚成字符串数组。
        // 对外用「；」拼成一句可读文案，同时把原始数组放进 details，
        // 前端仍能按字段名精确定位，但不必再处理联合类型。
        if (Array.isArray(body.message)) {
          message = body.message.join('；');
          details = body.message;
        } else if (typeof body.message === 'string') {
          message = body.message;
        } else {
          message = exception.message;
        }
      }

      code = this.codeForStatus(status);
    } else {
      // 未知异常：只记日志，绝不回显原始 message。
      // 原始 message 常常含表名、SQL 片段或文件路径，回显等于给攻击者送情报。
      this.logger.error(
        `[${traceId}] 未处理异常：${(exception as Error)?.message}`,
        (exception as Error)?.stack,
      );
    }

    const body: ErrorBody = { code, message, traceId };
    if (details !== undefined) {
      body.details = details;
    }

    response.status(status).json(body);
  }

  /**
   * HTTP 状态码 → 业务错误码的映射。
   *
   * 写成常量表而不是 switch：`exception.getStatus()` 返回的是普通 number，
   * 拿它去和 HttpStatus 枚举成员做 switch 逐个比较会触发
   * no-unsafe-enum-comparison（number 与枚举不共享枚举类型）。
   * 查表既绕开这个规则，也把映射关系显式摆在文件顶部，便于审阅。
   * 未列出的状态码一律落到 INTERNAL_ERROR。
   */
  private static readonly CODE_BY_STATUS: ReadonlyMap<number, ErrorCode> =
    new Map([
      [HttpStatus.BAD_REQUEST, ERROR_CODES.VALIDATION_FAILED],
      [HttpStatus.UNAUTHORIZED, ERROR_CODES.UNAUTHORIZED],
      [HttpStatus.FORBIDDEN, ERROR_CODES.FORBIDDEN],
      [HttpStatus.NOT_FOUND, ERROR_CODES.NOT_FOUND],
      [HttpStatus.CONFLICT, ERROR_CODES.CONFLICT],
    ]);

  private codeForStatus(status: number): ErrorCode {
    return (
      AllExceptionsFilter.CODE_BY_STATUS.get(status) ??
      ERROR_CODES.INTERNAL_ERROR
    );
  }
}
