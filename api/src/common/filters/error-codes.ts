/**
 * 全局统一的业务错误码。
 *
 * 与 HTTP 状态码分开的原因：客户端要分支处理时，状态码粒度太粗
 * （400 里既有参数校验失败，也可能有别的参数错误），而字符串常量
 * 可以被精确定位、且不会因为 HTTP 语义变化而失效。
 */
export const ERROR_CODES = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  TENANT_SCOPE_VIOLATION: 'TENANT_SCOPE_VIOLATION',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
