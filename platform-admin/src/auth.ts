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

import { assertAuthSecret } from '@ecom/frontend-shared/assert-auth-secret';
import {
  makeSignOutEvent,
  type SignOutEventMessage,
} from '@ecom/frontend-shared/sign-out';

// ⚠️ 必须在模块求值时失败：NextAuth 在模块加载阶段就读取它。
assertAuthSecret(process.env.AUTH_SECRET);

const API_BASE_URL =
  process.env.API_BASE_URL ?? 'http://localhost:3000/api/v1';

/**
 * 登出时吊销后端刷新令牌。
 *
 * ⚠️ **NextAuth 的 `signOut()` 只清本地 cookie，不会通知后端**。
 * 不挂这个事件的话，超管点了「退出登录」，那枚刷新令牌仍然有效 30 天。
 * 失败只记日志、不阻断登出（见 `sign-out.ts`）。
 */
const revokeSessionOnSignOut = makeSignOutEvent({ apiBaseUrl: API_BASE_URL });

declare module 'next-auth' {
  interface Session {
    accessToken: string;
    role: string;
    tenantId: string | null;
  }
}

/**
 * 平台超管后台的 NextAuth 配置。
 *
 * ⚠️ **必须是函数形式**：只有函数形式能拿到「这次读会话的请求」，
 *    刷新逻辑据此判断 cookie 送不送得回去。
 *    对象形式没有过期刷新分支 —— 超管登录 2 小时后所有中转路由 401，
 *    但界面仍显示已登录，且无法自愈。
 *
 * ⚠️ **与 merchant-admin 唯一的差别**：`scope` 固定为 `'PLATFORM'`。
 *    后端 login 会按 scope 过滤候选角色，写错只会得到「密码错误」。
 *    平台后台跑在中心域名，不带 `x-tenant-subdomain`。
 */
export const { handlers, auth, signIn, signOut } = NextAuth(
  async (request: NextRequest | undefined) => ({
    session: { strategy: 'jwt' },
    trustHost: true,
    pages: { signIn: '/login' },
    providers: [
      Credentials({
        name: 'platform',
        credentials: {
          email: { label: '邮箱', type: 'email' },
          password: { label: '密码', type: 'password' },
        },
        async authorize(credentials) {
          const response = await fetch(`${API_BASE_URL}/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              email: credentials?.email,
              password: credentials?.password,
              scope: 'PLATFORM',
            }),
          });

          if (!response.ok) {
            // 登录失败不返回具体原因，交给登录页统一显示「邮箱或密码不正确」。
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
    // ⚠️ **登出只是清本地 cookie 的话，后端那枚刷新令牌还能用 30 天。**
    // 这里把 JWT 里的 refreshToken 交给后端 `/auth/logout` 真正吊销。
    events: {
      signOut: (message) =>
        revokeSessionOnSignOut(message as unknown as SignOutEventMessage),
    },
    callbacks: {
      jwt: makeJwtCallback(request !== undefined),
      // ⚠️ 类型适配放在这一侧，不污染被测模块（与另两端同构）。
      session: async (params) =>
        (await makeSessionCallback()(params as unknown as {
          session: SessionLike;
          token: JwtToken;
        })) as unknown as Session,
    },
  }),
);
