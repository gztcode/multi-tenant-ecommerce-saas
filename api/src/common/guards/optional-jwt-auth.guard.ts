import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';
import { Observable, firstValueFrom } from 'rxjs';
import { UserRole } from '@prisma/client';
import type { CurrentUserPayload } from '../decorators/current-user.decorator';

/**
 * 可选认证守卫：购物车这类「游客或登录」的接口用。
 *
 * 与 JwtAuthGuard 的区别：
 * - JwtAuthGuard：**没有令牌就 401**。它挂在 controller 上时整组路由都必须登录。
 * - 本守卫：**带了令牌就认真验**（令牌无效照样 401），**没带令牌就放行**
 *   （request.user 为 undefined，请求按游客处理）。
 *
 * ⚠️ 为什么不用 @Public() 代替它：
 * @Public() 只放行**身份认证**这一层，租户上下文拦截器照常工作——
 * 但它放行之后 request.user 仍然是 undefined，于是**登录用户也被当成游客**，
 * 拿不到 customerId。购物车需要区分「游客车」与「账号车」，
 * 所以必须保留「有令牌就填 user」这个行为。
 *
 * 租户上下文仍然由 TenantContextInterceptor 决定：
 * 带令牌 → 租户取 JWT 里的 tenantId；匿名 → 按子域名解析店铺。
 *
 * ⚠️ **只接受消费者身份**：购物车与地址簿是消费者侧的资源（设计 §十 10.1）。
 * 商家令牌打到这里一律 403——商家后台自己开店，不该在店铺前台攒出一台
 * 「消费者购物车」（carts.customerId 指向的是 User.id，不区分角色，
 * 放行的话商家会在前台平白多出一台车）。
 *
 * ⚠️ 为什么不用项目既有的 `@Roles(UserRole.CUSTOMER)`：
 * `@Roles()` 装饰器会**连带挂上 `JwtAuthGuard`**（认证必然先于鉴权，
 * 见 common/decorators/roles.decorator.ts 的说明），而 `JwtAuthGuard`
 * **没有令牌就 401**——那就把游客挡在门外了。本守卫要的是
 * 「令牌有就验、没有就放行」，与 `@Roles()` 的前提互斥，
 * 所以角色判断只能内联在这里。
 *
 * 刻意**不**把非消费者降级成游客：商家在前台误带了自己的令牌时，
 * 静默变成游客车会让他以为「购物车丢了」，403 才说得清发生了什么。
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  canActivate(context: ExecutionContext) {
    // 先收敛成 Request 再取 header：getRequest() 返回 any，
    // 直接访问成员会触发 no-unsafe-member-access。
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;

    // 没有 Authorization 头 → 放行，按游客处理。
    // 只认 Bearer 前缀：别的 scheme（如 Basic）不该被当成 JWT 送去验签。
    if (!header || !header.startsWith('Bearer ')) {
      return true;
    }

    // 带了令牌就认真验：过期、签名不对、被停用 → 401。
    // 刻意**不**对令牌无效的情况降级成游客——那会让「我登录了但看到的是
    // 游客购物车」这种状态变得难以察觉，合并逻辑也会跑偏。
    const canActivate = super.canActivate(context);

    // Passport 的 canActivate 有三种返回值：boolean / Promise / Observable。
    // AuthGuard('jwt') 走的是 Promise 分支，但类型上三者都可能，
    // 这里显式收窄，别让 any 渗进来。
    const pending =
      canActivate instanceof Promise
        ? canActivate
        : canActivate instanceof Observable
          ? firstValueFrom(canActivate)
          : Promise.resolve(canActivate);

    // ⚠️ 认证失败时 Passport 会自己抛 UnauthorizedException，
    // 这里不会拿到值——所以下面的 user 一定存在。
    return pending.then(() => {
      const user = (request as Request & { user?: CurrentUserPayload }).user;
      if (user && user.role !== UserRole.CUSTOMER) {
        throw new ForbiddenException('该接口只对消费者开放');
      }
      return true;
    });
  }
}
