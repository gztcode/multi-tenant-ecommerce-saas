/**
 * 给一个 Promise 加超时。
 *
 * ⚠️ **超时不会取消底层操作**：`Promise.race` 只是让调用方先拿到一个错误，
 * 底层那个 Promise 仍在跑（Redis 恢复后它可能**还会成功**）。
 * 「超时之后那个操作还算不算数」由调用方自己判断。
 *
 * 典型场景：BullMQ 覆盖了 ioredis 的 `retryStrategy` → 无限重试 →
 * Redis 不可达时 `queue.add()` 的 Promise 永远不 settle → 请求永久挂住。
 */

/** 超时错误。带可读的名字，方便日志与断言。 */
export class TimeoutError extends Error {
  constructor(
    readonly what: string,
    readonly timeoutMs: number,
  ) {
    super(`操作超时（${timeoutMs}ms）：${what}`);
    this.name = 'TimeoutError';
  }
}

/**
 * 在 `timeoutMs` 内等 `promise`；超时则抛 {@link TimeoutError}。
 *
 * @param what 超时时的可读描述（会进错误消息）
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new TimeoutError(what, timeoutMs)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
