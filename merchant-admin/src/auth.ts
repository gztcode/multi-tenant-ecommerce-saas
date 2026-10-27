import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import type { NextRequest } from 'next/server';
import type { Session } from 'next-auth';
import {
  makeJwtCallback,
  makeSessionCallback,
  type AuthUser,
  type JwtToken,
  type SessionLike,
} from '@/lib/jwt-callback';

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
 * 刷新逻辑在 `@/lib/jwt-callback.ts`——本文件只负责 NextAuth 的配置。
 *
 * ⚠️ 抽出来是为了**可测**：`auth.ts` 顶层就调 `NextAuth({...})`，
 * import 它就会真的初始化 next-auth 的整个依赖图（含 `server-only`）。
 *
 * ⚠️ 本文件与 `storefront/src/auth.ts` 是同一套逻辑的副本，
 * 改动其中一份时**必须同步另一份**。
 */

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
        name: 'merchant',
        credentials: {
          email: { label: '邮箱', type: 'email' },
          password: { label: '密码', type: 'password' },
        },
        async authorize(credentials) {
          // 与 storefront 不同：商家后台不带 x-tenant-subdomain。
          // 中心域名上没有「当前店铺」的概念，租户身份完全由后端按登录账号绑定。
          const response = await fetch(`${API_BASE_URL}/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              email: credentials?.email,
              password: credentials?.password,
              scope: 'MERCHANT',
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
      // ⚠️ **这里做一次类型适配**：next-auth 期望的 `Session` 比
      // `SessionLike` 多一些字段（`user`、`expires`），而 `jwt-callback.ts`
      // 不能 import next-auth 的类型（否则 Vitest 会去解析它的依赖图）。
      // 适配放在**这一侧**，不污染被测模块。
      session: async (params) =>
        (await makeSessionCallback()(params as unknown as {
          session: SessionLike;
          token: JwtToken;
        })) as unknown as Session,
    },
  }),
);
