import {
  Controller,
  Get,
  INestApplication,
  Module,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import { Prisma, UserRole } from '@prisma/client';
import { HealthModule } from '../src/health/health.module';
import { TenancyModule } from '../src/modules/tenancy/tenancy.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { tenantContext } from '../src/common/tenant/tenant-context';
import { http } from './helpers';

/** 探针接口的响应体形状；只断言用得到的字段 */
interface StoreResponse {
  id: string;
  tenantId: string;
  slug: string;
}

/** 错误响应体形状；NestJS 默认异常过滤器返回 message 为字符串 */
interface ErrorResponse {
  message: string;
}

/**
 * 从 supertest 的响应里取出错误体。
 * body 本身是 any，先收敛成具体类型再做成员访问，避免 unsafe-member-access
 * 告警掩盖真正的断言失败。
 */
function errorBody(response: { body: unknown }): ErrorResponse {
  return response.body as ErrorResponse;
}

/** 只在测试里存在的探针控制器，用来验证租户上下文真的到达了 SQL */
@Controller('probe')
class ProbeController {
  constructor(private readonly prisma: TenantPrismaService) {}

  @Get('stores')
  stores() {
    // 走的是租户作用域模型，隔离机制会在这里生效
    return this.prisma.store.findMany();
  }
}

// TenantPrismaService 由全局的 TenancyModule 提供，这里不再重复声明，
// 否则 app.get(TenantPrismaService) 与拦截器内部用的会是两个不同实例。
@Module({
  imports: [HealthModule, TenancyModule],
  controllers: [ProbeController],
})
class ProbeModule {}

describe('租户隔离全链路 (e2e)', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;

  const unique = () => randomBytes(6).toString('hex');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ProbeModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    // 与 main.ts 保持一致
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    // 与 main.ts 保持一致：全局拦截器是租户上下文的唯一入口
    app.useGlobalInterceptors(app.get(TenantContextInterceptor));
    await app.init();

    prisma = app.get(TenantPrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('租户 A 的请求只能看到自己的店铺', async () => {
    const subA = `iso-a-${unique()}`;
    const subB = `iso-b-${unique()}`;

    const tenantA = await prisma.tenant.create({
      data: { name: '隔离商家 A', subdomain: subA },
    });
    const tenantB = await prisma.tenant.create({
      data: { name: '隔离商家 B', subdomain: subB },
    });

    // 清理必须放在 finally 里：断言失败会中断测试，
    // 挂在末尾的 deleteMany 不会执行，测试库里会留下永久垃圾数据。
    try {
      // 在租户 A 的上下文里建一个店铺。
      // 必须走 tenantContext.run 的 async 回调——同步回调会因为 Prisma 6 的
      // PrismaPromise 是 thenable 而丢失上下文，扩展会因「没有租户上下文」直接拒绝。
      const store = await tenantContext.run(
        { tenantId: tenantA.id, userId: null, role: UserRole.MERCHANT_OWNER },
        async () =>
          prisma.store.create({
            data: {
              name: 'A 的店铺',
              slug: 'a-store',
            } as unknown as Prisma.StoreCreateInput,
          }),
      );

      const responseA = await http(app)
        .get('/api/v1/probe/stores')
        .set('X-Tenant-Subdomain', subA);

      const responseB = await http(app)
        .get('/api/v1/probe/stores')
        .set('X-Tenant-Subdomain', subB);

      expect(responseA.status).toBe(200);
      expect(responseB.status).toBe(200);

      // supertest 的 body 是 any，先收敛成具体类型再做成员访问，
      // 避免 unsafe-member-access 告警掩盖真正的断言失败
      const storesOfA = responseA.body as StoreResponse[];

      // A 能看到自己的店铺
      expect(storesOfA).toHaveLength(1);
      expect(storesOfA[0].id).toBe(store.id);

      // B 看不到 A 的店铺 —— 这是整个隔离机制的核心保证
      expect(responseB.body).toHaveLength(0);
    } finally {
      // 清理本身失败不能抛：它会顶替掉上面真正的断言错误，
      // 调试时看到的是「清理失败」而不是「隔离被打破」。只记录不抛出。
      try {
        await prisma.tenant.deleteMany({
          where: { id: { in: [tenantA.id, tenantB.id] } },
        });
      } catch (error) {
        console.error('清理测试租户失败：', error);
      }
    }
  });

  it('缺少子域名时探针接口返回 404', async () => {
    const response = await http(app).get('/api/v1/probe/stores');
    expect(response.status).toBe(404);
  });

  it('IP 直连时不被解析成子域名，错误信息不回显用户输入', async () => {
    const response = await http(app)
      .get('/api/v1/probe/stores')
      .set('Host', '127.0.0.1:3000');

    expect(response.status).toBe(404);
    // 断言消息字段的精确内容，而不是「响应体里不含 127」——
    // 后者在错误信息将来带上版本号或 trace id 时会假阳性失败。
    expect(errorBody(response).message).toBe(
      '无法确定店铺，请通过店铺子域名访问',
    );
  });

  describe('平台保留子域名', () => {
    it.each(['admin', 'api', 'www', 'platform'])(
      'Host: %s.platform.test 返回 404，措辞与「租户不存在」一致',
      async (subdomain) => {
        const response = await http(app)
          .get('/api/v1/probe/stores')
          .set('Host', `${subdomain}.platform.test`);

        expect(response.status).toBe(404);
        // 关键：措辞必须与「无法确定店铺」完全相同。
        // 一旦区分「这是保留字」，攻击者就能用响应差异枚举出商家目录。
        expect(errorBody(response).message).toBe(
          '无法确定店铺，请通过店铺子域名访问',
        );
      },
    );

    it('保留子域名经由 X-Tenant-Subdomain 头同样被拒', async () => {
      const response = await http(app)
        .get('/api/v1/probe/stores')
        .set('X-Tenant-Subdomain', 'admin');

      expect(response.status).toBe(404);
      expect(errorBody(response).message).toBe(
        '无法确定店铺，请通过店铺子域名访问',
      );
    });

    it('真实店铺子域名走 Host 访问仍然正常', async () => {
      const subdomain = `host-access-${unique()}`;
      const tenant = await prisma.tenant.create({
        data: { name: 'Host 访问商家', subdomain },
      });

      try {
        const response = await http(app)
          .get('/api/v1/probe/stores')
          .set('Host', `${subdomain}.platform.test`);

        expect(response.status).toBe(200);
        expect(response.body).toHaveLength(0);
      } finally {
        try {
          await prisma.tenant.deleteMany({ where: { id: tenant.id } });
        } catch (error) {
          console.error('清理测试租户失败：', error);
        }
      }
    });
  });
});
