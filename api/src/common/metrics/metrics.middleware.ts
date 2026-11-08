import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { MetricsService } from './metrics.service';

/**
 * HTTP 指标中间件（阶段 11）。
 *
 * ## 为什么是中间件而不是拦截器
 *
 * Nest 的管道顺序是「守卫在拦截器**之前**」——守卫拒绝 401/403 时，
 * 拦截器（连同它的 `res 'finish'` 监听）根本不会注册，这类请求
 * **完全不进指标**；而中间件在守卫之前执行，`res 'finish'` 时
 * 每个请求（含被守卫拒绝的）都能被统计到。这是对阶段 11 初版
 * 「守卫的 401/403 不进指标」缺口的收口。
 *
 * ## 路由模板在 'finish' 时才读
 *
 * 全局中间件执行时路由还没匹配，`req.routeOptions.url` 是 undefined；
 * 但 `'finish'` 事件触发时路由**早已匹配**（守卫/处理器都跑完了），
 * 所以监听器里读模板即可拿到 `/api/v1/orders/:orderNo` 这样的
 * 低基数标签。Express 5 用 `routeOptions.url`，Express 4 是
 * `req.route.path`，都没有（如中间件自己拦掉的）归到 `unmatched`。
 */
@Injectable()
export class MetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: MetricsService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const startedAt = Date.now();
    const method = req.method ?? 'UNKNOWN';
    res.once('finish', () => {
      this.metrics.recordHttpRequest(
        method,
        this.routeTemplateOf(req),
        res.statusCode,
        (Date.now() - startedAt) / 1000,
      );
    });
    next();
  }

  private routeTemplateOf(req: Request): string {
    const express5 = (req as unknown as { routeOptions?: { url?: string } })
      .routeOptions?.url;
    if (typeof express5 === 'string') return express5;
    const express4 = (req as unknown as { route?: { path?: string } }).route
      ?.path;
    if (typeof express4 === 'string') return express4;
    return 'unmatched';
  }
}
