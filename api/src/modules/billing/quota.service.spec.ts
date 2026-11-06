import { ConflictException } from '@nestjs/common';

import type { PrismaTransaction } from '../../common/prisma/prisma-transaction';
import { QuotaService } from './quota.service';

/**
 * 额度检查的单元测试（审计 P2-9 / P2-9b / P2-10）。
 *
 * ⚠️ **这里验的是「怎么判」和「按什么顺序判」**：并发放大本身要靠 e2e
 * （真事务、真行锁），单测只能钉住三件事：
 *   1. 上限、无套餐、上限为 null 三档的分支；
 *   2. **先锁订阅行、再计数**（顺序反了锁就白加了）；
 *   3. SKU 的计数口径排除 INACTIVE。
 */
describe('QuotaService.assertWithinQuota', () => {
  const service = new QuotaService({} as never);

  interface FakeOptions {
    /** null = 没有订阅；不传 = 有一条 planId 为 plan-1 的订阅 */
    subscription?: { planId: string } | null;
    /** 套餐行，null = 查不到 */
    plan?: Record<string, unknown> | null;
    counts?: { PRODUCT?: number; SKU?: number; STORE?: number };
  }

  /**
   * 假的 Prisma 事务客户端。
   *
   * ⚠️ **记录调用顺序**：`calls` 数组就是断言「先锁后数」的全部依据。
   */
  function fakeClient(options: FakeOptions = {}) {
    const calls: string[] = [];
    const lockRaw = jest.fn(
      (strings: TemplateStringsArray, tenantId: string) => {
        calls.push('lock');
        // 把 SQL 与绑定参数一起记下来：断言「锁的是本租户」要用到 tenantId
        return Promise.resolve([{ sql: strings.join('?'), tenantId }]);
      },
    );

    const countOf = (kind: 'PRODUCT' | 'SKU' | 'STORE') =>
      jest.fn(() => {
        calls.push(`count:${kind}`);
        return Promise.resolve(options.counts?.[kind] ?? 0);
      });

    const skuCount = countOf('SKU');

    const raw = {
      subscription: {
        findFirst: jest.fn(() => {
          calls.push('subscription');
          return Promise.resolve(
            options.subscription === undefined
              ? { planId: 'plan-1' }
              : options.subscription,
          );
        }),
      },
      plan: {
        findFirst: jest.fn(() => {
          calls.push('plan');
          return Promise.resolve(options.plan ?? null);
        }),
      },
      product: { count: countOf('PRODUCT') },
      sku: { count: skuCount },
      store: { count: countOf('STORE') },
      // 原生 SQL 是标签模板：第一个参数是字符串片段，第二个才是绑定的 tenantId
      $queryRaw: lockRaw,
    };

    return {
      client: raw as unknown as PrismaTransaction,
      calls,
      lockRaw,
      skuCount,
    };
  }

  it('没有订阅 → 不限制，也不加锁（没套餐就没有上限）', async () => {
    const { client, calls } = fakeClient({ subscription: null });

    await expect(
      service.assertWithinQuota('t1', 'PRODUCT', client),
    ).resolves.toBeUndefined();

    // 只查了一次订阅就返回：既不该读套餐，也不该去锁一行不存在的记录
    expect(calls).toEqual(['subscription']);
  });

  it('上限为 null → 不限制，且不加锁', async () => {
    const { client, calls } = fakeClient({ plan: { maxProducts: null } });

    await expect(
      service.assertWithinQuota('t1', 'PRODUCT', client),
    ).resolves.toBeUndefined();

    expect(calls).toEqual(['subscription', 'plan']);
  });

  it('已达上限 + 默认 delta（1）→ 409，文案说清上限与下一步', async () => {
    const { client } = fakeClient({
      plan: { maxProducts: 1 },
      counts: { PRODUCT: 1 },
    });

    await expect(
      service.assertWithinQuota('t1', 'PRODUCT', client),
    ).rejects.toThrow(ConflictException);
    await expect(
      service.assertWithinQuota('t1', 'PRODUCT', client),
    ).rejects.toThrow('当前套餐最多 1 个商品，请升级套餐');
  });

  it('先锁订阅行，再计数（顺序反了等于没锁）', async () => {
    const { client, calls } = fakeClient({
      plan: { maxProducts: 5 },
      counts: { PRODUCT: 0 },
    });

    await service.assertWithinQuota('t1', 'PRODUCT', client);

    expect(calls).toEqual(['subscription', 'plan', 'lock', 'count:PRODUCT']);
  });

  it('锁的是本租户的订阅行（原生 SQL 绕过了租户扩展，tenantId 必须显式传）', async () => {
    const { client, lockRaw } = fakeClient({
      plan: { maxProducts: 5 },
      counts: { PRODUCT: 0 },
    });

    await service.assertWithinQuota('tenant-abc', 'PRODUCT', client);

    // 标签模板的实参：(${字符串片段}, tenantId)
    expect(lockRaw.mock.calls[0][1]).toBe('tenant-abc');
  });

  it('SKU 计数排除 INACTIVE（改规格留下的旧 SKU 不该占额度）', async () => {
    const { client, skuCount } = fakeClient({
      plan: { maxSkus: 5 },
      counts: { SKU: 0 },
    });

    await service.assertWithinQuota('t1', 'SKU', client);

    expect(skuCount).toHaveBeenCalledWith({
      where: { tenantId: 't1', status: 'ACTIVE' },
    });
  });

  it('delta 为负数（缩小规格矩阵）→ 释放额度，放行', async () => {
    const { client } = fakeClient({
      plan: { maxSkus: 5 },
      // 现在有 10 个活跃 SKU（早就超了），但这次操作会缩到 2 个
      counts: { SKU: 10 },
    });

    await expect(
      service.assertWithinQuota('t1', 'SKU', client, -8),
    ).resolves.toBeUndefined();
  });

  it('delta 为 0（写后校验）→ 按当前实际数量判，超一个都拒', async () => {
    const { client } = fakeClient({
      plan: { maxSkus: 5 },
      counts: { SKU: 6 },
    });

    await expect(
      service.assertWithinQuota('t1', 'SKU', client, 0),
    ).rejects.toThrow('当前套餐最多 5 个SKU，请升级套餐');
  });
});
