import { InventoryMovementType } from '@prisma/client';

import { OrderInventoryService } from './inventory.service';
import { tenantContext } from '../../common/tenant/tenant-context';

/**
 * 订单库存服务 releaseInTx / deductInTx 的单测（审计批次 20 · 软删 SKU 的库存回写）。
 *
 * 被测缺陷：`writeMovements` 释放预占时用 `tx.sku.updateMany` 回写库存，
 * 但租户扩展会往 where 里自动合并 `deletedAt: null`（软删过滤），
 * 对**已软删**的 SKU 命中 0 行 → 抛 409「库存已被他人修改，请重试」，
 * 卡住释放/退款，且流水也没写。
 *
 * ⚠️ **假 Prisma 是「配置驱动」的**（与 `cart.service.spec.ts` 同款）：
 * 每个方法的返回值由 `options` 配好，不按 `where` 过滤。
 *
 * ⚠️ **`releaseInTx` 不开事务**——事务由调用方（order.service.ts）开，
 * 它只接收 `tx` 参数直接干活，所以测试直接把假 `tx` 传进去，
 * 不需要 mock `$transaction`。
 */

const TENANT = 'tenant-a';
const ORDER_ID = 'order-1';
const SKU_ID = 'sku-1';

/** 假 Prisma 的查询参数（只要能读出 `where` / `data` 就够断言了） */
interface QueryArgs {
  where?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

/**
 * 取某个 mock 的第一次调用参数，顺便断言它确实被调用过
 * （避免 `mock.calls[0][0]` 在 strictNullChecks 下报「可能为 undefined」）。
 */
function argsOf(mock: { mock: { calls: unknown[][] } }): QueryArgs {
  const [call] = mock.mock.calls;
  expect(call).toBeDefined();
  return (call ?? [])[0] as QueryArgs;
}

interface FakeOptions {
  /** 行锁读出的 SKU 的 deletedAt（null = 未删，非 null = 已软删） */
  deletedAt?: Date | null;
  /**
   * 库存回写命中的行数。
   * - `updateMany`（未软删 SKU）走扩展软删过滤，命中 0 行 = 已软删被拦下；
   * - `$executeRaw`（已软删 SKU）走裸 SQL，命中 0 行 = 乐观锁被并发抢走。
   */
  updateManyCount?: number;
}

function fakePrisma(options: FakeOptions = {}) {
  const deletedAt = options.deletedAt ?? null;
  const updateManyCount = options.updateManyCount ?? 1;

  /** 行锁读出的 SKU 快照：预占时库存 10→5，释放 5 件要还回 10 */
  const skuRow = {
    id: SKU_ID,
    productId: 'prod-1',
    price: 1000,
    stock: 5,
    stockVersion: 0,
    status: 'ACTIVE',
    deletedAt,
  };

  const tx = {
    // ⚠️ 手写 SQL（$queryRaw 绕过扩展），必须返回「可能已软删」的 SKU 行——
    // 这正是 lockSkus 的行为：释放要能读到已软删的 SKU。
    $queryRaw: jest.fn(() => Promise.resolve([skuRow])),
    // ⚠️ 已软删 SKU 的库存回写走裸 SQL（$executeRaw 绕过扩展软删过滤）——
    // 命中行数 = updateManyCount；命中 0 行 = 乐观锁被抢 → 抛 409
    $executeRaw: jest.fn(() => Promise.resolve(updateManyCount)),
    inventoryMovement: {
      // 该订单在该 SKU 上已预占 5 件（未冲抵）
      findMany: jest.fn(() =>
        Promise.resolve([
          { skuId: SKU_ID, type: InventoryMovementType.RESERVE, quantity: -5 },
        ]),
      ),
      create: jest.fn((args: QueryArgs) =>
        Promise.resolve({ id: 'mv-1', ...(args.data as object) }),
      ),
    },
    sku: {
      updateMany: jest.fn(() => Promise.resolve({ count: updateManyCount })),
    },
  };

  const prisma = {};
  return { prisma, tx };
}

function makeService(prisma: unknown) {
  return new OrderInventoryService(prisma as never);
}

describe('OrderInventoryService 释放/售出（审计批次 20 · 软删 SKU 的库存回写）', () => {
  it('释放一个已软删 SKU 的预占：库存还回、流水写入，不抛 409', async () => {
    const { prisma, tx } = fakePrisma({
      // 已软删：库存回写走裸 SQL（$executeRaw 绕过扩展软删过滤），命中 1 行 = 成功。
      // ⚠️ 旧实现走 tx.sku.updateMany，被扩展自动合并 `deletedAt: null`
      //    → 命中 0 行 → 抛 ConflictException——正是要修的缺陷。
      deletedAt: new Date('2026-01-01T00:00:00.000Z'),
      updateManyCount: 1,
    });
    const service = makeService(prisma);

    // ⚠️ 必须包在 tenantContext.run 里：currentTenantId 用 requireTenantId() 读上下文。
    const movements = await tenantContext.run(
      { tenantId: TENANT, userId: null, role: null },
      () =>
        service.releaseInTx(tx as never, ORDER_ID, [
          { skuId: SKU_ID, quantity: 5 },
        ]),
    );

    expect(movements).toHaveLength(1);
    // 已软删 SKU 不再走租户扩展的 updateMany（会被软删过滤拦下）
    expect(tx.sku.updateMany).not.toHaveBeenCalled();
    expect(argsOf(tx.inventoryMovement.create).data).toMatchObject({
      tenantId: TENANT,
      skuId: SKU_ID,
      type: InventoryMovementType.RELEASE,
      quantity: 5,
      stockBefore: 5,
      stockAfter: 10,
      orderId: ORDER_ID,
    });
  });

  it('已软删 SKU 的裸 SQL 回写命中 0 行（乐观锁被抢）→ 仍抛 409', async () => {
    const { prisma, tx } = fakePrisma({
      deletedAt: new Date('2026-01-01T00:00:00.000Z'),
      updateManyCount: 0,
    });
    const service = makeService(prisma);

    await expect(
      tenantContext.run({ tenantId: TENANT, userId: null, role: null }, () =>
        service.releaseInTx(tx as never, ORDER_ID, [
          { skuId: SKU_ID, quantity: 5 },
        ]),
      ),
    ).rejects.toThrow('库存已被他人修改，请重试');
    // 流水没写（失败先于写流水）
    expect(tx.inventoryMovement.create).not.toHaveBeenCalled();
  });

  it('未软删 SKU 的释放仍走租户扩展 updateMany（保留软删过滤保护）', async () => {
    const { prisma, tx } = fakePrisma({ updateManyCount: 1 });
    const service = makeService(prisma);

    await tenantContext.run(
      { tenantId: TENANT, userId: null, role: null },
      () =>
        service.releaseInTx(tx as never, ORDER_ID, [
          { skuId: SKU_ID, quantity: 5 },
        ]),
    );

    // 未软删 → 走扩展 updateMany，裸 SQL 不掺和
    expect(tx.sku.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(argsOf(tx.sku.updateMany)).toEqual({
      where: { id: SKU_ID, stockVersion: 0 },
      data: { stock: 10, stockVersion: { increment: 1 } },
    });
  });
});
