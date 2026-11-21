import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/**
 * Swagger UI 的环境闸（生产暴露面收口）。
 *
 * ⚠️ **为什么生产要关**：Swagger UI 会把**全部接口、参数、鉴权方式**摊开给
 * 访问者，公网上的扫描器拿到它就等于拿到一份攻击面清单。
 * 生产环境默认不挂载 `/api/docs`，需要临时看文档时用 `SWAGGER_ENABLED=true` 显式开。
 *
 * ⚠️ **为什么单独一个文件**：`main.ts` 末尾是 `void bootstrap()`，
 *    单测 import 它就会真的连库、监听端口 —— 所以闸门逻辑必须放在
 *    能被独立 import 的模块里，由 `main.ts` 调用。
 */

/** Swagger UI 的挂载路径（不带全局前缀 api/v1，与既有行为一致）。 */
export const SWAGGER_PATH = 'api/docs';

/**
 * 是否挂载 Swagger UI。
 *
 * 判定顺序：
 * 1. `SWAGGER_ENABLED` 显式取值优先：`true` / `1` → 开，`false` / `0` → 关；
 * 2. 没配（或配了无法识别的值）→ `NODE_ENV === 'production'` 时**关**，其余**开**。
 *
 * @param env 环境变量来源，默认 `process.env`（测试里可以传对象直接断言）。
 */
export function isSwaggerEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const explicit = env.SWAGGER_ENABLED?.trim().toLowerCase();
  if (explicit === 'true' || explicit === '1') return true;
  if (explicit === 'false' || explicit === '0') return false;
  return env.NODE_ENV !== 'production';
}

/**
 * 按环境决定挂不挂 Swagger UI。
 *
 * @returns 是否真的挂上了（false = 生产环境默认关闭，路径不可达）。
 */
export function setupSwagger(app: INestApplication): boolean {
  if (!isSwaggerEnabled()) return false;

  const swaggerConfig = new DocumentBuilder()
    .setTitle('多租户电商 SaaS API')
    .setDescription('多租户电商 SaaS API · 阶段 2：商品中心')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup(SWAGGER_PATH, app, document);

  return true;
}
