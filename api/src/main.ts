import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { TenantContextInterceptor } from './modules/tenancy/tenant-context.interceptor';
import { assertSecureConfig } from './common/config/assert-secure-config';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

async function bootstrap() {
  // 在创建 Nest 应用之前校验 JWT_SECRET：
  // 配置不安全时进程必须立刻退出，不能先监听端口再失败。
  assertSecureConfig();

  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api/v1');
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
    .setDescription('阶段 1：平台地基与身份体系')
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
