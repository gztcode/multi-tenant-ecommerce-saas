import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, from, lastValueFrom } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import { Request } from 'express';
import { UserRole } from '@prisma/client';
import {
  TenantContextValue,
  tenantContext,
} from '../../common/tenant/tenant-context';
import { SKIP_KEY } from '../../common/decorators/skip.decorator';
import { TenantResolverService } from './tenant-resolver.service';

interface AuthenticatedUser {
  userId: string;
  role: UserRole;
  tenantId: string | null;
}

@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(
    private readonly resolver: TenantResolverService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // 标记了 @Skip() 的路由不建立租户上下文（健康检查等公共端点）
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<Request>();

    // buildContext 是异步的（要查租户表），必须先 await 再把上下文写进
    // AsyncLocalStorage。用 from + switchMap 把 Promise 转成 Observable，
    // 异常会沿 observable 的 error 通道冒泡到全局异常过滤器。
    return from(this.buildContext(request)).pipe(
      switchMap(
        (contextValue) =>
          new Observable((subscriber) => {
            // ⚠️ 这里的 run() 回调必须是 async 函数，不能是同步函数。
            //
            // 原因：Prisma 6 的 query 调用返回的是 PrismaPromise（thenable 而非
            // 原生 Promise），真正的 SQL 执行发生在它的 then() 被调用时。
            // AsyncLocalStorage 只能沿**原生 Promise** 的 then 链传播上下文；
            // 同步回调返回 thenable 时，then 回调执行时 getStore() 返回 undefined，
            // 租户上下文会整个丢失——隔离机制在 HTTP 请求下会静默失效。
            //
            // 用 async 回调后 run() 返回真正的 Promise，ALS 会沿 then 链把上下文
            // 带到查询执行的那一刻。
            void tenantContext.run(contextValue, async () => {
              try {
                // 订阅动作也在作用域内完成，确保控制器方法返回的 PrismaPromise
                // 在这里被 await（即调用 then）时上下文仍然有效。
                //
                // lastValueFrom 在 RxJS 7 的签名里返回 any，这里显式收敛为
                // unknown 再交给 subscriber，避免把 any 泄漏进类型系统。
                const value: unknown = await lastValueFrom<unknown>(
                  next.handle(),
                );
                subscriber.next(value);
                subscriber.complete();
              } catch (error) {
                subscriber.error(error);
              }
            });
          }),
      ),
    );
  }

  private async buildContext(request: Request): Promise<TenantContextValue> {
    const user = (request as Request & { user?: AuthenticatedUser }).user;

    // 已认证请求：身份来自 JWT，租户范围也随之确定
    if (user) {
      return {
        tenantId: user.tenantId,
        userId: user.userId,
        role: user.role,
      };
    }

    // 匿名请求：从子域名解析租户（店铺前台场景）
    const subdomain = TenantResolverService.extractSubdomain(
      request.headers,
      request.hostname || undefined,
    );

    if (!subdomain) {
      throw new NotFoundException('无法确定店铺，请通过店铺子域名访问');
    }

    const tenant = await this.resolver.resolveBySubdomain(subdomain);

    return {
      tenantId: tenant.id,
      userId: null,
      role: null,
    };
  }
}
