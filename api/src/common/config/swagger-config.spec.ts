import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';

import { isSwaggerEnabled, setupSwagger } from './swagger-config';

describe('Swagger UI 的环境闸', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalSwaggerEnabled = process.env.SWAGGER_ENABLED;

  afterEach(() => {
    // ⚠️ `process.env.X = undefined` 会把变量设成字符串 "undefined" 而不是删除，
    //    所以「原来没有」必须 delete（与 assert-payout-encryption-key.spec.ts 同理）。
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (originalSwaggerEnabled === undefined) {
      delete process.env.SWAGGER_ENABLED;
    } else {
      process.env.SWAGGER_ENABLED = originalSwaggerEnabled;
    }
  });

  describe('isSwaggerEnabled', () => {
    it('生产环境未显式配置 → 关闭', () => {
      expect(isSwaggerEnabled({ NODE_ENV: 'production' })).toBe(false);
    });

    it('生产环境显式开启 → 开启', () => {
      expect(
        isSwaggerEnabled({ NODE_ENV: 'production', SWAGGER_ENABLED: 'true' }),
      ).toBe(true);
      expect(
        isSwaggerEnabled({ NODE_ENV: 'production', SWAGGER_ENABLED: '1' }),
      ).toBe(true);
    });

    it('非生产环境未显式配置 → 开启（现有开发流程不受影响）', () => {
      expect(isSwaggerEnabled({ NODE_ENV: 'development' })).toBe(true);
      expect(isSwaggerEnabled({ NODE_ENV: 'test' })).toBe(true);
      expect(isSwaggerEnabled({})).toBe(true);
    });

    it('显式关闭优先于环境判定', () => {
      expect(
        isSwaggerEnabled({
          NODE_ENV: 'development',
          SWAGGER_ENABLED: 'false',
        }),
      ).toBe(false);
      expect(
        isSwaggerEnabled({ NODE_ENV: 'production', SWAGGER_ENABLED: '0' }),
      ).toBe(false);
    });

    it('无法识别的取值 → 回落到环境判定（不当成开启）', () => {
      expect(
        isSwaggerEnabled({ NODE_ENV: 'production', SWAGGER_ENABLED: 'yes' }),
      ).toBe(false);
      expect(
        isSwaggerEnabled({ NODE_ENV: 'development', SWAGGER_ENABLED: 'yes' }),
      ).toBe(true);
    });
  });

  describe('HTTP 层：/api/docs 可达性', () => {
    let app: INestApplication;

    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({}).compile();
      app = moduleRef.createNestApplication();
      app.setGlobalPrefix('api/v1');
      // ⚠️ setupSwagger 必须在 app.init() **之前**调用：
      //    SwaggerModule.setup 直接往 httpAdapter 上挂路由，
      //    init 之后注册就赶不上 Express 的路由栈了（请求一律 404）。
    });

    afterEach(async () => {
      await app.close();
    });

    it('⚠️ 生产配置下访问 swagger 路径不可达', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.SWAGGER_ENABLED;

      setupSwagger(app);
      await app.init();

      await request(app.getHttpServer() as App)
        .get('/api/docs')
        .expect(404);
    });

    it('开发环境仍可访问 swagger 路径', async () => {
      process.env.NODE_ENV = 'development';
      delete process.env.SWAGGER_ENABLED;

      setupSwagger(app);
      await app.init();

      await request(app.getHttpServer() as App)
        .get('/api/docs')
        .expect(200);
    });

    it('生产环境显式开启后仍可访问 swagger 路径', async () => {
      process.env.NODE_ENV = 'production';
      process.env.SWAGGER_ENABLED = 'true';

      setupSwagger(app);
      await app.init();

      await request(app.getHttpServer() as App)
        .get('/api/docs')
        .expect(200);
    });
  });

  describe('main.ts 的接线', () => {
    // ⚠️ 上面两组用例只覆盖 setupSwagger 自身；main.ts 若绕过它直接
    //    `SwaggerModule.setup(...)`，闸门就等于没有 —— 用静态断言钉住接线。
    it('main.ts 不再直接调用 SwaggerModule.setup', () => {
      const mainSource = readFileSync(
        join(__dirname, '..', '..', 'main.ts'),
        'utf8',
      );

      expect(mainSource).not.toMatch(/SwaggerModule\.setup\s*\(/);
      expect(mainSource).toMatch(/setupSwagger\s*\(/);
    });
  });
});
