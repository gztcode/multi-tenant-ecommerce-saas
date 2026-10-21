import { SetMetadata } from '@nestjs/common';

export const SKIP_KEY = 'skip:interceptors';

/** 标记该路由不经过租户上下文拦截器（健康检查等公共端点） */
export const Skip = () => SetMetadata(SKIP_KEY, true);
