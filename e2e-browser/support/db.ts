import { PrismaClient } from '@prisma/client';

import { DATABASE_URL } from './env';

/**
 * 浏览器 e2e 的数据库夹具（固定订单）。
 *
 * ⚠️ **为什么用 Prisma 直连而不是走接口造数据**：
 * 有些场景（跨租户挂载）接口层本来就会拒绝，只能绕过接口直接落库，
 * 否则永远造不出「库里有、但当前租户不该看到」的那条数据。
 *
 * ⚠️ 这里连的是 `ecommerce_browser`（独立库），不是开发库也不是测试库。
 * 夹具全部用 `upsert`（tenant 按 subdomain、order 按 orderNo），
 * 所以 CI 的 `retries: 1` 重跑、本地反复跑都不会冲突。
 */

process.env.DATABASE_URL ??= DATABASE_URL;

const prisma = new PrismaClient();

/** 与 `api/prisma/seed.ts` 的示例店铺对齐 */
const DEMO_SUBDOMAIN = 'demo';

/** 游客查单用例的固定订单（正例用它，反例也用它试错） */
export const GUEST_ORDER = {
  orderNo: 'P34GUEST0001',
  receiverName: '游客查单收货人',
  receiverPhone: '13900002222',
  totalAmount: 19900,
  itemCount: 2,
} as const;

/** demo 店铺自己的订单：跨租户用例的正向对照（登录态应当看得到） */
export const DEMO_ORDER = {
  orderNo: 'P34DEMO0001',
  receiverName: '演示顾客本人',
  receiverPhone: '13900001111',
  totalAmount: 9900,
  itemCount: 1,
} as const;

/**
 * 另一个租户的订单。
 *
 * ⚠️ **可证伪的关键**：这条订单的 `customerId` 故意指向 demo 店铺的同一个消费者，
 * `tenantId` 才是租户 B。也就是说它与 `DEMO_ORDER` 的唯一差别就是租户 —
 * `readConsumerOrder` 的 where 只有 `orderNo + customerId`，租户条件完全由
 * Prisma 租户扩展附加。**一旦扩展失效，demo 顾客就能打开这条订单**，
 * 详情页会渲染出「租户B收货人」这个 canary，用例立刻变红。
 */
export const CROSS_TENANT_ORDER = {
  orderNo: 'P34XTENANT0001',
  receiverName: '租户B收货人',
  receiverPhone: '13900003333',
  totalAmount: 12300,
  itemCount: 1,
} as const;

const CROSS_TENANT = {
  subdomain: 'p34-tenant-b',
  name: '浏览器测试租户B',
} as const;

const ADDRESS = {
  province: '浙江省',
  city: '杭州市',
  district: '西湖区',
  detail: '浏览器 e2e 固定夹具地址 1 号',
} as const;

type OrderSeed = {
  orderNo: string;
  receiverName: string;
  receiverPhone: string;
  totalAmount: number;
  itemCount: number;
};

function orderPayload(tenantId: string, customerId: string | null, seed: OrderSeed) {
  return {
    tenantId,
    customerId,
    status: 'PAID' as const,
    totalAmount: seed.totalAmount,
    itemCount: seed.itemCount,
    receiverName: seed.receiverName,
    receiverPhone: seed.receiverPhone,
    ...ADDRESS,
    paidAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

/**
 * 按 orderNo upsert 一条订单。
 *
 * `createdAt` 每次都刷新：商家后台订单列表按创建时间倒序，
 * 夹具订单要稳定出现在第一页，否则翻页后断言就找不到它了。
 */
async function upsertOrder(
  tenantId: string,
  customerId: string | null,
  seed: OrderSeed,
): Promise<void> {
  const payload = orderPayload(tenantId, customerId, seed);
  const createdAt = new Date();
  await prisma.order.upsert({
    where: { orderNo: seed.orderNo },
    create: { ...payload, orderNo: seed.orderNo, createdAt },
    update: { ...payload, createdAt },
  });
}

async function demoTenantAndCustomer() {
  const tenant = await prisma.tenant.findFirstOrThrow({
    where: { subdomain: DEMO_SUBDOMAIN },
  });
  const customer = await prisma.user.findFirstOrThrow({
    where: { email: 'customer@demo.platform.test', tenantId: tenant.id },
  });
  return { tenantId: tenant.id, customerId: customer.id };
}

/** 游客查单用例：demo 店铺下一条 status=PAID 的固定订单 */
export async function ensureGuestLookupOrder(): Promise<void> {
  const { tenantId, customerId } = await demoTenantAndCustomer();
  await upsertOrder(tenantId, customerId, GUEST_ORDER);
}

/**
 * 跨租户用例：demo 自己的订单 + 租户 B 下挂在**同一个消费者**名下的订单。
 *
 * 返回租户 B 的 id，用例拿它做「库里有这条数据」的对照断言
 * （避免夹具没写进去时用例假绿）。
 */
export async function ensureCrossTenantOrders(): Promise<{ tenantBId: string }> {
  const { tenantId, customerId } = await demoTenantAndCustomer();
  await upsertOrder(tenantId, customerId, DEMO_ORDER);

  const tenantB = await prisma.tenant.upsert({
    where: { subdomain: CROSS_TENANT.subdomain },
    create: { ...CROSS_TENANT },
    update: { name: CROSS_TENANT.name },
  });
  await upsertOrder(tenantB.id, customerId, CROSS_TENANT_ORDER);

  return { tenantBId: tenantB.id };
}

/** 商家后台用例只需要 demo 自己那条订单，顺带保证它一定存在 */
export async function ensureDemoOrder(): Promise<void> {
  const { tenantId, customerId } = await demoTenantAndCustomer();
  await upsertOrder(tenantId, customerId, DEMO_ORDER);
}

export async function disconnectFixtures(): Promise<void> {
  await prisma.$disconnect();
}
