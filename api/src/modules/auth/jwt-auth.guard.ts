import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * JWT 认证守卫。
 *
 * 只做「令牌有效 + 用户存在」这一层；角色级别的越权防护属于 Task 7 的 RBAC 守卫，
 * 这里刻意不混入，避免两种失败语义（401 未认证 / 403 已认证但无权限）混在一个守卫里。
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
