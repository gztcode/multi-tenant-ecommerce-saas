import { isTokenExpired } from './token-expiry';
import {
  refreshTokens,
  shouldInvalidateSession,
  type RefreshResult,
} from './token-refresh';

/**
 * `jwt` 回调里那个 token 的最小形状。
 *
 * ⚠️ **自己定义而不是 import next-auth 的类型**：
 * `import type` 虽然编译后会被擦除，但一旦写成普通的 `import`，
 * Vitest 就会去解析 next-auth 的依赖图 → 同样的
 * `Cannot find module 'next/server'`。
 *
 * ⚠️ 本文件是 `storefront/src/lib/jwt-callback.ts` 与
 * `merchant-admin/src/lib/jwt-callback.ts` 这**两份文件的副本**，
 * 两份**逐行一致**（diff 无输出）。
 */

/** next-auth 的 jwt 回调里那个 token */
export interface JwtToken {
  accessToken?: string;
  refreshToken?: string;
  role?: string;
  tenantId?: string | null;
  [key: string]: unknown;
}

/** next-auth 的 session */
export interface SessionLike {
  accessToken: string;
  role: string;
  tenantId: string | null;
}

/**
 * 登录成功后由 authorize 返回、随后被塞进 JWT 的用户对象。
 *
 * 租户身份完全由 JWT 里的 `tenantId` 决定——
 * 所以这里把后端返回的字段原样带上就够了。
 */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: string;
  tenantId: string | null;
  accessToken: string;
  refreshToken: string;
}

/**
 * 造 `jwt` 回调。
 *
 * @param canDeliverCookie 这次读会话**能不能把刷新后的 cookie 交回浏览器**。
 * @param refresh 刷新函数的注入点（默认用真实的 `refreshTokens`）。
 *   测试靠它断言「刷新成功了」而不必真的起一个后端。
 *
 * ## 为什么 `canDeliverCookie` 是整个修复的关键
 *
 * 后端的刷新是**轮换**式的：旧刷新令牌用掉就作废，再被用一次会被判成
 * 「真正的重放」→ `revokeTokenFamily` 吊销该用户**所有设备**的登录。
 *
 * ⚠️ **Server Component 里的 `await auth()` 拿不到 `Set-Cookie`**：
 * next-auth 的那条分支只取响应体，把响应头丢掉了。所以在这里刷新 =
 * 服务端把旧令牌轮换掉、而**浏览器永远拿不到新令牌** → 浏览器下次读会话
 * 又用那枚作废的旧令牌 → 后端判重放 → 吊销全族。
 *
 * 实测（阶段 4 验收记录 §三 场景 2）：**商家只要开第二个标签页就被踢下线**，
 * 后端 `refresh_tokens` 表里 9 枚令牌在同一毫秒被标成 `REPLAY`。
 *
 * ⇒ 所以**只在 cookie 送得回去的地方刷新**：
 * - NextAuth 自带的 `/api/auth/session` 路由
 * - middleware
 *
 * Server Component 那条路**不刷新**——它只是读 cookie 里已有的令牌，
 * 不会把令牌作废掉。
 *
 * ## 阶段 5c 的补充：后端现在有宽限期
 *
 * 后端在 60 秒内对同一枚旧令牌返回**同一枚**新令牌（见
 * `api/src/modules/auth/auth.service.ts` 的 `handleRevokedToken`），
 * 所以「客户端超时后重试」不再把用户踢下线。
 * ⚠️ **但那条缓解不替代本文件里的 `canDeliverCookie` 判断** ——
 * 后端认得「这枚旧令牌我刚发过新令牌」，但前端**送不回**刷新结果时，
 * 轮换仍会发生，每读一次会话就把令牌往作废的方向推一步。
 * 两者是**互补**的，都必要。
 */
export function makeJwtCallback(
  canDeliverCookie: boolean,
  refresh: (
    refreshToken: string,
  ) => Promise<RefreshResult | null> = refreshTokens,
) {
  return async function jwt({
    token,
    user,
  }: {
    token: JwtToken;
    user?: unknown;
  }): Promise<JwtToken> {
    if (user) {
      const authUser = user as AuthUser;
      token.accessToken = authUser.accessToken;
      token.refreshToken = authUser.refreshToken;
      token.role = authUser.role;
      token.tenantId = authUser.tenantId;
      return token;
    }

    // ⚠️ **访问令牌过期就刷新**。
    //
    // 后端的 accessToken 只有 2 小时，而 NextAuth 的会话默认活 30 天。
    // 不刷新的话，商家连续用超过 2 小时后，后台的每个请求都带一枚
    // 过期令牌 → 后端一律 401 → 商家看到「订单列表加载失败（401）」，
    // 而界面上仍然显示自己已登录。
    const accessToken = token.accessToken as string | undefined;
    const refreshToken = token.refreshToken as string | undefined;
    if (!accessToken || !refreshToken) return token;

    if (!isTokenExpired(accessToken, Math.floor(Date.now() / 1000))) {
      return token;
    }

    // ⚠️ **送不回去就别刷**（见上面 `canDeliverCookie` 的说明）。
    if (!canDeliverCookie) {
      return token;
    }

    const result = await refresh(refreshToken);
    if (!result || !result.ok) {
      if (!shouldInvalidateSession(result)) {
        // ⚠️ **网络失败 ≠ 凭证失效**。
        // 后端只是没响应（重启、抖动、一次 200ms 的卡顿）——
        // 凭证多半还是好的。**保留旧令牌**，让本次请求失败（401），
        // 下次读会话时再试一次。
        //
        // 若在这里作废会话：一次抖动就把用户**永久踢出登录**
        // （refreshToken 也被清掉，必须重新登录），而且不可逆。
        return token;
      }
      // 凭证真的失效了：作废整个会话，让用户重新登录。
      // 保留 accessToken 反而会让每个接口都回 401，
      // 用户看到的现象是「点了没反应」而不是「请重新登录」。
      return {
        ...token,
        accessToken: undefined,
        refreshToken: undefined,
      };
    }

    token.accessToken = result.tokens.accessToken;
    token.refreshToken = result.tokens.refreshToken;
    return token;
  };
}

/**
 * 造 `session` 回调。
 *
 * ⚠️ **accessToken 为空时要兜底成 `''`**：原来的
 * `token.accessToken as string` 只是**类型断言**，运行时 `undefined`
 * 会原样传出。会话已作废（刷新失败）时不该再给出一个「看起来登录着」的会话。
 */
export function makeSessionCallback() {
  return async function session({
    session,
    token,
  }: {
    session: SessionLike;
    token: JwtToken;
  }): Promise<SessionLike> {
    session.accessToken = (token.accessToken as string | undefined) ?? '';
    session.role = token.role as string;
    session.tenantId = (token.tenantId as string | null) ?? null;
    return session;
  };
}
