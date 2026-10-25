import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import type { NextRequest } from 'next/server';
import { resolveTenantSubdomain } from '@/lib/tenant';
import { isTokenExpired } from '@/lib/token-expiry';
import { refreshTokens, shouldInvalidateSession } from '@/lib/token-refresh';

const API_BASE_URL =
  process.env.API_BASE_URL ?? 'http://localhost:3000/api/v1';

declare module 'next-auth' {
  interface Session {
    accessToken: string;
    role: string;
    tenantId: string | null;
  }
}

/**
 * 登录成功后由 authorize 返回、随后被塞进 JWT 的用户对象。
 *
 * 这里显式带上后端返回的 accessToken/refreshToken：storefront 的服务端组件
 * 要用它调后端，而 NextAuth 默认不会把 provider 返回的字段写进 session。
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
 * 刷新逻辑在 `@/lib/token-refresh.ts`——本文件只负责 NextAuth 的配置。
 *
 * ⚠️ 抽出来是为了**可测**：`auth.ts` 顶层就调 `NextAuth({...})`，
 * import 它就会真的初始化 next-auth 的整个依赖图（含 `server-only`）。
 *
 * ⚠️ 本文件与 `merchant-admin/src/auth.ts` 是同一套逻辑的副本，
 * 改动其中一份时**必须同步另一份**。
 */

/**
 * 造 `jwt` 回调。
 *
 * @param canDeliverCookie 这次读会话**能不能把刷新后的 cookie 交回浏览器**。
 *
 * ## 为什么这个参数是整个修复的关键
 *
 * 后端的刷新是**轮换**式的：旧刷新令牌用掉就作废，再被用一次会被判成
 * 「真正的重放」→ `revokeTokenFamily` 吊销该用户**所有设备**的登录
 * （api/src/modules/auth/auth.service.ts）。
 *
 * ⚠️ **Server Component 里的 `await auth()` 拿不到 `Set-Cookie`**：
 * next-auth 的那条分支只取响应体（`parseSessionResponse`），
 * 把响应头丢掉了。所以在这里刷新 = 服务端把旧令牌轮换掉、
 * 而**浏览器永远拿不到新令牌** → 浏览器下次读会话又用那枚作废的旧令牌
 * → 后端判重放 → 吊销全族。
 *
 * 实测（阶段 4 验收记录 §三 场景 2）：**商家只要开第二个标签页就被踢下线**，
 * 后端 `refresh_tokens` 表里 9 枚令牌在同一毫秒被标成 `REPLAY`。
 *
 * ⇒ 所以**只在 cookie 送得回去的地方刷新**：
 * - NextAuth 自带的 `/api/auth/session` 路由
 *   （`src/app/api/auth/[...nextauth]/route.ts` 导出的那个）
 * - middleware
 *
 * 这两条路径 next-auth 都会把刷新后的 cookie 写进响应头。
 * Server Component 那条路**不刷新**——它只是读 cookie 里已有的令牌，
 * 不会把令牌作废掉。
 */
