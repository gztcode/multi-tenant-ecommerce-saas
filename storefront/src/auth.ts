import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { resolveTenantSubdomain } from '@/lib/tenant';

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
      }
      return token;
    },
    async session({ session, token }) {
      session.accessToken = token.accessToken as string;
      session.role = token.role as string;
      session.tenantId = (token.tenantId as string | null) ?? null;
      return session;
    },
  },
});