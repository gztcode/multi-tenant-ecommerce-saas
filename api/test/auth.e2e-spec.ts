import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { http } from './helpers';

/**
 * supertest 的 response.body 本身是 any，直接做成员访问会触发
 * no-unsafe-member-access。收敛成具体类型后再访问，
 * 与 tenant-isolation.e2e-spec.ts 的既有做法一致。
 */
interface AuthResponseBody {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    displayName: string;
    role: string;
    tenantId: string | null;
  };
}

function body(response: { body: unknown }): AuthResponseBody {
  return response.body as AuthResponseBody;
}

describe('认证 (e2e)', () => {
  let app: INestApplication;

  const unique = () => randomBytes(6).toString('hex');
  const subdomain = () => `shop-${unique()}`;
  const email = () => `merchant-${unique()}@example.test`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    // 与 main.ts 保持一致。DTO 校验（邮箱格式、密码强度、子域名格式与保留名单）
    // 本身就是 API 契约的一部分，e2e 不挂这根管道就等于这部分契约完全没有被验证。
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    // 与 main.ts 保持一致：租户上下文拦截器是消费者注册能否拿到租户的前提。
    app.useGlobalInterceptors(app.get(TenantContextInterceptor));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('商家注册返回令牌与用户', async () => {
    const response = await http(app)
      .post('/api/v1/auth/register/merchant')
      .send({
        email: email(),
        password: 'Passw0rd123',
        merchantName: '测试商家',
        subdomain: subdomain(),
        storeName: '测试店铺',
      });

    expect(response.status).toBe(201);
    expect(body(response).accessToken).toBeTruthy();
    expect(body(response).refreshToken).toBeTruthy();
    expect(body(response).user.role).toBe('MERCHANT_OWNER');
    expect(body(response).user.tenantId).toBeTruthy();
  });

  it('子域名重复时注册失败', async () => {
    const taken = subdomain();
    const payload = {
      email: email(),
      password: 'Passw0rd123',
      merchantName: '商家甲',
      subdomain: taken,
      storeName: '店铺甲',
    };

    await http(app)
      .post('/api/v1/auth/register/merchant')
      .send(payload)
      .expect(201);

    await http(app)
      .post('/api/v1/auth/register/merchant')
      .send({ ...payload, email: email() })
      .expect(409);
  });

  it('商家登录成功返回令牌', async () => {
    const account = email();

    await http(app)
      .post('/api/v1/auth/register/merchant')
      .send({
        email: account,
        password: 'Passw0rd123',
        merchantName: '商家乙',
        subdomain: subdomain(),
        storeName: '店铺乙',
      })
      .expect(201);

    const response = await http(app)
      .post('/api/v1/auth/login')
      .send({ email: account, password: 'Passw0rd123', scope: 'MERCHANT' });

    expect(response.status).toBe(200);
    expect(body(response).accessToken).toBeTruthy();
  });

  it('密码错误时登录返回 401', async () => {
    const account = email();

    await http(app)
      .post('/api/v1/auth/register/merchant')
      .send({
        email: account,
        password: 'Passw0rd123',
        merchantName: '商家丙',
        subdomain: subdomain(),
        storeName: '店铺丙',
      })
      .expect(201);

    await http(app)
      .post('/api/v1/auth/login')
      .send({ email: account, password: 'WrongPassw0rd', scope: 'MERCHANT' })
      .expect(401);
  });

  it('登录入口不匹配时拒绝', async () => {
    // 商家账号用 CUSTOMER 入口登录必须失败：
    // 同一邮箱在不同租户下可能有各自的账号，不按声明的入口过滤角色，
    // 攻击者就能用任意入口试探出该邮箱对应的账号角色。
    const account = email();

    await http(app)
      .post('/api/v1/auth/register/merchant')
      .send({
        email: account,
        password: 'Passw0rd123',
        merchantName: '商家己',
        subdomain: subdomain(),
        storeName: '店铺己',
      })
      .expect(201);

    await http(app)
      .post('/api/v1/auth/login')
      .send({ email: account, password: 'Passw0rd123', scope: 'CUSTOMER' })
      .expect(401);
  });

  it('刷新令牌可换取新令牌，旧令牌随即失效', async () => {
    const account = email();

    const register = await http(app)
      .post('/api/v1/auth/register/merchant')
      .send({
        email: account,
        password: 'Passw0rd123',
        merchantName: '商家丁',
        subdomain: subdomain(),
        storeName: '店铺丁',
      })
      .expect(201);

    const original = body(register).refreshToken;

    const refreshed = await http(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: original })
      .expect(200);

    expect(body(refreshed).accessToken).toBeTruthy();
    expect(body(refreshed).refreshToken).not.toBe(original);

    // 轮换：旧令牌必须立刻失效，否则泄漏的刷新令牌可以无限续期
    await http(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: original })
      .expect(401);
  });

  it('登出后刷新令牌失效', async () => {
    const register = await http(app)
      .post('/api/v1/auth/register/merchant')
      .send({
        email: email(),
        password: 'Passw0rd123',
        merchantName: '商家辛',
        subdomain: subdomain(),
        storeName: '店铺辛',
      })
      .expect(201);

    const registered = body(register);

    await http(app)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${registered.accessToken}`)
      .send({ refreshToken: registered.refreshToken })
      .expect(204);

    await http(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: registered.refreshToken })
      .expect(401);
  });

  it('消费者注册需要店铺子域名', async () => {
    const sub = subdomain();

    await http(app)
      .post('/api/v1/auth/register/merchant')
      .send({
        email: email(),
        password: 'Passw0rd123',
        merchantName: '商家戊',
        subdomain: sub,
        storeName: '店铺戊',
      })
      .expect(201);

    const response = await http(app)
      .post('/api/v1/auth/register/customer')
      .set('X-Tenant-Subdomain', sub)
      .send({
        email: `customer-${unique()}@example.test`,
        password: 'Passw0rd123',
        displayName: '顾客',
      });

    expect(response.status).toBe(201);
    expect(body(response).user.role).toBe('CUSTOMER');
  });

  it('无子域名时消费者注册返回 404', async () => {
    // register/customer 不加 @Skip()，由租户拦截器按子域名解析租户；
    // 解析不出来时拦截器直接返回 404（无法确定店铺）
    await http(app)
      .post('/api/v1/auth/register/customer')
      .send({
        email: `customer-${unique()}@example.test`,
        password: 'Passw0rd123',
        displayName: '顾客',
      })
      .expect(404);
  });

  it('/auth/me 需要有效令牌', async () => {
    await http(app).get('/api/v1/auth/me').expect(401);
  });

  it('带有效令牌可读取当前用户', async () => {
    const account = email();

    const register = await http(app)
      .post('/api/v1/auth/register/merchant')
      .send({
        email: account,
        password: 'Passw0rd123',
        merchantName: '商家庚',
        subdomain: subdomain(),
        storeName: '店铺庚',
      })
      .expect(201);

    const registered = body(register);

    const response = await http(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${registered.accessToken}`);

    expect(response.status).toBe(200);
    expect(response.body as { email: string }).toEqual(
      expect.objectContaining({
        email: account,
        role: 'MERCHANT_OWNER',
        tenantId: registered.user.tenantId,
      }),
    );
  });

  // 保留子域名的拒绝是 DTO 层的约束（自定义装饰器 IsNotReservedSubdomain），
  // 挂上 ValidationPipe 后在这里自然生效，无需再单独起 app。
  it.each(['admin', 'api', 'www'])(
    '保留子域名 %s 无法注册',
    async (reserved) => {
      // 防子域名接管：`admin` 这类名字留给基础设施自用。
      // 若商家能注册，将来 admin.platform.test 指向超管后台即成接管入口。
      const response = await http(app)
        .post('/api/v1/auth/register/merchant')
        .send({
          email: `reserved-${randomBytes(6).toString('hex')}@example.test`,
          password: 'Passw0rd123',
          merchantName: '占位商家',
          subdomain: reserved,
          storeName: '占位店铺',
        });

      expect(response.status).toBe(400);
    },
  );

  it('合法子域名仍然可以注册', async () => {
    // 反向断言：确认上面的 400 来自保留名单，而不是所有注册都被拒
    const response = await http(app)
      .post('/api/v1/auth/register/merchant')
      .send({
        email: `ok-${randomBytes(6).toString('hex')}@example.test`,
        password: 'Passw0rd123',
        merchantName: '正常商家',
        subdomain: `ok-shop-${randomBytes(4).toString('hex')}`,
        storeName: '正常店铺',
      });

    expect(response.status).toBe(201);
  });

  describe('DTO 校验', () => {
    // 这些断言覆盖的是「请求在到达服务层之前就被拒」这条路径：
    // 邮箱格式、密码强度、子域名格式、保留名单、登录入口枚举。
    // 只断言 400，不断言错误文案——文案属于实现细节，改措辞不该弄红测试。

    const merchantPayload = () => ({
      email: `valid-${unique()}@example.test`,
      password: 'Passw0rd123',
      merchantName: '校验商家',
      subdomain: subdomain(),
      storeName: '校验店铺',
    });

    it('邮箱格式非法时注册返回 400', async () => {
      await http(app)
        .post('/api/v1/auth/register/merchant')
        .send({ ...merchantPayload(), email: 'not-an-email' })
        .expect(400);
    });

    it('密码短于 8 位时注册返回 400', async () => {
      await http(app)
        .post('/api/v1/auth/register/merchant')
        .send({ ...merchantPayload(), password: 'Pw0' })
        .expect(400);
    });

    it('密码不含数字时注册返回 400', async () => {
      await http(app)
        .post('/api/v1/auth/register/merchant')
        .send({ ...merchantPayload(), password: 'PasswordOnly' })
        .expect(400);
    });

    it('子域名含非法字符时注册返回 400', async () => {
      // 下划线不在子域名字符集内。下划线常被误当作「域名里可以用」，
      // 一旦写入侧放行，`ab_cd.platform.test` 在 DNS 与 Host 头里就会表现不一致。
      await http(app)
        .post('/api/v1/auth/register/merchant')
        .send({ ...merchantPayload(), subdomain: 'ab_cd' })
        .expect(400);
    });

    it('商家名短于 2 位时注册返回 400', async () => {
      await http(app)
        .post('/api/v1/auth/register/merchant')
        .send({ ...merchantPayload(), merchantName: 'x' })
        .expect(400);
    });

    it('登录时 scope 非法返回 400', async () => {
      await http(app)
        .post('/api/v1/auth/login')
        .send({
          email: `someone-${unique()}@example.test`,
          password: 'Passw0rd123',
          scope: 'ADMIN',
        })
        .expect(400);
    });

    it('请求携带 DTO 未声明的字段时返回 400', async () => {
      // forbidNonWhitelisted：多传字段一律拒绝，避免调用方误以为
      // 后端接收并持久化了它其实没声明的数据（比如 role、tenantId）。
      await http(app)
        .post('/api/v1/auth/register/merchant')
        .send({ ...merchantPayload(), role: 'PLATFORM_ADMIN', tenantId: null })
        .expect(400);
    });
  });

  describe('平台超管登录', () => {
    const adminEmail =
      process.env.SEED_PLATFORM_ADMIN_EMAIL ?? 'admin@platform.test';
    const adminPassword =
      process.env.SEED_PLATFORM_ADMIN_PASSWORD ?? 'Admin12345!';

    it('平台超管可用 PLATFORM 入口登录，且 tenantId 为空', async () => {
      // 平台超管是唯一不属于任何租户的角色，tenantId 必须是 null。
      // 若这里出现具体租户 id，说明该账号被错误地挂到了某个商家名下。
      const response = await http(app).post('/api/v1/auth/login').send({
        email: adminEmail,
        password: adminPassword,
        scope: 'PLATFORM',
      });

      expect(response.status).toBe(200);
      expect(body(response).accessToken).toBeTruthy();
      expect(body(response).user.role).toBe('PLATFORM_ADMIN');
      expect(body(response).user.tenantId).toBeNull();
    });

    it('平台超管走 MERCHANT 入口登录返回 401', async () => {
      // 入口与角色不匹配必须失败，否则攻击者能用任意入口
      // 试探出某个邮箱对应的账号角色。
      await http(app)
        .post('/api/v1/auth/login')
        .send({
          email: adminEmail,
          password: adminPassword,
          scope: 'MERCHANT',
        })
        .expect(401);
    });
  });

  it('登出后重放该令牌不影响用户其它设备的登录', async () => {
    // 多设备并存（手机 + 电脑同时登录商家后台）是常态。用户在 A 设备登出后，
    // 因为客户端重试或竞态又把那枚令牌拿去刷新，这是误用而不是泄露；
    // 若把它按重放处理，B 设备会被无端踢下线。
    const account = email();

    await http(app)
      .post('/api/v1/auth/register/merchant')
      .send({
        email: account,
        password: 'Passw0rd123',
        merchantName: '商家癸',
        subdomain: subdomain(),
        storeName: '店铺癸',
      })
      .expect(201);

    // 登录两次 = 两个设备各拿一枚刷新令牌
    const deviceA = await http(app)
      .post('/api/v1/auth/login')
      .send({ email: account, password: 'Passw0rd123', scope: 'MERCHANT' })
      .expect(200);
    const deviceB = await http(app)
      .post('/api/v1/auth/login')
      .send({ email: account, password: 'Passw0rd123', scope: 'MERCHANT' })
      .expect(200);

    const tokenA = body(deviceA).refreshToken;
    const tokenB = body(deviceB).refreshToken;
    const accessA = body(deviceA).accessToken;
    expect(tokenA).not.toBe(tokenB);

    // A 设备登出
    await http(app)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${accessA}`)
      .send({ refreshToken: tokenA })
      .expect(204);

    // A 设备再次使用已登出的令牌 → 401
    await http(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: tokenA })
      .expect(401);

    // 关键断言：B 设备完全没参与这次误用，必须仍然可用
    await http(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: tokenB })
      .expect(200);
  });

  describe('刷新令牌重放检测', () => {
    // ⚠️ 本组用例共享一个账号且依赖执行顺序（jest 默认同文件内串行）。
    //   第 2 步触发的重放检测会吊销整个令牌族，第 3 步的 401 正是在断言这一点；
    //   若把第 3 步拆到独立用例里跑，它会拿到一枚还没被作废的令牌而失败。
    let account: string;
    let original: string;
    let rotated: string;

    it('刷新换取新令牌', async () => {
      const email = `replay-${unique()}@example.test`;
      account = email;

      const register = await http(app)
        .post('/api/v1/auth/register/merchant')
        .send({
          email,
          password: 'Passw0rd123',
          merchantName: '重放商家',
          subdomain: subdomain(),
          storeName: '重放店铺',
        })
        .expect(201);

      original = body(register).refreshToken;

      const refreshed = await http(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: original })
        .expect(200);

      rotated = body(refreshed).refreshToken;
      expect(rotated).not.toBe(original);
    });

    it('再次使用已轮换的旧令牌返回 401，并连带作废整个令牌族', async () => {
      // 重放检测：旧令牌被再次使用说明它可能已泄露，
      // 按安全最佳实践吊销该用户的全部刷新令牌。
      await http(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: original })
        .expect(401);

      // 关键断言：上一条作废了令牌族，因此轮换出来的那枚「合法」令牌
      // 也必须失效。没有这一步，系统只挡住旧令牌，攻击者仍可用
      // 已轮换的令牌无限续期。
      await http(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: rotated })
        .expect(401);
    });

    it('令牌族被作废后重新登录仍可获得全新令牌', async () => {
      // 刷新令牌族与登录是两件事：作废令牌族不应把用户永久锁在门外。
      const response = await http(app)
        .post('/api/v1/auth/login')
        .send({ email: account, password: 'Passw0rd123', scope: 'MERCHANT' });

      expect(response.status).toBe(200);

      const fresh = body(response).refreshToken;
      expect(fresh).not.toBe(original);
      expect(fresh).not.toBe(rotated);

      // 新拿到的令牌属于新令牌族，可以正常刷新
      await http(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: fresh })
        .expect(200);
    });
  });

  describe('店主邮箱全局唯一', () => {
    it('同一邮箱不能开第二个商家账号', async () => {
      // 店主账号是「这个人在平台上的身份」，不是「这个人在某家店的岗位」。
      // 同一邮箱在多个租户各开一个店主，登录时跨租户按邮箱查账号会出现
      // 多个候选，落点不确定。要经营第二家店应该用 MERCHANT_STAFF 身份。
      const account = email();

      const first = await http(app)
        .post('/api/v1/auth/register/merchant')
        .send({
          email: account,
          password: 'Passw0rd123',
          merchantName: '重复店主甲',
          subdomain: subdomain(),
          storeName: '店铺甲',
        })
        .expect(201);

      const firstTenant = body(first).user.tenantId;

      // 子域名不同、只有邮箱相同 → 仍必须被拒（409）
      const second = await http(app)
        .post('/api/v1/auth/register/merchant')
        .send({
          email: account,
          password: 'Passw0rd123',
          merchantName: '重复店主乙',
          subdomain: subdomain(),
          storeName: '店铺乙',
        });

      expect(second.status).toBe(409);
      expect(second.body as { message: string }).toEqual(
        expect.objectContaining({ message: '该邮箱已注册商家账号' }),
      );

      // 大小写不同的同一邮箱同样要拦住：邮箱唯一性是大小写不敏感的
      await http(app)
        .post('/api/v1/auth/register/merchant')
        .send({
          email: account.toUpperCase(),
          password: 'Passw0rd123',
          merchantName: '重复店主丙',
          subdomain: subdomain(),
          storeName: '店铺丙',
        })
        .expect(409);

      // 反向断言：被拒的那次没有留下第二个租户
      const login = await http(app)
        .post('/api/v1/auth/login')
        .send({ email: account, password: 'Passw0rd123', scope: 'MERCHANT' })
        .expect(200);

      expect(body(login).user.tenantId).toBe(firstTenant);
    });

    it('同一邮箱可以既开店主又注册消费者', async () => {
      // 店主邮箱是「全局唯一」而不是「独占」：邮箱的所有权归这个人，
      // 但他在自家店铺里当消费者是另一回事，那是租户内的另一个账号。
      const account = email();
      const sub = subdomain();

      const owner = await http(app)
        .post('/api/v1/auth/register/merchant')
        .send({
          email: account,
          password: 'Passw0rd123',
          merchantName: '双重身份商家',
          subdomain: sub,
          storeName: '店铺',
        })
        .expect(201);

      const customer = await http(app)
        .post('/api/v1/auth/register/customer')
        .set('X-Tenant-Subdomain', sub)
        .send({
          email: account,
          password: 'Passw0rd123',
          displayName: '双重身份顾客',
        });

      expect(customer.status).toBe(201);
      expect(body(customer).user.role).toBe('CUSTOMER');
      expect(body(customer).user.tenantId).toBe(body(owner).user.tenantId);
    });
  });

  describe('并发刷新', () => {
    it('同一枚令牌并发刷新两次只有一次成功，且不牵连其它设备', async () => {
      // 客户端双击刷新、SDK 自动重试都会让同一枚令牌被并发提交两次。
      // 若轮换是「先查后写」，两个请求都会读到 revokedAt === null，
      // 后一个会把前一个刚签发的新令牌误判为重放并作废全族——
      // 一次无害的重试会让用户自己被踢下线。
      const account = email();

      await http(app)
        .post('/api/v1/auth/register/merchant')
        .send({
          email: account,
          password: 'Passw0rd123',
          merchantName: '并发商家',
          subdomain: subdomain(),
          storeName: '并发店铺',
        })
        .expect(201);

      // 两个设备各登录一次
      const deviceA = await http(app)
        .post('/api/v1/auth/login')
        .send({ email: account, password: 'Passw0rd123', scope: 'MERCHANT' })
        .expect(200);
      const deviceB = await http(app)
        .post('/api/v1/auth/login')
        .send({ email: account, password: 'Passw0rd123', scope: 'MERCHANT' })
        .expect(200);

      const tokenA = body(deviceA).refreshToken;
      const tokenB = body(deviceB).refreshToken;
      expect(tokenA).not.toBe(tokenB);

      // 同一个 tokenA 并发刷新两次
      const results = await Promise.all([
        http(app).post('/api/v1/auth/refresh').send({ refreshToken: tokenA }),
        http(app).post('/api/v1/auth/refresh').send({ refreshToken: tokenA }),
      ]);

      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 401]);

      // 成功的那次必须真的换到了新令牌
      const winner = results.find((r) => r.status === 200);
      const winnerToken = body(winner!).refreshToken;
      expect(winnerToken).not.toBe(tokenA);

      // 关键断言 1：winner 刚签发的那枚令牌必须仍然可用。
      // 竞态修复之前，loser 会把这枚「合法的新令牌」当成重放标成 REPLAY
      // 并连带作废全族——用户刚刷新成功，拿到的令牌却当场失效。
      await http(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: winnerToken })
        .expect(200);

      // 关键断言 2：B 设备完全没参与这次并发，必须仍然能刷新。
      // 竞态修复之前，B 会被 A 的重试连带作废。
      await http(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: tokenB })
        .expect(200);
    });
  });

  describe('登出身份绑定', () => {
    it('不带访问令牌登出返回 401', async () => {
      // 登出只按 tokenHash 匹配、不校验调用者身份时，任何人拿到别人的
      // 刷新令牌即可盲登出对方会话。绑定身份后，未认证的调用一律拒绝。
      const register = await http(app)
        .post('/api/v1/auth/register/merchant')
        .send({
          email: email(),
          password: 'Passw0rd123',
          merchantName: '登出商家',
          subdomain: subdomain(),
          storeName: '登出店铺',
        })
        .expect(201);

      await http(app)
        .post('/api/v1/auth/logout')
        .send({ refreshToken: body(register).refreshToken })
        .expect(401);

      // 被拒的登出不能顺带吊销令牌：否则攻击者用一个无效请求就能踢人下线
      await http(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: body(register).refreshToken })
        .expect(200);
    });

    it('用 A 的令牌登出 B 的刷新令牌返回 401', async () => {
      const userA = email();
      const userB = email();

      const regA = await http(app)
        .post('/api/v1/auth/register/merchant')
        .send({
          email: userA,
          password: 'Passw0rd123',
          merchantName: '商家A',
          subdomain: subdomain(),
          storeName: '店铺A',
        })
        .expect(201);

      const regB = await http(app)
        .post('/api/v1/auth/register/merchant')
        .send({
          email: userB,
          password: 'Passw0rd123',
          merchantName: '商家B',
          subdomain: subdomain(),
          storeName: '店铺B',
        })
        .expect(201);

      // A 拿着自己的合法令牌，去登出 B 的刷新令牌 → 必须被拒
      await http(app)
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${body(regA).accessToken}`)
        .send({ refreshToken: body(regB).refreshToken })
        .expect(401);

      // B 的令牌必须毫发无损
      await http(app)
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: body(regB).refreshToken })
        .expect(200);
    });
  });

  describe('跨租户同邮箱登录的确定性', () => {
    it('不带子域名登录同邮箱消费者时，两次请求落到同一个租户', async () => {
      // 消费者邮箱只在租户内唯一，因此同一家邮箱可以在 A、B 两个店铺各有一个账号。
      // 登录发生在中心域名上，跨租户按邮箱查账号；候选多于一个时若不指定顺序，
      // 数据库返回哪一行是不确定的，用户会「这次进 A 店、下次进 B 店」。
      const shared = `dual-${unique()}@example.test`;
      const subA = subdomain();
      const subB = subdomain();

      await http(app)
        .post('/api/v1/auth/register/merchant')
        .send({
          email: email(),
          password: 'Passw0rd123',
          merchantName: '店铺A商家',
          subdomain: subA,
          storeName: '店铺A',
        })
        .expect(201);

      await http(app)
        .post('/api/v1/auth/register/merchant')
        .send({
          email: email(),
          password: 'Passw0rd123',
          merchantName: '店铺B商家',
          subdomain: subB,
          storeName: '店铺B',
        })
        .expect(201);

      const customerA = await http(app)
        .post('/api/v1/auth/register/customer')
        .set('X-Tenant-Subdomain', subA)
        .send({ email: shared, password: 'Passw0rd123', displayName: '顾客A' })
        .expect(201);

      const customerB = await http(app)
        .post('/api/v1/auth/register/customer')
        .set('X-Tenant-Subdomain', subB)
        .send({ email: shared, password: 'Passw0rd123', displayName: '顾客B' })
        .expect(201);

      // 两个租户确实各有同一个邮箱的消费者
      expect(body(customerA).user.tenantId).not.toBe(
        body(customerB).user.tenantId,
      );

      // 两次不带子域名的登录必须落到同一个租户（最早创建的那个）
      const first = await http(app)
        .post('/api/v1/auth/login')
        .send({ email: shared, password: 'Passw0rd123', scope: 'CUSTOMER' })
        .expect(200);

      const second = await http(app)
        .post('/api/v1/auth/login')
        .send({ email: shared, password: 'Passw0rd123', scope: 'CUSTOMER' })
        .expect(200);

      expect(body(second).user.tenantId).toBe(body(first).user.tenantId);
      // 落点是「最早创建」的那个，而不是随机或未定义
      expect(body(first).user.tenantId).toBe(body(customerA).user.tenantId);
    });

    // 上一个用例把「不指定店铺时按创建时间兜底」的行为固定住了。
    // 但真实的 storefront 一定会带店铺子域名（浏览器就在那家店的域名下），
    // 此时必须登录进**正在浏览的这家店**，而不是最早创建的那家。
    it('带店铺子域名登录时落到该店铺的顾客账号', async () => {
      const shared = `scoped-${unique()}@example.test`;
      const subA = subdomain();
      const subB = subdomain();

      await http(app)
        .post('/api/v1/auth/register/merchant')
        .send({
          email: email(),
          password: 'Passw0rd123',
          merchantName: '店铺丙商家',
          subdomain: subA,
          storeName: '店铺丙',
        })
        .expect(201);

      await http(app)
        .post('/api/v1/auth/register/merchant')
        .send({
          email: email(),
          password: 'Passw0rd123',
          merchantName: '店铺丁商家',
          subdomain: subB,
          storeName: '店铺丁',
        })
        .expect(201);

      const customerA = await http(app)
        .post('/api/v1/auth/register/customer')
        .set('X-Tenant-Subdomain', subA)
        .send({ email: shared, password: 'Passw0rd123', displayName: '顾客丙' })
        .expect(201);

      const customerB = await http(app)
        .post('/api/v1/auth/register/customer')
        .set('X-Tenant-Subdomain', subB)
        .send({ email: shared, password: 'Passw0rd123', displayName: '顾客丁' })
        .expect(201);

      expect(body(customerA).user.tenantId).not.toBe(
        body(customerB).user.tenantId,
      );

      // 在 B 店的域名下登录，拿到的一定是 B 店的账号
      const loginB = await http(app)
        .post('/api/v1/auth/login')
        .set('X-Tenant-Subdomain', subB)
        .send({ email: shared, password: 'Passw0rd123', scope: 'CUSTOMER' })
        .expect(200);

      expect(body(loginB).user.tenantId).toBe(body(customerB).user.tenantId);
      expect(body(loginB).user.displayName).toBe('顾客丁');

      // 在 A 店的域名下登录，拿到的一定是 A 店的账号
      const loginA = await http(app)
        .post('/api/v1/auth/login')
        .set('X-Tenant-Subdomain', subA)
        .send({ email: shared, password: 'Passw0rd123', scope: 'CUSTOMER' })
        .expect(200);

      expect(body(loginA).user.tenantId).toBe(body(customerA).user.tenantId);
      expect(body(loginA).user.displayName).toBe('顾客丙');
    });

    it('子域名解析不出来时静默回退，不影响登录', async () => {
      // 中心域名上的登录请求本来就没有店铺子域名；子域名指向不存在的租户
      // 或保留名字时也一样。都应当退回「不限定租户」的旧行为，而不是 404。
      const account = `fallback-${unique()}@example.test`;
      const sub = subdomain();

      await http(app)
        .post('/api/v1/auth/register/merchant')
        .send({
          email: email(),
          password: 'Passw0rd123',
          merchantName: '店铺戊商家',
          subdomain: sub,
          storeName: '店铺戊',
        })
        .expect(201);

      const registered = await http(app)
        .post('/api/v1/auth/register/customer')
        .set('X-Tenant-Subdomain', sub)
        .send({
          email: account,
          password: 'Passw0rd123',
          displayName: '顾客戊',
        })
        .expect(201);

      // ① 未注册的子域名
      const unknown = await http(app)
        .post('/api/v1/auth/login')
        .set('X-Tenant-Subdomain', `no-such-${unique()}`)
        .send({ email: account, password: 'Passw0rd123', scope: 'CUSTOMER' })
        .expect(200);
      expect(body(unknown).user.tenantId).toBe(body(registered).user.tenantId);

      // ② 保留子域名
      const reserved = await http(app)
        .post('/api/v1/auth/login')
        .set('X-Tenant-Subdomain', 'admin')
        .send({ email: account, password: 'Passw0rd123', scope: 'CUSTOMER' })
        .expect(200);
      expect(body(reserved).user.tenantId).toBe(body(registered).user.tenantId);
    });

    it('带店铺子域名登录商家不受影响', async () => {
      // 租户限定只对消费者生效：店主的租户由全局唯一的邮箱决定，
      // 在任意子域名下登录商家账号都必须成功，不能因为「子域名不属于他」
      // 就把合法的店主挡在门外。
      const account = `owner-${unique()}@example.test`;

      await http(app)
        .post('/api/v1/auth/register/merchant')
        .send({
          email: account,
          password: 'Passw0rd123',
          merchantName: '店铺己商家',
          subdomain: subdomain(),
          storeName: '店铺己',
        })
        .expect(201);

      const response = await http(app)
        .post('/api/v1/auth/login')
        .set('X-Tenant-Subdomain', subdomain())
        .send({ email: account, password: 'Passw0rd123', scope: 'MERCHANT' })
        .expect(200);

      expect(body(response).user.role).toBe('MERCHANT_OWNER');
    });
  });
});
