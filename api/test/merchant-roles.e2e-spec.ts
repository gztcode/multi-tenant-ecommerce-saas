import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { http } from './helpers';

interface AuthResponseBody {
  accessToken: string;
  user: { id: string; role: string; tenantId: string | null };
}

function authBody(response: { body: unknown }): AuthResponseBody {
  return response.body as AuthResponseBody;
}

/**
 * 商家管理端的角色防线 (e2e)
 *
 * 对应 2026-11-05 审计 P1-1：`@Roles()` 是挂 RolesGuard 的唯一入口，
 * 漏挂 = 静默敞开。对抗验证曾在运行中的栈上用**消费者令牌**完整复现资损链
 * （改价 1 分 → 库存调大 → 0.99 元拿走 99 件）。这组用例把「消费者令牌打
 * 商家写接口必须 403」钉进 e2e，防止将来新增路由或重构守卫时防线悄然消失。
 *
 * 与契约测试（roles.contract.spec.ts）的分工：契约测试盯**元数据有没有挂**，
 * 这里盯**守卫真的在 HTTP 层生效**（认证先于鉴权、403 而非 401/500）。
 */
describe('商家管理端角色防线 (e2e)', () => {
  let app: INestApplication;

  const unique = () => randomBytes(6).toString('hex');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
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
    app.useGlobalInterceptors(app.get(TenantContextInterceptor));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  async function registerMerchant() {
    const suffix = unique();
    const subdomain = `s-${suffix}`;
    const response = await http(app)
      .post('/api/v1/auth/register/merchant')
      .send({
        email: `m-${suffix}@example.test`,
        password: 'Passw0rd123',
        merchantName: '商家',
        subdomain,
        storeName: `店铺-${suffix}`,
      })
      .expect(201);
    return { ...authBody(response), subdomain };
  }

  async function registerCustomer(subdomain: string) {
    const suffix = unique();
    const response = await http(app)
      .post('/api/v1/auth/register/customer')
      .set('X-Tenant-Subdomain', subdomain)
      .send({
        email: `c-${suffix}@example.test`,
        password: 'Passw0rd123',
        displayName: '顾客',
      })
      .expect(201);
    return authBody(response);
  }

  it('消费者令牌打商家管理端全部返回 403（改价/改库存/下架/媒体/店铺设置）', async () => {
    const merchant = await registerMerchant();
    const customer = await registerCustomer(merchant.subdomain);
    const token = `Bearer ${customer.accessToken}`;

    // 攻击者会用的最小请求体：守卫先于管道执行，403 不依赖 body 合法性
    const attacks: Array<
      ['get' | 'post' | 'patch' | 'delete', string, string]
    > = [
      ['post', '/api/v1/catalog/products', '建商品'],
      ['post', '/api/v1/catalog/categories', '建分类'],
      ['post', '/api/v1/inventory/adjustments', '改库存'],
      ['get', '/api/v1/inventory/movements', '读库存流水'],
      ['get', '/api/v1/inventory/summary', '读库存汇总'],
      ['post', '/api/v1/media/upload-url', '拿上传凭证'],
      ['patch', '/api/v1/stores/me', '改店铺设置'],
      ['delete', '/api/v1/catalog/products/does-not-exist', '删商品'],
    ];

    for (const [method, url, label] of attacks) {
      const res = await http(app)
        [method](url)
        .set('Authorization', token)
        .send({});
      expect([label, res.status, res.body as { message?: string }]).toEqual([
        label,
        403,
        expect.objectContaining({ message: '当前角色无权访问该资源' }),
      ]);
    }
  });

  it('消费者令牌仍可读自己的店铺（GET /stores/me 刻意不设角色限制）', async () => {
    const merchant = await registerMerchant();
    const customer = await registerCustomer(merchant.subdomain);

    const res = await http(app)
      .get('/api/v1/stores/me')
      .set('Authorization', `Bearer ${customer.accessToken}`)
      .expect(200);

    expect(res.body as { tenantId: string }).toEqual(
      expect.objectContaining({ tenantId: merchant.user.tenantId }),
    );
  });

  it('商家令牌不受影响（GET /catalog/products 正常）', async () => {
    const merchant = await registerMerchant();

    const res = await http(app)
      .get('/api/v1/catalog/products')
      .set('Authorization', `Bearer ${merchant.accessToken}`)
      .expect(200);

    const body = res.body as { items: unknown[] };
    // 只断言「商家能看到分页结构」：内容为空数组即可，商品造数不在这组用例的职责里
    expect(body.items).toEqual([]);
  });

  it('公开路由 by-subdomain 不需要登录（防误挂角色把前台锁死）', async () => {
    const merchant = await registerMerchant();

    const res = await http(app)
      .get(`/api/v1/stores/by-subdomain/${merchant.subdomain}`)
      .expect(200);

    // 注册时 slug 会被规范化（可能与请求的 subdomain 差一个前缀），
    // 所以断言落在租户归属上而不是 slug 字符串。
    expect(res.body as { tenantId: string }).toEqual(
      expect.objectContaining({ tenantId: merchant.user.tenantId }),
    );
  });
});
