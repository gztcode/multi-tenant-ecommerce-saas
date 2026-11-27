/**
 * 登出时**真正吊销后端刷新令牌**。
 *
 * ## 为什么需要这个文件
 *
 * NextAuth 的 `signOut()` 只做两件事：清掉浏览器里的会话 cookie、发一个
 * `events.signOut` 事件。**它不会通知后端**。后端的 `/auth/logout` 才是唯一
 * 会把 `refresh_tokens.revokedAt` 写上的地方（`api/src/modules/auth/auth.service.ts`
 * 的 `logout`）。少了这一步，用户点了「退出登录」之后，那枚刷新令牌仍然
 * 有效到签发后 30 天 —— 设备丢失、cookie 被偷时，「退出登录」形同虚设。
 *
 * 所以三个前端的 NextAuth 配置都挂上 `events.signOut`：
 *
 * ```ts
 * events: { signOut: makeSignOutEvent({ apiBaseUrl: API_BASE_URL }) }
 * ```
 *
 * ## 硬约束：吊销失败**绝不能阻断登出**
 *
 * 后端没起来、网络抖动、5xx —— 都只记日志，然后让 NextAuth 继续把
 * 本地会话清掉。否则用户会遇到「点了退出登录还在原地」，
 * 而这恰恰是最需要能退出去的时刻（例如在公共电脑上）。
 *
 * ⚠️ 本文件只吊销**当前这一枚**刷新令牌，不牵连该用户其它设备。
 * 「登出所有设备」是另一个产品决定，不要在这里顺手扩大。
 */

/** `events.signOut` 拿到的 JWT 里我们关心的字段（其余字段忽略） */
export interface SignOutTokenLike {
  accessToken?: string;
  refreshToken?: string;
  [key: string]: unknown;
}

/** `events.signOut` 的消息形状（JWT 会话策略下只有 `token`） */
export interface SignOutEventMessage {
  token?: SignOutTokenLike | null;
  session?: unknown;
}

export interface RevokeSessionOptions {
  /** 后端基地址，例如 `http://localhost:3000/api/v1` */
  apiBaseUrl: string;
  /** 注入点：测试传假的 fetch；生产用全局 fetch */
  fetchImpl?: typeof fetch;
  /** 超时毫秒数：后端卡住时不能把「退出登录」一起卡住 */
  timeoutMs?: number;
  /** 失败日志的注入点（默认 `console.error`） */
  onError?: (error: unknown) => void;
}

// 5 秒：本机与 CI 上后端冷启动（Nest 编译 + Prisma 连接池）时，
// 首个登出请求实测可能超过 3 秒；超时只会让前端提前放弃等待，
// 请求本身已经到达后端，吊销仍会完成 —— 但不能放弃得太早。
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * 调后端 `/auth/logout` 吊销这枚刷新令牌。
 *
 * @returns 真的吊销成功（2xx）返回 `true`；缺令牌、非 2xx、网络异常一律
 *   返回 `false`，**并且不抛异常**。
 */
export async function revokeBackendSession(
  token: SignOutTokenLike | null | undefined,
  options: RevokeSessionOptions,
): Promise<boolean> {
  const {
    apiBaseUrl,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onError = defaultOnError,
  } = options;

  const accessToken = token?.accessToken;
  const refreshToken = token?.refreshToken;

  // 没有可吊销的令牌就直接跳过：`/auth/logout` 需要访问令牌做身份校验，
  // 缺一枚都发不出有意义的请求（会话已作废时 jwt 回调会把两枚都清空）。
  if (typeof accessToken !== 'string' || accessToken === '') return false;
  if (typeof refreshToken !== 'string' || refreshToken === '') return false;

  try {
    const response = await fetchImpl(`${apiBaseUrl}/auth/logout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      // 后端只从这个字段读刷新令牌，不要多传别的字段（白名单习惯）。
      body: JSON.stringify({ refreshToken }),
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      report(
        onError,
        new Error(`后端登出失败：HTTP ${response.status}（本地会话仍会被清除）`),
      );
      return false;
    }

    return true;
  } catch (error) {
    report(onError, error);
    return false;
  }
}

/**
 * 造 NextAuth 的 `events.signOut` 处理器。
 *
 * ⚠️ **永不抛异常**：`@auth/core` 自己也会 try/catch 包一层，但那层只保证
 * 登出继续，`logger.error` 打出的是整段错误对象；这里先收敛成一条
 * 可读日志，顺便保证注入的 `onError` 自己抛了也不会漏出去。
 */
export function makeSignOutEvent(
  options: RevokeSessionOptions,
): (message: SignOutEventMessage) => Promise<void> {
  return async function signOutEvent(message: SignOutEventMessage) {
    try {
      await revokeBackendSession(message?.token, options);
    } catch (error) {
      // 双保险：`revokeBackendSession` 已自带 try/catch，
      // 这里只兜「onError 自己抛」这种意外。
      report(options.onError ?? defaultOnError, error);
    }
  };
}

/**
 * 记一条失败日志，**且保证记日志本身不会把异常漏出去**。
 *
 * 日志函数是注入点，测试或调用方完全可能传一个会抛的实现；
 * 那时如果直接把异常抛出去，`events.signOut` 就会 reject ——
 * 而这正是「吊销失败不能阻断登出」要防的事。
 */
function report(onError: (error: unknown) => void, error: unknown): void {
  try {
    onError(error);
  } catch {
    // 记日志都失败了就只能咽下去：登出的主流程比这条日志重要。
  }
}

function defaultOnError(error: unknown): void {
  console.error('[auth] 登出时吊销后端刷新令牌失败', error);
}
