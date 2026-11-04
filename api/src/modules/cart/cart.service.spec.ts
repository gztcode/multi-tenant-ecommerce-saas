import { Cart } from '@prisma/client';

import { CartService } from './cart.service';

/**
 * 购物车服务 merge 的单测（阶段 7b · Task 1）。
 *
 * ⚠️ **假 Prisma 是「配置驱动」的**（与 `merchant-statement.service.spec.ts`
 *    同款）：每个方法的返回值由 `options` 配好，不按 `where` 过滤。
 *
 * ⚠️ **$transaction 的假实现**：直接把 `tx`（另一个假 Prisma 片段）传给回调，
 *    于是「写入发生在事务里还是事务外」可以靠**断言调用落在 tx 还是顶层
 *    prisma 上**来验——这正是事务化改造要保证的核心行为。
 */

const TENANT = 'tenant-a';
const CUSTOMER = 'customer-a';
const ACCOUNT_CART_ID = 'acc-cart';
const GUEST_CART_ID = 'guest-cart';

function accountCart(): Cart {
  return {
    id: ACCOUNT_CART_ID,
    tenantId: TENANT,
    customerId: CUSTOMER,
    guestToken: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function guestCart(): Cart {
  return {
    id: GUEST_CART_ID,
    tenantId: TENANT,
    customerId: null,
    guestToken: 'guest-token',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

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
  /** 账号车的条目 */
  accountItems?: Array<{ id: string; skuId: string; quantity: number }>;
  /** 游客车的条目 */
  guestItems?: Array<{ id: string; skuId: string; quantity: number }>;
  /** 当前可售的 SKU id 集合 */
  sellableSkuIds?: string[];
  /** 账号车查不到（幂等场景用不到，这里主要是留扩展位） */
  guestCartFound?: boolean;
}

function fakePrisma(options: FakeOptions = {}) {
  const accountItems = options.accountItems ?? [];
  const guestItems = options.guestItems ?? [];
  const sellable = new Set(options.sellableSkuIds ?? []);

  /**
   * 可售判定的假实现：返回「请求的 id ∩ 配置的可售集合」。
   *
   * ⚠️ 每次调用返回一个**独立的** jest.fn —— 事务客户端（tx）与非事务客户端
   *    （this.prisma）必须能分开断言「这一步查库走的是哪一个」。
   */
  const fakeSkuFindMany = () =>
    jest.fn<Promise<Array<{ id: string }>>, [args?: QueryArgs]>(
      (args?: QueryArgs) => {
        const ids = (args?.where?.id as { in?: string[] })?.in ?? [];
        return Promise.resolve(
          ids.filter((id) => sellable.has(id)).map((id) => ({ id })),
        );
      },
    );

  /** 事务内的假 Prisma 片段（写入断言都落在它身上） */
  const tx = {
    cartItem: {
      findMany: jest.fn<Promise<unknown>, [args?: QueryArgs]>(() =>
        Promise.resolve(accountItems),
      ),
      createMany: jest.fn<Promise<unknown>, [args?: QueryArgs]>(() =>
        Promise.resolve({ count: 0 }),
      ),
      updateMany: jest.fn<Promise<unknown>, [args?: QueryArgs]>(() =>
        Promise.resolve({ count: 0 }),
      ),
      deleteMany: jest.fn<Promise<unknown>, [args?: QueryArgs]>(() =>
        Promise.resolve({ count: 0 }),
      ),
    },
    cart: {
      deleteMany: jest.fn<Promise<unknown>, [args?: QueryArgs]>(() =>
        Promise.resolve({ count: 1 }),
      ),
    },
    // ⚠️ 可售判定在事务内也发生过一次（清陈旧条目）——那次必须走 tx
    sku: {
      findMany: fakeSkuFindMany(),
    },
  };

  const prisma = {
    cart: {
      // ⚠️ 一次 mock 服务两个查询：靠 where 里带的是 customerId 还是
      // guestToken 区分「找账号车」与「找游客车」。
      findFirst: jest.fn<Promise<unknown>, [args?: QueryArgs]>(
        (args?: QueryArgs) =>
          Promise.resolve(
            args?.where?.customerId
              ? accountCart()
              : options.guestCartFound === false
                ? null
                : guestCart(),
          ),
      ),
      create: jest.fn<Promise<unknown>, [args?: QueryArgs]>(() =>
        Promise.resolve(accountCart()),
      ),
      deleteMany: jest.fn<Promise<unknown>, [args?: QueryArgs]>(() =>
        Promise.resolve({ count: 1 }),
      ),
    },
    cartItem: {
      // 一次 mock 服务两个查询：靠 where.cartId 区分游客车与账号车条目
      findMany: jest.fn<Promise<unknown>, [args?: QueryArgs]>(
        (args?: QueryArgs) =>
          Promise.resolve(
            args?.where?.cartId === GUEST_CART_ID ? guestItems : accountItems,
          ),
      ),
      create: jest.fn<Promise<unknown>, [args?: QueryArgs]>(() =>
        Promise.resolve({}),
      ),
      updateMany: jest.fn<Promise<unknown>, [args?: QueryArgs]>(() =>
        Promise.resolve({ count: 0 }),
      ),
      deleteMany: jest.fn<Promise<unknown>, [args?: QueryArgs]>(() =>
        Promise.resolve({ count: 0 }),
      ),
    },
    sku: {
      // 可售判定：返回「请求的 id ∩ 配置的可售集合」
      findMany: fakeSkuFindMany(),
    },
    $transaction: jest.fn<
      Promise<unknown>,
      [cb: (tx: unknown) => Promise<unknown>]
    >((cb) => cb(tx)),
  };

  return { prisma, tx };
}

function makeService(prisma: ReturnType<typeof fakePrisma>['prisma']) {
  return new CartService(prisma as unknown as never);
}

describe('CartService.merge', () => {
  it('游客条目与账号条目并存时取 max，且新建/更新全部发生在同一事务里', async () => {
    // 账号车已有 sku-A×2，游客车 sku-A×5 + sku-B×3（均可售）
    const { prisma, tx } = fakePrisma({
      accountItems: [{ id: 'ai-1', skuId: 'sku-A', quantity: 2 }],
      guestItems: [
        { id: 'gi-1', skuId: 'sku-A', quantity: 5 },
        { id: 'gi-2', skuId: 'sku-B', quantity: 3 },
      ],
      sellableSkuIds: ['sku-A', 'sku-B'],
    });
    const service = makeService(prisma);

    await service.merge(TENANT, CUSTOMER, 'guest-token');

    // ⚠️ 整个合并只有一次 $transaction
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);

    // 账号车没有的 sku-B → 事务内 createMany，数量照搬游客的 3
    expect(tx.cartItem.createMany).toHaveBeenCalledTimes(1);
    expect(argsOf(tx.cartItem.createMany).data).toEqual([
      {
        tenantId: TENANT,
        cartId: ACCOUNT_CART_ID,
        skuId: 'sku-B',
        quantity: 3,
      },
    ]);

    // 两边都有的 sku-A → 取 max(2, 5)，事务内按数量分组 updateMany
    expect(tx.cartItem.updateMany).toHaveBeenCalledTimes(1);
    expect(argsOf(tx.cartItem.updateMany)).toEqual({
      where: { cartId: ACCOUNT_CART_ID, skuId: { in: ['sku-A'] } },
      data: { quantity: 5 },
    });

    // 删游客车也在同一个事务回调里执行
    expect(tx.cart.deleteMany).toHaveBeenCalledTimes(1);
    expect(argsOf(tx.cart.deleteMany).where).toEqual({ id: GUEST_CART_ID });

    // ⚠️ 事务之外不应该有任何写入（半合并状态的来源）
    expect(prisma.cartItem.create).not.toHaveBeenCalled();
    expect(prisma.cartItem.updateMany).not.toHaveBeenCalled();
    expect(prisma.cartItem.deleteMany).not.toHaveBeenCalled();
    expect(prisma.cart.deleteMany).not.toHaveBeenCalled();
  });

  it('合并中途失败 → 整体回滚：账号车无半合并状态、游客车仍在', async () => {
    const { prisma, tx } = fakePrisma({
      accountItems: [{ id: 'ai-1', skuId: 'sku-A', quantity: 2 }],
      guestItems: [
        { id: 'gi-1', skuId: 'sku-A', quantity: 5 },
        { id: 'gi-2', skuId: 'sku-B', quantity: 3 },
      ],
      sellableSkuIds: ['sku-A', 'sku-B'],
    });
    // 事务回调执行到删游客车时抛错（真实 Prisma 会回滚整个事务）
    tx.cart.deleteMany.mockRejectedValueOnce(new Error('db down'));
    const service = makeService(prisma);

    // ⚠️ 错误向上传播，不被吞掉
    await expect(
      service.merge(TENANT, CUSTOMER, 'guest-token'),
    ).rejects.toThrow('db down');

    // 回调里没有事务之外的写入被调用——成功路径的写入全在 tx 上，
    // 失败时真实 Prisma 回滚，账号车与游客车保持原状。
    expect(prisma.cartItem.create).not.toHaveBeenCalled();
    expect(prisma.cartItem.updateMany).not.toHaveBeenCalled();
    expect(prisma.cartItem.deleteMany).not.toHaveBeenCalled();
    expect(prisma.cart.deleteMany).not.toHaveBeenCalled();
  });

  describe('护栏不变', () => {
    it('不可售 SKU 丢弃，账号车里的陈旧条目一并清掉', async () => {
      const { prisma, tx } = fakePrisma({
        // sku-OLD：账号车里原本就有、现已不可售
        accountItems: [
          { id: 'ai-1', skuId: 'sku-A', quantity: 2 },
          { id: 'ai-old', skuId: 'sku-OLD', quantity: 1 },
        ],
        // sku-BAD：游客车里已不可售 → 丢弃
        guestItems: [
          { id: 'gi-1', skuId: 'sku-A', quantity: 5 },
          { id: 'gi-bad', skuId: 'sku-BAD', quantity: 3 },
        ],
        sellableSkuIds: ['sku-A'],
      });
      const service = makeService(prisma);

      await service.merge(TENANT, CUSTOMER, 'guest-token');

      // 不可售的 sku-BAD 不产生任何新建
      expect(tx.cartItem.createMany).not.toHaveBeenCalled();
      // sku-A 取 max 更新
      expect(tx.cartItem.updateMany).toHaveBeenCalledTimes(1);
      // 账号车里已不可售的 sku-OLD 在事务内被清掉
      expect(tx.cartItem.deleteMany).toHaveBeenCalledTimes(1);
      expect(argsOf(tx.cartItem.deleteMany).where).toEqual({
        id: { in: ['ai-old'] },
        cartId: ACCOUNT_CART_ID,
      });
    });

    it('事务内的可售判定走事务客户端（不借第二条连接）', async () => {
      const { prisma, tx } = fakePrisma({
        accountItems: [{ id: 'ai-1', skuId: 'sku-A', quantity: 2 }],
        guestItems: [{ id: 'gi-1', skuId: 'sku-A', quantity: 5 }],
        sellableSkuIds: ['sku-A'],
      });
      const service = makeService(prisma);

      await service.merge(TENANT, CUSTOMER, 'guest-token');

      // ⚠️ 清理陈旧条目时的可售判定发生在**事务回调内**，
      //    必须走 tx；走 this.prisma 会再借一条连接 → 小连接池上死等（P2024）。
      expect(tx.sku.findMany).toHaveBeenCalledTimes(1);
      // 事务外那次（校验游客条目）仍走 this.prisma —— 那里本来就不在事务里
      expect(prisma.sku.findMany).toHaveBeenCalledTimes(1);
    });

    it('数量超上限的游客条目直接丢弃（不报错）', async () => {
      const { prisma, tx } = fakePrisma({
        accountItems: [],
        // ⚠️ 当前不可达（addItem 已限上限），但这是将来新入口的唯一防线
        guestItems: [{ id: 'gi-1', skuId: 'sku-C', quantity: 100 }],
        sellableSkuIds: ['sku-C'],
      });
      const service = makeService(prisma);

      await service.merge(TENANT, CUSTOMER, 'guest-token');

      // 超上限 → 不搬进来
      expect(tx.cartItem.createMany).not.toHaveBeenCalled();
      expect(tx.cartItem.updateMany).not.toHaveBeenCalled();
      // 但游客车仍然要清掉（合并照常完成）
      expect(tx.cart.deleteMany).toHaveBeenCalledTimes(1);
    });

    it('幂等：无游客车（guestToken 为空）直接返回账号车，不做任何写入', async () => {
      const { prisma, tx } = fakePrisma({
        accountItems: [{ id: 'ai-1', skuId: 'sku-A', quantity: 2 }],
      });
      const service = makeService(prisma);

      const result = await service.merge(TENANT, CUSTOMER, null);

      expect(result.id).toBe(ACCOUNT_CART_ID);
      // ⚠️ 幂等重试不能动账号车，更不能开事务
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(tx.cartItem.createMany).not.toHaveBeenCalled();
      expect(tx.cartItem.updateMany).not.toHaveBeenCalled();
      expect(tx.cart.deleteMany).not.toHaveBeenCalled();
    });
  });
});
