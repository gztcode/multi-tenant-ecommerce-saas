import { ConflictException } from '@nestjs/common';

import { tenantContext } from '../../common/tenant/tenant-context';
import { CouponService } from './coupon.service';

/**
 * 券服务的**分支级**单元测试（7b Task 3）。
 *
 * ⚠️ **假 Prisma 是「配置驱动」的**（与 payout.service.spec.ts 同款）：
 * 这里只测 `listCoupons` 的分页参数与 `claim` 的 P2002 重试收窄，
 * 租户隔离等真实数据库行为放到 e2e 验。
 */

/** 造一个带 `meta.target` 的 P2002（唯一约束冲突） */
function uniqueViolation(target: unknown): Error & { code: string; meta: Record<string, unknown> } {
  return Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
    meta: { target },
  });
}

/** 一张券的最小形状（单测里只用 id，其余字段不参与断言） */
function coupon(id: string) {
  return { id };
}

/** 构造被测服务：prisma 用配置驱动的假对象，quota 在这些路径上不会被碰到 */
function buildService(prisma: Record<string, unknown>): CouponService {
  return new CouponService(
    prisma as never,
    {} as never,
  );
}

describe('CouponService.listCoupons（分页）', () => {
  it('page=2 / pageSize=10 → skip=10 / take=10，返回 { items, total }', async () => {
    const rows = [coupon('c1'), coupon('c2')];
    const findMany = jest.fn().mockResolvedValue(rows);
    const count = jest.fn().mockResolvedValue(22);
    const service = buildService({
      coupon: { findMany, count },
    });

    const result = await tenantContext.run(
      { tenantId: 'tenant-a', userId: 'user-a', role: null },
      async () => service.listCoupons({ page: 2, pageSize: 10 }),
    );

    expect(result).toEqual({ items: rows, total: 22 });
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0]).toMatchObject({
      where: { tenantId: 'tenant-a' },
      orderBy: { createdAt: 'desc' },
      skip: 10,
      take: 10,
    });
    expect(count).toHaveBeenCalledWith({ where: { tenantId: 'tenant-a' } });
  });

  it('不传参数 → 落回第 1 页、默认每页条数（20），不放大查询', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const count = jest.fn().mockResolvedValue(0);
    const service = buildService({
      coupon: { findMany, count },
    });

    await tenantContext.run(
      { tenantId: 'tenant-a', userId: null, role: null },
      async () => service.listCoupons(),
    );

    expect(findMany.mock.calls[0][0]).toMatchObject({ skip: 0, take: 20 });
  });
});

describe('CouponService.claim（P2002 收窄）', () => {
  function setup(): {
    service: CouponService;
    claimInTx: jest.SpyInstance;
  } {
    const service = buildService({
      // claim 本体只在事务回调里干活，而 claimInTx 在下面被 mock 掉，
      // $transaction 只需要把假 tx 透传给回调。
      $transaction: async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({ marker: 'fake-tx' }),
      coupon: {},
    });
    const claimInTx = jest.spyOn(
      service as unknown as {
        claimInTx: (...args: unknown[]) => Promise<unknown>;
      },
      'claimInTx',
    );
    return { service, claimInTx };
  }

  it('撞 coupon_claims_coupon_customer_uniq 的 P2002 → 第一次失败、第二次成功（重试生效）', async () => {
    const { service, claimInTx } = setup();
    claimInTx
      .mockRejectedValueOnce(
        uniqueViolation(['couponId', 'customerId', 'coupon_claims_coupon_customer_uniq']),
      )
      .mockResolvedValueOnce({ couponId: 'c1', quantity: 1 });

    const result = await tenantContext.run(
      { tenantId: 'tenant-a', userId: 'user-a', role: null },
      async () => service.claim({ couponId: 'c1' }, 'customer-a'),
    );

    expect(result).toEqual({ couponId: 'c1', quantity: 1 });
    expect(claimInTx).toHaveBeenCalledTimes(2);
  });

  it('meta.target 是字符串且含约束名 → 同样重试', async () => {
    const { service, claimInTx } = setup();
    claimInTx
      .mockRejectedValueOnce(
        uniqueViolation('coupon_claims_coupon_customer_uniq'),
      )
      .mockResolvedValueOnce({ couponId: 'c1', quantity: 1 });

    await expect(
      tenantContext.run(
        { tenantId: 'tenant-a', userId: 'user-a', role: null },
        async () => service.claim({ couponId: 'c1' }, 'customer-a'),
      ),
    ).resolves.toEqual({ couponId: 'c1', quantity: 1 });
    expect(claimInTx).toHaveBeenCalledTimes(2);
  });

  it('撞其他唯一约束的 P2002 → 不重试，异常原样抛出', async () => {
    const { service, claimInTx } = setup();
    const foreign = uniqueViolation(['code', 'coupons_code_key']);
    claimInTx.mockRejectedValue(foreign);

    await expect(
      tenantContext.run(
        { tenantId: 'tenant-a', userId: 'user-a', role: null },
        async () => service.claim({ couponId: 'c1' }, 'customer-a'),
      ),
    ).rejects.toBe(foreign);
    expect(claimInTx).toHaveBeenCalledTimes(1);
  });

  it('meta.target 缺失的 P2002 → 不重试（宁可失败也不盲吞）', async () => {
    const { service, claimInTx } = setup();
    const bare = uniqueViolation(undefined);
    claimInTx.mockRejectedValue(bare);

    await expect(
      tenantContext.run(
        { tenantId: 'tenant-a', userId: 'user-a', role: null },
        async () => service.claim({ couponId: 'c1' }, 'customer-a'),
      ),
    ).rejects.toBe(bare);
    expect(claimInTx).toHaveBeenCalledTimes(1);
  });

  it('重试次数耗尽 → 409 ConflictException', async () => {
    const { service, claimInTx } = setup();
    claimInTx.mockRejectedValue(
      uniqueViolation('coupon_claims_coupon_customer_uniq'),
    );

    await expect(
      tenantContext.run(
        { tenantId: 'tenant-a', userId: 'user-a', role: null },
        async () => service.claim({ couponId: 'c1' }, 'customer-a'),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(claimInTx).toHaveBeenCalledTimes(3);
  });
});
