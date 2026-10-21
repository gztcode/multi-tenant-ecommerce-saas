import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import { TenantStatus } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { http } from './helpers';

interface AuthResponseBody {
  accessToken: string;
  user: {
    id: string;
    email: string;
    role: string;
    tenantId: string | null;
  };
}

interface StoreResponseBody {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  status: string;
  themeTokens: unknown;
}

interface TenantResponseBody {
  id: string;
  subdomain: string;
  status: string;
}

function authBody(response: { body: unknown }): AuthResponseBody {
  return response.body as AuthResponseBody;
}

function storeBody(response: { body: unknown }): StoreResponseBody {
  return response.body as StoreResponseBody;
}

function tenantBody(response: { body: unknown }): TenantResponseBody {
  return response.body as TenantResponseBody;
}

/**
 * 店铺与跨租户越权防护 (e2e)
 *
 * 这个套件的核心价值在于**第 3、4 条**：它们证明 `findMine()` 里那行手写的
 * `where: { tenantId }` 不是冗余代码。任何只断言「接口返回 200」的测试都是恒真的——
 * 去掉 tenantId 过滤后它照样通过，因为跨租户的第一条店铺也会被返回。
 * 只有断言「返回的 tenantId 等于 A 而不是 B」才能真正区分隔离生效与否。
 */
