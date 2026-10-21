import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import type { Request } from 'express';
import type { CurrentUserPayload } from '../decorators/current-user.decorator';

/**
 * @Roles() 写入的元数据键。定义在本文件而非装饰器里，是为了断开循环依赖：
 * 装饰器需要 import RolesGuard 来挂守卫，若守卫再 import 装饰器拿 ROLES_KEY，
 * 两边互相 import 后模块初始化顺序决定谁先 undefined，
 * 报错还会落在 canActivate 里（ROLES_KEY is undefined），很难一眼定位。
 * 依赖方向固定为 装饰器 → 守卫，单向。
 */
export const ROLES_KEY = 'roles';

/**
 * 角色守卫：校验当前用户是否在 @Roles() 声明的角色集合内。
 *
 * 由 @Roles() 挂到路由的方法元数据上，不注册为 APP_GUARD。
 * NestJS 的守卫执行顺序是 [...全局, ...类级, ...方法级]，注册成全局守卫
 * 会让它跑在 JwtAuthGuard 之前，request.user 尚未填充。
 * 没挂 @Roles() 的路由根本不会经过这个守卫，角色限制是逐路由显式开启的。
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // 没有 @Roles() 标注的路由不受角色限制
    if (!required || required.length === 0) {
      return true;
    }

    // 先收敛成 Request 再取 user：getRequest() 返回 any，
    // 直接访问成员会触发 no-unsafe-member-access。与 CurrentUser 装饰器同一写法。
    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user as CurrentUserPayload | undefined;

    if (!user) {
      throw new ForbiddenException('需要登录后访问');
    }

    if (!required.includes(user.role)) {
      throw new ForbiddenException('当前角色无权访问该资源');
    }

    return true;
  }
}
