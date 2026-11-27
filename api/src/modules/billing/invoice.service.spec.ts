import { ConflictException, NotFoundException } from '@nestjs/common';
import { InvoiceStatus, PaymentStatus } from '@prisma/client';

import type { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { InvoiceService } from './invoice.service';

/**
 * 发票作废的单元测试。
 *
 * ⚠️ **这里钉的是「怎么判」**：哪些状态能作废、哪些一律拒绝、
 * 重复作废要报冲突而不是静默成功、跨租户查不到就是 404。
 * 条件更新的并发胜负要靠 e2e（真事务），单测只能钉住 where 条件本身。
 */
describe('InvoiceService 发票作废', () => {
  const NOW = new Date('2026-11-27T10:00:00.000Z');

  interface FakeInvoice {
    id: string;
    tenantId: string;
    number: string;
    status: InvoiceStatus;
    voidedBy?: string | null;
    voidedAt?: Date | null;
    voidReason?: string | null;
  }

  interface FakeOptions {
    /** null = 查不到（不存在或跨租户） */
    invoice?: FakeInvoice | null;
    /** 有没有 SUCCESS 支付单 */
    settledPayment?: boolean;
    /** 条件更新命中几行 */
    updatedCount?: number;
    /** updateMany 之后重新查出来的行 */
    updated?: FakeInvoice | null;
  }

  function fakeClient(options: FakeOptions = {}) {
    const invoice = options.invoice ?? {
      id: 'inv-1',
      tenantId: 'tenant-1',
      number: 'INV20261127000000001',
      status: InvoiceStatus.OPEN,
    };
    // ⚠️ `findFirst` 被调用两次（作废前读、作废后回读），用调用次数区分。
    const findFirst = jest
      .fn()
      .mockResolvedValueOnce(
        options.invoice === undefined ? invoice : options.invoice,
      )
      .mockResolvedValueOnce(
        options.updated === undefined
          ? {
              ...invoice,
              status: InvoiceStatus.VOID,
              voidedBy: 'user-1',
              voidedAt: NOW,
            }
          : options.updated,
      );
    const updateMany = jest.fn((args: { data: Record<string, unknown> }) => {
      void args;
      return Promise.resolve({ count: options.updatedCount ?? 1 });
    });
    const paymentFindFirst = jest.fn(
      (args: { where: Record<string, unknown> }) => {
        void args;
        return Promise.resolve(options.settledPayment ? { id: 'pay-1' } : null);
      },
    );
    const userFindMany = jest.fn(() =>
      Promise.resolve([{ id: 'user-1', displayName: '张店主' }]),
    );

    const raw = {
      invoice: { findFirst, updateMany },
      payment: { findFirst: paymentFindFirst },
      user: { findMany: userFindMany },
      databaseNow: jest.fn(() => Promise.resolve(NOW)),
    };

    return {
      client: raw as unknown as TenantPrismaService,
      findFirst,
      updateMany,
      paymentFindFirst,
      userFindMany,
    };
  }

  const baseInput = {
    tenantId: 'tenant-1',
    number: 'INV20261127000000001',
    voidedBy: 'user-1',
  };

  it('OPEN 账单可以作废：写状态、时刻、作废人，并回读作废人显示名', async () => {
    const { client, updateMany, findFirst } = fakeClient();
    const service = new InvoiceService(client);

    const result = await service.voidInvoice({
      ...baseInput,
      reason: '  换套餐  ',
    });

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'inv-1',
        status: { in: [InvoiceStatus.OPEN, InvoiceStatus.FAILED] },
      },
      data: {
        status: InvoiceStatus.VOID,
        voidedAt: NOW,
        voidedBy: 'user-1',
        // ⚠️ 前后空白要去掉，免得列表里显示成一串空格
        voidReason: '换套餐',
      },
    });
    // 租户作用域：按 (tenantId, number) 查，跨租户的号在本租户下查不到
    expect(findFirst).toHaveBeenNthCalledWith(1, {
      where: { tenantId: 'tenant-1', number: 'INV20261127000000001' },
    });
    expect(result.status).toBe(InvoiceStatus.VOID);
    expect(result.voidedByName).toBe('张店主');
  });

  it('FAILED 账单也可以作废（上一次支付失败，钱没到账）', async () => {
    const { client, updateMany } = fakeClient({
      invoice: {
        id: 'inv-1',
        tenantId: 'tenant-1',
        number: 'INV20261127000000001',
        status: InvoiceStatus.FAILED,
      },
    });
    const service = new InvoiceService(client);

    await expect(service.voidInvoice(baseInput)).resolves.toMatchObject({
      status: InvoiceStatus.VOID,
    });
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it('作废原因只传空白时落 null，不落空字符串', async () => {
    const { client, updateMany } = fakeClient();
    const service = new InvoiceService(client);

    await service.voidInvoice({ ...baseInput, reason: '   ' });

    expect(updateMany.mock.calls[0][0].data.voidReason).toBeNull();
  });

  it.each([
    [InvoiceStatus.PAID, '账单已支付，不能作废'],
    [InvoiceStatus.VOID, '账单已作废，不能重复作废'],
  ])('%s 账单拒绝作废：%s', async (status, message) => {
    const { client, updateMany } = fakeClient({
      invoice: {
        id: 'inv-1',
        tenantId: 'tenant-1',
        number: 'INV20261127000000001',
        status,
      },
    });
    const service = new InvoiceService(client);

    await expect(service.voidInvoice(baseInput)).rejects.toThrow(
      new ConflictException(message),
    );
    // ⚠️ 拒绝必须发生在写库之前：不能先写一半再报错
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('账单状态是 OPEN 但已有 SUCCESS 支付单时拒绝作废（第二层防御）', async () => {
    const { client, updateMany, paymentFindFirst } = fakeClient({
      settledPayment: true,
    });
    const service = new InvoiceService(client);

    await expect(service.voidInvoice(baseInput)).rejects.toThrow(
      '账单存在成功的支付记录，不能作废',
    );
    // ⚠️ **只认 SUCCESS**：PENDING / FAILED 支付单是重试残渣，
    // 拿它们当「已付款」会让 FAILED 账单永远作废不了。
    expect(paymentFindFirst).toHaveBeenCalledWith({
      where: { invoiceId: 'inv-1', status: PaymentStatus.SUCCESS },
      select: { id: true },
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('跨租户作废按「账单不存在」处理：404 而不是 403', async () => {
    const { client, updateMany } = fakeClient({ invoice: null });
    const service = new InvoiceService(client);

    await expect(
      service.voidInvoice({ ...baseInput, tenantId: 'tenant-2' }),
    ).rejects.toThrow(new NotFoundException('账单不存在'));
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('并发作废：条件更新没命中就报冲突，不覆盖前一次的作废人', async () => {
    const { client } = fakeClient({ updatedCount: 0 });
    const service = new InvoiceService(client);

    await expect(service.voidInvoice(baseInput)).rejects.toThrow(
      '账单状态已变化，请刷新后重试',
    );
  });
});

describe('InvoiceService 账单列表筛选', () => {
  function fakeListClient(
    rows: Array<{ id: string; voidedBy: string | null }>,
  ) {
    const findMany = jest.fn(() => Promise.resolve(rows));
    const userFindMany = jest.fn(() =>
      Promise.resolve([{ id: 'user-1', displayName: '张店主' }]),
    );
    const raw = {
      invoice: { findMany },
      user: { findMany: userFindMany },
    };
    return {
      client: raw as unknown as TenantPrismaService,
      findMany,
      userFindMany,
    };
  }

  it('不传状态时维持原行为：只按 tenantId 查，不加状态条件', async () => {
    const { client, findMany } = fakeListClient([]);
    const service = new InvoiceService(client);

    await service.list('tenant-1');

    expect(findMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1' },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  });

  it('传了状态才加条件，且能筛出已作废的账单', async () => {
    const { client, findMany } = fakeListClient([
      { id: 'inv-1', voidedBy: 'user-1' },
    ]);
    const service = new InvoiceService(client);

    const result = await service.list('tenant-1', InvoiceStatus.VOID);

    expect(findMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant-1', status: InvoiceStatus.VOID },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    expect(result.items[0].voidedByName).toBe('张店主');
  });

  it('作废人账号查不到时回落到 id（不能显示空白）', async () => {
    const findMany = jest.fn(() =>
      Promise.resolve([{ id: 'inv-1', voidedBy: 'ghost-user' }]),
    );
    const userFindMany = jest.fn(() => Promise.resolve([]));
    const service = new InvoiceService({
      invoice: { findMany },
      user: { findMany: userFindMany },
    } as unknown as TenantPrismaService);

    const result = await service.list('tenant-1', InvoiceStatus.VOID);

    expect(result.items[0].voidedByName).toBe('ghost-user');
  });

  it('没有作废账单时不去查用户表', async () => {
    const { client, userFindMany } = fakeListClient([
      { id: 'inv-1', voidedBy: null },
    ]);
    const service = new InvoiceService(client);

    const result = await service.list('tenant-1');

    expect(userFindMany).not.toHaveBeenCalled();
    expect(result.items[0].voidedByName).toBeNull();
  });
});
