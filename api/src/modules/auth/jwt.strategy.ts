import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { TenantStatus, UserRole } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import {
  platformScope,
  tenantContext,
} from '../../common/tenant/tenant-context';

export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
  tenantId: string | null;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly prisma: TenantPrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey:
        process.env.JWT_SECRET ??
        'change-me-in-production-at-least-32-chars-long',
    });
  }

  async validate(payload: JwtPayload) {
    // JWT 已通过签名校验，按 ID 查询用户是安全的跨租户读取。
    // 此处还处于 Guard 阶段，租户拦截器尚未执行，因此没有租户上下文，
    // 必须显式使用平台作用域。
    //
    // ⚠️ run() 回调必须是 async 函数（PrismaPromise 是 thenable）。
    const user = await tenantContext.run(platformScope(), async () =>
      this.prisma.user.findFirst({
        where: { id: payload.sub },
      }),
    );

    // 令牌本身签名有效还不够：用户可能已被删除或停用。
    // 不查库的话，删除用户的旧令牌在过期前仍可继续使用。
    if (!user) {
      throw new UnauthorizedException('用户不存在或已被删除');
    }

    // 商家被平台停用后，他手里的 token 必须在有效期内立刻失效——
    // 否则「停用」这个管理动作形同虚设，用户能继续用满整个 JWT 有效期。
    // 平台超管没有 tenantId，不受此检查约束。
    if (user.tenantId) {
      const tenant = await tenantContext.run(platformScope(), async () =>
        this.prisma.tenant.findFirst({
          where: { id: user.tenantId! },
          select: { status: true },
        }),
      );

      if (!tenant) {
        throw new UnauthorizedException('所属商家不存在');
      }

      if (tenant.status === TenantStatus.SUSPENDED) {
        throw new UnauthorizedException('所属商家已被停用');
      }
    }

    // 返回值会挂在 request.user 上，被租户上下文拦截器用来重建租户上下文。
    // 因此必须以**库里的当前值**为准，而不是令牌里的 payload 快照——
    // 否则用户被改角色或转移租户后，旧令牌仍会带着过期身份继续通行。
    return {
      userId: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
    };
  }
}
