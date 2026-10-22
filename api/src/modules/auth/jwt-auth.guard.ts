import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { PUBLIC_KEY } from '../../common/decorators/public.decorator';

/**
 * JWT 认证守卫。
 *
 * 只做「令牌有效 + 用户存在」这一层；角色级别的越权防护属于 Task 7 的 RBAC 守卫，
 * 这里刻意不混入，避免两种失败语义（401 未认证 / 403 已认证但无权限）混在一个守卫里。
 *
 * 命中 @Public() 的路由直接放行——但**只放行身份认证**，
 * 租户上下文拦截器不受影响，公开读依然经过租户隔离。
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }
}
