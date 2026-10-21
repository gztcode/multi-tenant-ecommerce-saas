import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { UserRole } from '@prisma/client';

export interface CurrentUserPayload {
  userId: string;
  email: string;
  role: UserRole;
  tenantId: string | null;
}

/**
 * 取出当前登录用户。
 *
 * 数据来自 JwtStrategy.validate 的返回值（已经过库校验），不是令牌 payload 本身。
 * 使用该装饰器的路由必须挂上 JwtAuthGuard，否则 request.user 为 undefined。
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): CurrentUserPayload => {
    // 先收敛成 Request 再取 user：getRequest() 返回 any，
    // 直接访问成员会触发 no-unsafe-member-access。
    const request = context.switchToHttp().getRequest<Request>();
    return request.user as CurrentUserPayload;
  },
);
