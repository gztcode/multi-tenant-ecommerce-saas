// ⚠️ **必须是本文件的第一条 import**：`.env` 必须在应用图被求值之前加载，
//    否则 `queue.module.ts` 的 `BullModule.forRoot` 会把 `REDIS_URL` 定死成
//    不带密码的 fallback 值。顺序为何必须靠 import 语句保证，见 `load-env.ts`。
import './load-env';

import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { TenantContextInterceptor } from './modules/tenancy/tenant-context.interceptor';
import { assertSecureConfig } from './common/config/assert-secure-config';
import { assertPayoutEncryptionKey } from './common/config/assert-payout-encryption-key';
import { setupSwagger } from './common/config/swagger-config';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { SECURITY_HEADERS_OPTIONS } from './common/http/security-headers';
import { PinoLoggerService } from './common/logging/pino-logger.service';
import { PayoutEncryptionSelfCheck } from './modules/billing/payout-encryption-self-check.service';

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
  // 安全响应头。配置见 SECURITY_HEADERS_OPTIONS（e2e 复刻同一份配置）。
  app.use(helmet(SECURITY_HEADERS_OPTIONS));
  // 阶段 11：全局结构化日志。useLogger 之后，全仓 `new Logger()` 实例的
  // 输出都会经 PinoLoggerService 落成 JSON（业务代码零改动）。
  app.useLogger(app.get(PinoLoggerService));
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
  // HTTP 访问日志已下沉到中间件层（`AccessLogMiddleware`，见 app.module.ts）：
  // 中间件在守卫之前注册、在 res 'finish' 时取最终状态码，因此守卫拒绝的
  // 401/403 也有访问日志——这是拦截器方案盖不到的。这里只保留租户上下文。
  app.useGlobalInterceptors(app.get(TenantContextInterceptor));
  // 必须在 createDocument 之前注册：过滤器不会改变路由表，但先挂上过滤器
  // 才能保证后面 Swagger UI 自身的请求也走统一错误格式。
  app.useGlobalFilters(new AllExceptionsFilter());

  // Swagger 路径不带全局前缀 api/v1 —— 文档本身不属于版本化的业务接口，
  // 放在 /api/docs 让它既好记又不会和业务路由混淆。
  //
  // ⚠️ 生产环境**默认不挂**（SWAGGER_ENABLED=true 才开）：Swagger UI 会把
  //    全部接口与鉴权方式摊给公网扫描器。开关逻辑见 swagger-config.ts。
  setupSwagger(app);

  const port = Number(process.env.PORT ?? 3000);

  // ⚠️ **账目密钥自检必须在监听端口之前**：
  //    带着解不开的密文启动，运营看到的全是失败的出款单，
  //    没人知道根因是密钥配错了。
  await app.get(PayoutEncryptionSelfCheck).check();

  await app.listen(port);
  new Logger('Bootstrap').log(`API 已启动：http://localhost:${port}/api/v1`);
}

void bootstrap();