describe('店铺与跨租户越权防护 (e2e)', () => {
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

  /** 注册一个商家，返回带 token 的注册结果（注册接口即登录） */
  async function registerMerchant(overrides?: {
    merchantName?: string;
    storeName?: string;
    subdomain?: string;
  }) {
    const suffix = unique();
    const subdomain = overrides?.subdomain ?? `s-${suffix}`;
    const response = await http(app)
      .post('/api/v1/auth/register/merchant')
      .send({
        email: `m-${suffix}@example.test`,
        password: 'Passw0rd123',
        merchantName: overrides?.merchantName ?? '商家',
        subdomain,
        storeName: overrides?.storeName ?? `店铺-${suffix}`,
      })
      .expect(201);

    return { ...authBody(response), subdomain };
  }

  /** 平台超管登录（种子数据里的账号） */
  async function loginPlatformAdmin() {
    const response = await http(app)
      .post('/api/v1/auth/login')
      .send({
        email: 'admin@platform.test',
        password: 'Admin12345!',
        scope: 'PLATFORM',
      })
      .expect(200);
    return authBody(response);
  }

  // ---------- 1. 商家 A 能看到自己的店铺 ----------

  it('商家 A 访问 /stores/me 能拿到自己的店铺', async () => {
    const authA = await registerMerchant();

    const response = await http(app)
      .get('/api/v1/stores/me')
      .set('Authorization', `Bearer ${authA.accessToken}`)
      .expect(200);

    const store = storeBody(response);
    expect(store.tenantId).toBe(authA.user.tenantId);
    expect(store.name).toContain('店铺-');
  });

  // ---------- 2. 商家 A 看不到商家 B 的店铺 ----------

  it('商家 A 访问 /stores/me 返回的是 A 自己的店铺而不是 B 的', async () => {
    // 先造两个商家。创建时间上 A 在 B 之前，因此如果隔离失效、
    // 退化成「返回第一条店铺」，A 拿到的会是**别的**店铺——
    // 这条断言因此真的能失败，不是恒真。
    const authA = await registerMerchant({ storeName: `A店铺-${unique()}` });
    const authB = await registerMerchant({ storeName: `B店铺-${unique()}` });

    // 拿 B 的真实店铺 id 作为「绝对不能出现」的对照
    const storeB = storeBody(
      await http(app)
        .get('/api/v1/stores/me')
        .set('Authorization', `Bearer ${authB.accessToken}`)
        .expect(200),
    );

    const storeA = storeBody(
      await http(app)
        .get('/api/v1/stores/me')
        .set('Authorization', `Bearer ${authA.accessToken}`)
        .expect(200),
    );

    expect(storeA.tenantId).toBe(authA.user.tenantId);
    expect(storeA.tenantId).not.toBe(authB.user.tenantId);
    expect(storeA.id).not.toBe(storeB.id);
  });

  // ---------- 3. 商家 A 更新店铺名不会改到商家 B ----------

  it('商家 A 更新店铺名只影响自己，不会改到商家 B', async () => {
    const authA = await registerMerchant();
    const authB = await registerMerchant();

    const beforeB = storeBody(
      await http(app)
        .get('/api/v1/stores/me')
        .set('Authorization', `Bearer ${authB.accessToken}`)
        .expect(200),
    );

    const newNameA = `改名后的A店铺-${unique()}`;
    const updatedA = storeBody(
      await http(app)
        .patch('/api/v1/stores/me')
        .set('Authorization', `Bearer ${authA.accessToken}`)
        .send({ name: newNameA })
        .expect(200),
    );
    expect(updatedA.name).toBe(newNameA);

    // B 再读一次：名字必须一字未动。
    // 如果 updateMany 的 tenantId 条件失效，或者误用了 update（只按 id），
    // 这条会失败——因为这里读的是 B 自己的店铺，不是全局某一处。
    const afterB = storeBody(
      await http(app)
        .get('/api/v1/stores/me')
        .set('Authorization', `Bearer ${authB.accessToken}`)
        .expect(200),
    );
    expect(afterB.name).toBe(beforeB.name);
    expect(afterB.id).toBe(beforeB.id);
  });

  // ---------- 4. 商家访问平台超管接口 → 403 ----------

  it('商家访问 /tenants（平台超管接口）返回 403', async () => {
    const authA = await registerMerchant();

    await http(app)
      .get('/api/v1/tenants')
      .set('Authorization', `Bearer ${authA.accessToken}`)
      .expect(403);
  });

  // ---------- 5. 平台超管访问 /tenants → 200，能看到刚注册的商家 ----------

  it('平台超管访问 /tenants 返回 200 且包含刚注册的商家', async () => {
    const admin = await loginPlatformAdmin();
    const authA = await registerMerchant();
    const tenantIdA = authA.user.tenantId;
    expect(tenantIdA).not.toBeNull();

    const response = await http(app)
      .get('/api/v1/tenants')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);

    const list = response.body as TenantResponseBody[];
    const found = list.find((t) => t.id === tenantIdA);
    expect(found).toBeDefined();
    expect(found?.subdomain).toBe(authA.subdomain);
  });

  // ---------- 6. 商家被置为 SUSPENDED 后，原 token 立刻失效 ----------

  it('商家被置为 SUSPENDED 后，其已签发的 token 立刻失效', async () => {
    // 平台超管 PATCH /tenants/:id/status 把租户置为 SUSPENDED 之后，
    // 商家手上没过期的 access token 必须**立即**失效——
    // 否则「停用」这个管理动作形同虚设，商家能继续用满整个 JWT 有效期
    // （默认 2 小时）。
    //
    // 实现位置在 JwtStrategy.validate()：每条请求走到的 Guard 都会重新查
    // 一次 tenants.status，命中 SUSPENDED 即抛 401。
    //
    // 这是一条**非恒真**断言（去掉那段租户状态检查，实测仍是 200）——
    // 不能用 expect(200) 写成本任务的护栏，否则缺口会被恒真的断言掩盖。
    const admin = await loginPlatformAdmin();
    const authA = await registerMerchant();
    const tenantIdA = authA.user.tenantId;
    expect(tenantIdA).not.toBeNull();

    // 停用前 A 能正常访问
    await http(app)
      .get('/api/v1/stores/me')
      .set('Authorization', `Bearer ${authA.accessToken}`)
      .expect(200);

    // 超管把 A 的状态改成 SUSPENDED
    const patched = await http(app)
      .patch(`/api/v1/tenants/${tenantIdA}/status`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ status: TenantStatus.SUSPENDED })
      .expect(200);
    expect(tenantBody(patched).status).toBe(TenantStatus.SUSPENDED);

    // 状态确实已落库（超管列表里能看到 SUSPENDED）
    const list = await http(app)
      .get('/api/v1/tenants')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
    const found = (list.body as TenantResponseBody[]).find(
      (t) => t.id === tenantIdA,
    );
    expect(found?.status).toBe(TenantStatus.SUSPENDED);

    // 关键：同一枚 access token 再调 /stores/me —— 必须 401。
    // 这条断言的护栏作用：去掉 JwtStrategy.validate() 里的租户状态检查，
    // 此处会失败（拿到 200 而不是 401）。
    await http(app)
      .get('/api/v1/stores/me')
      .set('Authorization', `Bearer ${authA.accessToken}`)
      .expect(401);
  });

  // ---------- 6a. 消费者被停用后 token 也失效（覆盖 CUSTOMER 角色） ----------

  it('商家被置为 SUSPENDED 后，该租户下的消费者 token 也立即失效', async () => {
    // 上一条只覆盖了 MERCHANT_OWNER。租户级停用是**整租户**的暂停，
    // 同一租户下的 CUSTOMER 角色的令牌也必须立刻失效——验证检查覆盖了
    // CUSTOMER，而不是只匹配 MERCHANT_OWNER。
    const admin = await loginPlatformAdmin();
    const subA = `susp-cust-${unique()}`;
    await http(app)
      .post('/api/v1/auth/register/merchant')
      .send({
        email: `m-susp-cust-${unique()}@example.test`,
        password: 'Passw0rd123',
        merchantName: '停用覆盖消费者',
        subdomain: subA,
        storeName: `店铺-${unique()}`,
      })
      .expect(201);

    const customerReg = await http(app)
      .post('/api/v1/auth/register/customer')
      .set('X-Tenant-Subdomain', subA)
      .send({
        email: `cust-susp-${unique()}@example.test`,
        password: 'Passw0rd123',
        displayName: '消费者',
      })
      .expect(201);
    const customerAuth = authBody(customerReg);
    expect(customerAuth.user.role).toBe('CUSTOMER');
    const tenantId = customerAuth.user.tenantId;
    expect(tenantId).not.toBeNull();

    // 停用前消费者 /auth/me 能通
    await http(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${customerAuth.accessToken}`)
      .expect(200);

    // 超管把该租户置为 SUSPENDED
    await http(app)
      .patch(`/api/v1/tenants/${tenantId}/status`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ status: TenantStatus.SUSPENDED })
      .expect(200);

    // 同一枚 access token 必须立刻 401
    await http(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${customerAuth.accessToken}`)
      .expect(401);
  });

  // ---------- 6b. 平台超管的 token 不受租户停用影响 ----------

  it('商家被置为 SUSPENDED 后，平台超管的 token 仍能正常访问 /tenants', async () => {
    // 平台超管 tenantId 为 null，本身不带商家归属，不应被「商家被停用」
    // 的检查波及。少了这一条，验证逻辑一不小心写成「停用任意租户后
    // 整张表都拒绝」那种粗粒度形态，问题会被掩盖。
    const admin = await loginPlatformAdmin();
    const authA = await registerMerchant();
    const tenantIdA = authA.user.tenantId;
    expect(tenantIdA).not.toBeNull();

    await http(app)
      .patch(`/api/v1/tenants/${tenantIdA}/status`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ status: TenantStatus.SUSPENDED })
      .expect(200);

    // 平台超管读租户列表仍然正常
    await http(app)
      .get('/api/v1/tenants')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(200);
  });

  // ---------- 7. 未登录访问 /stores/me → 401 ----------

  it('未登录访问 /stores/me 返回 401', async () => {
    await http(app).get('/api/v1/stores/me').expect(401);
  });

  // ---------- 8. 公开的按子域名查询 ----------

  it('GET /stores/by-subdomain/:subdomain 返回对应店铺', async () => {
    const authA = await registerMerchant();

    const response = await http(app)
      .get(`/api/v1/stores/by-subdomain/${authA.subdomain}`)
      .expect(200);

    const store = storeBody(response);
    expect(store.tenantId).toBe(authA.user.tenantId);
  });

  it('GET /stores/by-subdomain 对不存在的子域名返回 404', async () => {
    await http(app)
      .get(`/api/v1/stores/by-subdomain/no-such-${unique()}`)
      .expect(404);
  });

  // ---------- 额外：平台超管没有店铺，返回 404 ----------

  it('平台超管（无租户归属）访问 /stores/me 返回 404', async () => {
    const admin = await loginPlatformAdmin();

    await http(app)
      .get('/api/v1/stores/me')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .expect(404);
  });

  // ---------- 额外：更新店铺的 DTO 校验（whitelist 生效） ----------

  it('PATCH /stores/me 拒绝越权字段（tenantId 不允许由客户端提交）', async () => {
    const authA = await registerMerchant();
    const attackerTenantId = `00000000-0000-0000-0000-000000000000`;

    // forbidNonWhitelisted：多传的 tenantId 直接 400
    await http(app)
      .patch('/api/v1/stores/me')
      .set('Authorization', `Bearer ${authA.accessToken}`)
      .send({ name: `合法名字-${unique()}`, tenantId: attackerTenantId })
      .expect(400);
  });

  it('PATCH /stores/me 更新 themeTokens 后能读回', async () => {
    const authA = await registerMerchant();

    const themeTokens = { primary: '#ff0000', fontSize: 14 };
    const updated = storeBody(
      await http(app)
        .patch('/api/v1/stores/me')
        .set('Authorization', `Bearer ${authA.accessToken}`)
        .send({ themeTokens })
        .expect(200),
    );
    expect(updated.themeTokens).toEqual(themeTokens);
  });
});