function makeJwtCallback(canDeliverCookie: boolean) {
  return async function jwt({
    token,
    user,
  }: {
    token: Record<string, unknown>;
    user?: unknown;
  }): Promise<Record<string, unknown>> {
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
    // 不刷新的话，用户登录两小时后点「加入购物车」，
    // 中转路由带过去的还是那枚过期令牌 → 后端 401 →
    // 界面上一句没头没尾的「Unauthorized」，购物车页还会显示
    // 「购物车是空的」（车其实还在库里）。
    //
    // `jwt` 回调在每次读会话时都会跑，所以这里就是刷新点。
    const accessToken = token.accessToken as string | undefined;
    const refreshToken = token.refreshToken as string | undefined;
    if (!accessToken || !refreshToken) return token;

    if (!isTokenExpired(accessToken, Math.floor(Date.now() / 1000))) {
      return token;
    }

    // ⚠️ **送不回去就别刷**（见上面 `canDeliverCookie` 的说明）。
    //
    // 这不是「不刷新」，而是「**不在这里**刷新」：客户端组件会去打
    // 同源的 `/api/session`（Route Handler），那里刷完能把 cookie 送回去。
    if (!canDeliverCookie) {
      return token;
    }

    const result = await refreshTokens(refreshToken);
    if (!result || !result.ok) {
      if (!shouldInvalidateSession(result)) {
        // ⚠️ **网络失败 ≠ 凭证失效**（设计文档 §5.1 的 L18）。
        // 后端只是没响应（重启、抖动、一次 200ms 的卡顿）——
        // 凭证多半还是好的。**保留旧令牌**，让本次请求失败（401），
        // 下次读会话时再试一次。
        //
        // 若在这里作废会话：一次抖动就把用户**永久踢出登录**
        // （refreshToken 也被清掉，必须重新登录），而且不可逆。
        return token;
      }
      // 刷新令牌也用不了了（过期/被吊销/被别人先轮换走了）：
      // 作废整个会话，让用户重新登录。
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
 * NextAuth 的配置。
 *
 * ⚠️ **用函数形式**（而不是对象字面量），因为只有函数形式能拿到
 * 「这次读会话的请求」——而我们需要据此判断**cookie 送不送得回去**：
 * - Server Component 里的 `await auth()` → 传进来的是 `undefined`
 * - Route Handler 的包装器 `auth((req) => ...)` 与 middleware → 传进来的是 Request
 *
 * next-auth 的源码（node_modules/next-auth/lib/index.js）：
 * Server Component 分支调 `config(undefined)`，其余分支调 `config(request)`。
 */
export const { handlers, auth, signIn, signOut } = NextAuth(
  async (request: NextRequest | undefined) => ({
    session: { strategy: 'jwt' },
    trustHost: true,
    pages: { signIn: '/login' },
    providers: [
      Credentials({
        name: 'customer',
        credentials: {
          email: { label: '邮箱', type: 'email' },
          password: { label: '密码', type: 'password' },
        },
        async authorize(credentials, req) {
          // 从**当前请求**解析店铺子域名，而不是读环境变量——
          // 一个进程服务所有店铺时，环境变量是固定的，会把顾客永远限定到
          // 同一家店。NextAuth v5 的 authorize 第二个参数就是 Request。
          const subdomain = resolveTenantSubdomain(req?.headers);

          const response = await fetch(`${API_BASE_URL}/auth/login`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-tenant-subdomain': subdomain,
            },
            body: JSON.stringify({
              email: credentials?.email,
              password: credentials?.password,
              scope: 'CUSTOMER',
            }),
          });

          if (!response.ok) {
            // 登录失败不返回具体原因（邮箱不存在 vs 密码错误），
            // 交给登录页统一显示「邮箱或密码不正确」。
            return null;
          }

          const data = (await response.json()) as {
            user: {
              id: string;
              email: string;
              displayName: string;
              role: string;
              tenantId: string | null;
            };
            accessToken: string;
            refreshToken: string;
          };

          return {
            id: data.user.id,
            email: data.user.email,
            name: data.user.displayName,
            role: data.user.role,
            tenantId: data.user.tenantId,
            accessToken: data.accessToken,
            refreshToken: data.refreshToken,
          } satisfies AuthUser;
        },
      }),
    ],
    callbacks: {
      jwt: makeJwtCallback(request !== undefined),
      async session({ session, token }) {
        // 会话已作废（刷新失败）：不该再给出一个「看起来登录着」的会话。
        // accessToken 为空 → 中转路由按游客处理，用户界面上也能看出
        // 自己掉登录了，而不是拿着空令牌去撞后端的 401。
        session.accessToken = (token.accessToken as string | undefined) ?? '';
        session.role = token.role as string;
        session.tenantId = (token.tenantId as string | null) ?? null;
        return session;
      },
    },
  }),
);
