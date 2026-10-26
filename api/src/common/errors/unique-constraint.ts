import { ConflictException } from '@nestjs/common';

/**
 * 是不是 Prisma 的唯一约束冲突（P2002）。
 *
 * 刻意用 `error.code === 'P2002'` 而不是
 * `error instanceof Prisma.PrismaClientKnownRequestError`：
 * `@prisma/client` 在 CJS/ESM 混载或多处 require 时会得到不同的模块实例，
 * instanceof 于是恒为 false。
 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

/**
 * 把 Prisma 的唯一约束冲突（P2002）翻译成 409。
 *
 * 为什么要自己处理：P2002 一路冒到全局异常过滤器会变成 500「服务器内部错误」，
 * 用户建了个重名的品类只看到一句看不懂的话。这里在 service 层就地转成
 * `ConflictException`，文案还能精确指出是哪个字段重复了。
 *
 * 非 P2002 的异常原样抛出——**不要在这里吞掉任何别的错误**，
 * 那会把真实故障伪装成「重名了」。
 */
export function rethrowIfUniqueViolation(
  error: unknown,
  fieldLabel: string,
): never {
  if (isUniqueViolation(error)) {
    throw new ConflictException(`${fieldLabel} 已被占用，换一个再试`);
  }
  throw error;
}
