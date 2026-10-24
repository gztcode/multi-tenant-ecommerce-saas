import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { resolveTenantSubdomain } from '@/lib/tenant';
import { isTokenExpired } from '@/lib/token-expiry';

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
 * 正在进行中的刷新：刷新令牌 → 同一个 Promise。
 *
 * ⚠️ **必须有这个去重**。
 *
 * 后端的刷新是**轮换**式的：旧刷新令牌用掉就作废（设计 §6.4），
 * 而被再次使用的那一枚会被当成**重放**，连带把用户**其它设备**的登录一起吊销。
 *
 * `jwt` 回调会在**每次读会话**时跑，而一次请求可能读好几次
 * （`/api/auth/session`、页面里的 `auth()`、中间件……），
 * 这些读常常是**并发**的。没有去重的话：
 * 两个并发刷新带着同一枚旧令牌打过去 → 第一个成功并轮换，
 * 第二个拿着已作废的令牌 → 后端判定重放 → 整个令牌族被吊销 →
 * 用户在所有设备上被踢下线。
 *
 * 所以同一枚刷新令牌在途的刷新**只发一次**，后来的调用等同一个 Promise。
 */
const inFlightRefreshes = new Map<string, Promise<RefreshedTokens | null>>();

interface RefreshedTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * 用刷新令牌换一对新令牌。
 *
 * 返回 null 表示刷新失败（刷新令牌过期、被吊销、并发被别人先刷新了）。
 * 调用方据此把会话作废，让用户重新登录——这比拿着一枚过期令牌
 * 继续发请求、让每个接口都回 401 要好。
 */
async function refreshTokens(refreshToken: string): Promise<RefreshedTokens | null> {
  // 同一枚令牌已有刷新在途：等它，不重复发请求
  const existing = inFlightRefreshes.get(refreshToken);
  if (existing) return existing;

  const pending = requestRefresh(refreshToken);
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
): Promise<RefreshedTokens | null> {
  try {
    const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      accessToken?: string;
      refreshToken?: string;
    };
    if (!data.accessToken || !data.refreshToken) return null;
    return { accessToken: data.accessToken, refreshToken: data.refreshToken };
  } catch {
    // 后端没起来、网络断了——都按刷新失败处理
    return null;
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
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
      async authorize(credentials, request) {
        // 从**当前请求**解析店铺子域名，而不是读环境变量——
        // 一个进程服务所有店铺时，环境变量是固定的，会把顾客永远限定到
        // 同一家店。NextAuth v5 的 authorize 第二个参数就是 Request。
        const subdomain = resolveTenantSubdomain(request?.headers);

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
    async jwt({ token, user }) {
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

      const refreshed = await refreshTokens(refreshToken);
      if (!refreshed) {
        // 刷新令牌也用不了了（过期/被吊销/被别人先轮换走了）：
        // 作废整个会话，让用户重新登录。
        // 保留 accessToken 反而会让每个接口都回 401，
        // 用户看到的现象是「点了没反应」而不是「请重新登录」。
        return { ...token, accessToken: undefined, refreshToken: undefined } as typeof token;
      }

      token.accessToken = refreshed.accessToken;
      token.refreshToken = refreshed.refreshToken;
      return token;
    },
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
});