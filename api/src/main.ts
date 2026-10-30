import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { TenantContextInterceptor } from './modules/tenancy/tenant-context.interceptor';
import { assertSecureConfig } from './common/config/assert-secure-config';
import { assertPayoutEncryptionKey } from './common/config/assert-payout-encryption-key';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

async function bootstrap() {
  // 在创建 Nest 应用之前校验 JWT_SECRET：
  // 配置不安全时进程必须立刻退出，不能先监听端口再失败。
  assertSecureConfig();

  // ⚠️ **账目加密密钥同样要在建应用前校验**：
  //    缺了它，出款执行时会解不开快照 → 钱打不出去。
  assertPayoutEncryptionKey();

  // ⚠️ `rawBody: true`：让 Nest 把请求的**原始字节**挂在 `req.rawBody` 上。
  //
  // 支付回调要用它验签——签名验的是原始 body，不是解析后的字段。
  // 默认的 JSON body parser 会把请求流消费掉，那时拿不到原始字节了。
  const app = await NestFactory.create(AppModule, { rawBody: true });

  app.setGlobalPrefix('api/v1');
  // 读取 cookie 必须有 cookie-parser 中间件：
  // Express 自带 res.cookies.set()（写），但 req.cookies（读）要靠它。
  // 游客购物车靠 cookie 里的 cart_token 标识，缺了它读不到 token。
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalInterceptors(app.get(TenantContextInterceptor));
  // 必须在 createDocument 之前注册：过滤器不会改变路由表，但先挂上过滤器
  // 才能保证后面 Swagger UI 自身的请求也走统一错误格式。
  app.useGlobalFilters(new AllExceptionsFilter());

  // Swagger 路径不带全局前缀 api/v1 —— 文档本身不属于版本化的业务接口，
  // 放在 /api/docs 让它既好记又不会和业务路由混淆。
  const swaggerConfig = new DocumentBuilder()
    .setTitle('多租户电商 SaaS API')
    .setDescription('多租户电商 SaaS API · 阶段 2：商品中心')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`API 已启动：http://localhost:${port}/api/v1`);
}

void bootstrap();
