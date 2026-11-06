import { BadRequestException } from '@nestjs/common';

import { tenantContext } from '../../../common/tenant/tenant-context';
import { MinPriceService } from '../pricing/min-price.service';
import { QuotaService } from '../../billing/quota.service';
import { ProductsService } from './products.service';

/**
 * setMedia 批量化的服务层单测（阶段 7b · Task 2）。
 *
 * ⚠️ **假 Prisma 只实现 setMedia 用到的方法**，事务体是「直接以 tx 为回调参数
 *    跑一遍」——它不按 `where` 过滤，查询结果由 `options` 配好。
 *    批量行为靠**断言 createMany / updateMany 的调用参数**来验。
 */

/** 一只最小可用的假 Prisma（只实现 setMedia 用到的方法） */
function fakePrisma(options: {
  /** 商品存在与否 */
  product?: { id: string } | null;
  /** 校验归属用的 media 全集 */
  media?: Array<{ id: string; status: string }>;
  /** 事务里查到的已存在 ProductMedia 行 */
  existingProductMedia?: Array<{ mediaId: string }>;
}) {
  const createMany = jest.fn().mockResolvedValue({ count: 0 });
  const updateMany = jest.fn().mockResolvedValue({ count: 0 });
  const tx = {
    productMedia: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue(options.existingProductMedia ?? []),
      createMany,
      updateMany,
    },
  };
  const prisma = {
    product: {
      findFirst: jest.fn().mockResolvedValue(options.product ?? { id: 'p1' }),
    },
    media: {
      findMany: jest.fn().mockResolvedValue(options.media ?? []),
    },
    $transaction: jest.fn(async (cb: (t: unknown) => Promise<unknown>) =>
      cb(tx),
    ),
  };
  return { prisma, tx, createMany, updateMany };
}

function makeService(prisma: unknown): ProductsService {
  return new ProductsService(
    prisma as never,
    {} as MinPriceService,
    {} as QuotaService,
  );
}

/** 在租户上下文里执行（setMedia 靠 AsyncLocalStorage 取 tenantId） */
function runForTenant<T>(fn: () => Promise<T>): Promise<T> {
  return tenantContext.run({ tenantId: 't1', userId: null, role: null }, fn);
}

describe('ProductsService.setMedia（批量化）', () => {
  it('已存在的 mediaId 不再出现在 createMany 的 data 里', async () => {
    const { prisma, createMany } = fakePrisma({
      media: [
        { id: 'a', status: 'READY' },
        { id: 'b', status: 'READY' },
      ],
      existingProductMedia: [{ mediaId: 'a' }],
    });
    const service = makeService(prisma);

    await runForTenant(() => service.setMedia('p1', ['a', 'b']));

    expect(createMany).toHaveBeenCalledTimes(1);
    expect(createMany).toHaveBeenCalledWith({
      data: [{ tenantId: 't1', productId: 'p1', mediaId: 'b' }],
    });
  });

  it('sort 重排：传入 [b, a] 时 updateMany 使 b→0、a→1', async () => {
    const { prisma, updateMany } = fakePrisma({
      media: [
        { id: 'a', status: 'READY' },
        { id: 'b', status: 'READY' },
      ],
    });
    const service = makeService(prisma);

    await runForTenant(() => service.setMedia('p1', ['b', 'a']));

    expect(updateMany.mock.calls).toEqual([
      [{ where: { productId: 'p1', mediaId: 'b' }, data: { sort: 0 } }],
      [{ where: { productId: 'p1', mediaId: 'a' }, data: { sort: 1 } }],
    ]);
  });

  it('媒体不存在时抛 BadRequestException 且文案含「媒体不存在或不可用」', async () => {
    const { prisma, createMany, updateMany } = fakePrisma({
      media: [{ id: 'a', status: 'READY' }],
    });
    const service = makeService(prisma);

    await expect(
      runForTenant(() => service.setMedia('p1', ['a', 'ghost'])),
    ).rejects.toThrow(new BadRequestException('媒体不存在或不可用：ghost'));
    // 校验失败发生在事务之前：不应有任何写操作
    expect(createMany).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });
});

/**
 * 批量改价（P1-2）：SET 模式必须把负值夹到 0。
 *
 * DTO 注释写「SET 模式非负由 service 层夹」——但实现曾直接用 `value`，
 * 负价会写进库（Sku.price 无 check 约束），minPrice 变负后公开列表的
 * 价格筛选与排序全乱。PERCENT 侧由 applyPercent 内部夹 0，这里补 SET 侧。
 */
describe('ProductsService.batch · ADJUST_PRICE', () => {
  function fakeBatchPrisma(skus: Array<{ id: string; price: number }>) {
    const skuUpdateMany = jest.fn().mockResolvedValue({ count: skus.length });
    const tx = {
      product: { findMany: jest.fn().mockResolvedValue([{ id: 'p1' }]) },
      productUpdateMany: jest.fn(),
      sku: {
        findMany: jest.fn().mockResolvedValue(skus),
        updateMany: skuUpdateMany,
      },
    };
    const prisma = {
      $transaction: jest.fn(async (cb: (t: unknown) => Promise<unknown>) =>
        cb(tx),
      ),
    };
    const minPrice = { recalculate: jest.fn().mockResolvedValue(undefined) };
    return { prisma, tx, skuUpdateMany, minPrice };
  }

  function makeBatchService(
    prisma: unknown,
    minPrice: { recalculate: jest.Mock },
  ): ProductsService {
    return new ProductsService(prisma as never, minPrice, {} as QuotaService);
  }

  it('SET 模式传负值时夹到 0 落库，而不是写进负价', async () => {
    const { prisma, skuUpdateMany, minPrice } = fakeBatchPrisma([
      { id: 's1', price: 100 },
    ]);
    const service = makeBatchService(prisma, minPrice);

    await runForTenant(() =>
      service.batch({
        ids: ['p1'],
        action: 'ADJUST_PRICE',
        mode: 'SET',
        value: -5,
      }),
    );

    expect(skuUpdateMany).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { price: 0 },
    });
    expect(minPrice.recalculate).toHaveBeenCalled();
  });

  it('SET 模式合法正值原样落库（夹零不影响正常路径）', async () => {
    const { prisma, skuUpdateMany, minPrice } = fakeBatchPrisma([
      { id: 's1', price: 100 },
    ]);
    const service = makeBatchService(prisma, minPrice);

    await runForTenant(() =>
      service.batch({
        ids: ['p1'],
        action: 'ADJUST_PRICE',
        mode: 'SET',
        value: 2500,
      }),
    );

    expect(skuUpdateMany).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { price: 2500 },
    });
    expect(minPrice.recalculate).toHaveBeenCalled();
  });
});
