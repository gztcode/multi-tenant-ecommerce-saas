import { SetMetadata, applyDecorators, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { ROLES_KEY, RolesGuard } from '../guards/roles.guard';
import { JwtAuthGuard } from '../../modules/auth/jwt-auth.guard';

export { ROLES_KEY };

/**
 * 声明某条路由允许访问的角色集合。
 *
 * 为什么在一次 UseGuards 里同时挂 JwtAuthGuard：
 *
 * 1. 不注册成 APP_GUARD。NestJS 组装守卫列表是 [...全局, ...类级, ...方法级]
 *    （@nestjs/core/helpers/context-creator.js 的 createContext），
 *    全局守卫永远先于路由级 @UseGuards 跑，那时 request.user 还没填。
 * 2. 不依赖装饰器堆叠顺序。方法装饰器由 TS 自下而上应用，
 *    分开写 @UseGuards(JwtAuthGuard) 和 @Roles() 时，
 *    谁先注册取决于源码里谁写在下面，顺序是隐式的、写错就静默越权。
 *    在**同一次** UseGuards 里显式排 [JwtAuthGuard, RolesGuard]，
 *    数组顺序即执行顺序，认证必然先于鉴权。
 *
 * 副作用（且是想要的）：标了 @Roles() 的路由自动带认证，
 * 未登录访问得到 401 而非 403，两种失败语义不再混淆。
 */
export const Roles = (...roles: UserRole[]) =>
  applyDecorators(
    SetMetadata(ROLES_KEY, roles),
    UseGuards(JwtAuthGuard, RolesGuard),
  );
