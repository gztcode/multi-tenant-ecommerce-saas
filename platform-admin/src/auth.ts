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
 * 平台超管账号不属于任何租户（seed 里 tenantId 为 null），所以这里的
 * `tenantId` 对超管永远是 null——保留字段是为了与商家后台保持同一套
 * session 结构，将来超管需要以某个租户身份「代入」时不必改 session 契约。
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
      name: 'platform',
      credentials: {
        email: { label: '邮箱', type: 'email' },
        password: { label: '密码', type: 'password' },
      },
      async authorize(credentials) {
        // 与 merchant-admin 唯一的差别：scope 必须是 'PLATFORM'。
        // 后端 login 会按 scope 过滤候选角色（MERCHANT 只匹配商家角色），
        // 这里若写错成 'MERCHANT'，超管邮箱会被角色过滤掉，
        // 返回的是与「密码错误」完全相同的提示，极难排查。
        // 平台后台跑在中心域名，同样不带 x-tenant-subdomain。
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
          // 登录失败不返回具体原因（邮箱不存在 vs 密码错误 vs 角色不匹配），
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