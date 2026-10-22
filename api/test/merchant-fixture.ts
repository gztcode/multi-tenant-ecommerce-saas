import type { INestApplication } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import { http } from './helpers';

/** 随机后缀，避免同一个库里多次运行的测试撞 key / subdomain */
export const unique = () => randomBytes(6).toString('hex');

export interface MerchantFixture {
  token: string;
  subdomain: string;
  tenantId: string;
}

interface RegisterResponseBody {
  accessToken: string;
  user: {
    id: string;
    email: string;
    role: string;
    tenantId: string | null;
  };
}

/**
 * 注册一个商家，返回 accessToken、子域名与租户 id。
 *
 * 注册接口本身就直接返回 accessToken（阶段 1 的设计），不必再登录一次。
 * 请求体字段名以 `RegisterMerchantDto` 为准：email / password /
 * merchantName / subdomain / storeName；密码规则是 8-72 位且同时含字母与数字。
 *
 * 第二个参数 prisma 目前没用到，但后续 Task 的 e2e 需要在夹具之外直接落库
 * （例如构造「品类下有商品」的删除拒绝场景），保留它可以让调用方统一
 * 把持有的 TenantPrismaService 传进来，不必在每个用例里再取一次 app.get()。
 */
export async function createMerchant(
  app: INestApplication,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  prisma: TenantPrismaService,
): Promise<MerchantFixture> {
  const subdomain = `shop-${unique()}`;

  const response = await http(app)
    .post('/api/v1/auth/register/merchant')
    .send({
      email: `merchant-${unique()}@example.test`,
      password: 'Passw0rd123',
      merchantName: '测试商家',
      subdomain,
      storeName: '测试店铺',
    })
    .expect(201);

  const body = response.body as RegisterResponseBody;
  const tenantId = body.user.tenantId;
  if (!tenantId) {
    throw new Error('商家注册没有返回 tenantId，测试夹具无法继续');
  }

  return { token: body.accessToken, subdomain, tenantId };
}
