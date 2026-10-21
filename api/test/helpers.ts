import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';

/**
 * supertest 的类型收敛。
 *
 * `app.getHttpServer()` 在 NestJS 的类型定义里返回 any，直接传给
 * supertest 会触发 @typescript-eslint/no-unsafe-argument。集中在这里做一次
 * 断言，后续所有 e2e 文件都用 `http(app).get(...)`，warning 不会随文件数增长。
 */
export function http(app: INestApplication) {
  return request(app.getHttpServer() as App);
}
