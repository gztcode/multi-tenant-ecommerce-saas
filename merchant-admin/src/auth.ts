import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';

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
 * 商家后台跑在中心域名（无店铺子域名），租户身份完全由 JWT 里的
 * `tenantId` 决定——所以这里把后端返回的字段原样带上就够了，不需要
 * 从请求头解析子域名。
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
