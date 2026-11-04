/**
 * 访问令牌的刷新。
 *
 * ## 为什么从 `auth.ts` 里抽出来
 *
 * `auth.ts` 顶层就调用 `NextAuth({...})`，import 它就会真的初始化
 * NextAuth（连带 next-auth 的整个依赖图，含 `server-only`）。
 * 抽出来才能直接进单元测试。
 *
 * ⚠️ 本文件是 `storefront/src/lib/token-refresh.ts` 与
 * `merchant-admin/src/lib/token-refresh.ts` 这**两份文件的副本**，
 * 两份**逐行一致**（diff 无输出）。
 * 改动其中一份时**必须同步另一份**——
 * 判据是两边的 `test/lib/token-refresh.test.ts` 断言相同的行为
 * （见「两份文件逐行 diff」这条约定）。
 */

/**
 * 后端地址。
 *
 * ⚠️ **必须真的定义它**（不要只写在注释里）——
 * 否则 `requestRefresh` 里引用 `${API_BASE_URL}` 会抛
 * `ReferenceError: API_BASE_URL is not defined`。
 * 与各应用 `src/auth.ts` 顶部的写法保持一致。
 */
const API_BASE_URL =
  process.env.API_BASE_URL ?? 'http://localhost:3000/api/v1';

/**
 * 正在进行中的刷新：刷新令牌 → 同一个 Promise。
 *
 * ⚠️ **必须有这个去重**。
 *
 * 后端的刷新是**轮换**式的：旧刷新令牌用掉就作废
 * （api/src/modules/auth/auth.service.ts 第 284–290 行），
 * 而被再次使用的那一枚会被当成**重放**，连带把用户**其它设备**的登录一起吊销
 * （同文件第 268 行 revokeTokenFamily）。
 *
 * `jwt` 回调会在**每次读会话**时跑，而一次请求可能读好几次
 * （`/api/auth/session`、页面里的 `auth()`、middleware……），
 * 这些读常常是**并发**的。没有去重的话：
 * 两个并发刷新带着同一枚旧令牌打过去 → 第一个成功并轮换，
 * 第二个拿着已作废的令牌 → 后端判定重放 → 整个令牌族被吊销 →
 * 用户在所有设备上被踢下线。
 *
 * 所以同一枚刷新令牌在途的刷新**只发一次**，后来的调用等同一个 Promise。
 *
 * ⚠️ **这个去重只在单进程内有效**（模块级变量）。扩副本前必须换成
 * Redis 侧的分布式锁。
 *
 * ⚠️ **阶段 5c 起，后端有了宽限期**（`api/src/modules/auth/auth.service.ts`
 * 的 `handleRevokedToken`）：同一枚令牌在 60 秒内被重复提交时，
 * 后端返回**同一枚**新令牌，不吊销令牌族。所以「客户端超时后重试」、
 * 「两个标签页串行抵达」、「跨副本各刷一次」这些情况
 * **不再把用户踢下线**。
 *
 * ⚠️ **但宽限期不替代本文件里的去重，也不替代 `auth.ts` 里的
 * `canDeliverCookie` 判断**：后端认得「这枚旧令牌我刚发过新令牌」，
 * 但前端**送不回**刷新结果时，轮换仍会发生，每读一次会话就把令牌
 * 往作废的方向推一步。两者是**互补**的，都必要。
 */
const inFlightRefreshes = new Map<string, Promise<RefreshResult | null>>();

export interface RefreshedTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * 刷新结果的三态。
 *
 * ⚠️ **必须区分「网络失败」与「凭证失效」**（设计文档 §5.1 的 L18）。
 *
 * - `invalid`：后端**明确**返回 401/403 → 凭证真的失效了 → 作废整个会话。
 * - `network`：**请求根本没发出去或没拿到响应**（后端没起来、网络断了、
 *   一次 200ms 的抖动）→ **凭证多半还是好的** → **保留旧令牌**，
 *   让本次请求失败即可。
 *
 * 把两者混为一谈的后果：一次网络抖动就把商家**永久踢出登录**
 * （accessToken 与 refreshToken 都被清掉，必须重新登录）。
 */
export type RefreshResult =
  | { ok: true; tokens: RefreshedTokens }
  | { ok: false; reason: 'invalid' | 'network' };

/**
 * 这次刷新失败**要不要作废整个会话**。
 *
 * ⚠️ **只有「凭证失效」才作废**（设计文档 §5.1 的 L18）。
 *
 * - `invalid`（后端明确返回 401/403）→ 作废 → 用户重新登录。
 * - `network`（网络失败 / 5xx / 响应不完整）→ **不作废** → 保留旧令牌，
 *   让本次请求失败（401），下次读会话时再试一次。
 *
 * 抽成函数是为了**能测**：`auth.ts` 的 `jwt` 回调没法进单元测试
 * （`auth.ts` 顶层就调 `NextAuth({...})`，import 它就会初始化 next-auth，
 * 在 Vitest 的 node 环境里直接报 `Cannot find module 'next/server'`）。
 */
export function shouldInvalidateSession(
  result: RefreshResult | null,
): boolean {
  return !!result && !result.ok && result.reason === 'invalid';
}

/**
 * 用刷新令牌换一对新令牌。
 *
 * 返回 null 表示「本次刷新没有拿到新令牌」，具体原因看 `RefreshResult`。
 */
export async function refreshTokens(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RefreshResult | null> {
  const existing = inFlightRefreshes.get(refreshToken);
  if (existing) return existing;

  const pending = requestRefresh(refreshToken, fetchImpl);
  inFlightRefreshes.set(refreshToken, pending);
  try {
    return await pending;
  } finally {
    // 只清掉自己这一条：万一期间有别的一枚令牌发起了刷新，
    // 直接 clear 会把别人的也抹掉。
    if (inFlightRefreshes.get(refreshToken) === pending) {
      inFlightRefreshes.delete(refreshToken);
    }
  }
}

/** 真正发一次刷新请求 */
async function requestRefresh(
  refreshToken: string,
  fetchImpl: typeof fetch,
): Promise<RefreshResult | null> {
  let response: Response;
  try {
    response = await fetchImpl(`${API_BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      cache: 'no-store',
    });
  } catch {
    // ⚠️ **网络失败**：请求没发出去或没拿到响应。
    // 这**不代表凭证失效**——保留旧令牌，让调用方按「本次请求失败」处理，
    // 不要作废会话（设计文档 §5.1 的 L18）。
    return { ok: false, reason: 'network' };
  }

  if (response.status === 401 || response.status === 403) {
    // ⚠️ **凭证失效**：后端明确拒了。调用方据此作废整个会话。
    return { ok: false, reason: 'invalid' };
  }
  if (!response.ok) {
    // 其它错误（5xx 等）：后端没给出「凭证无效」的结论，
    // 按网络类失败处理——保留旧令牌，下次再试。
    return { ok: false, reason: 'network' };
  }

  const data = (await response.json()) as {
    accessToken?: string;
    refreshToken?: string;
  };
  if (!data.accessToken || !data.refreshToken) {
    // 响应不完整：当作「没刷新成」，但**不**判定凭证失效。
    return { ok: false, reason: 'network' };
  }
  return {
    ok: true,
    tokens: { accessToken: data.accessToken, refreshToken: data.refreshToken },
  };
}
