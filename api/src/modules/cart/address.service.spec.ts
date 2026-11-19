import { AddressService } from './address.service';
import { tenantContext } from '../../common/tenant/tenant-context';

/**
 * 地址服务的单测（审计相邻洞：取消默认地址的写入顺序）。
 *
 * ⚠️ **假 Prisma 真的模拟「默认地址唯一」这条部分唯一索引**：
 *    `addresses_tenant_customer_default_uniq (tenantId, customerId)
 *       WHERE isDefault = true AND deletedAt IS NULL`。
 *    同一消费者同时出现两条默认地址 → 抛 P2002。
 *    只有真的模拟了它，才能验出「**先取消自己的默认、再把默认让给别人**」
 *    这个顺序要求 —— 顺序反了就是**必撞**，测试会红。
 */

const TENANT = 'tenant-a';
const CUSTOMER = 'customer-a';

interface Row {
  id: string;
  tenantId: string;
  customerId: string;
  receiver: string;
  phone: string;
  province: string;
  city: string;
  district: string;
  detail: string;
  isDefault: boolean;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** 造一行地址（createdAt 显式给出，排序才稳定） */
function makeRow(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id,
    tenantId: TENANT,
    customerId: CUSTOMER,
    receiver: '张三',
    phone: '13800000000',
    province: '广东省',
    city: '深圳市',
    district: '南山区',
    detail: '科技园 1 号',
    isDefault: false,
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

/**
 * 唯一索引冲突（Prisma 的 P2002）。
 *
 * ⚠️ 必须是 `Error` 实例：仓库的 `isUniqueViolation` 只看 `error.code`，
 *    但 lint 规则 `prefer-promise-reject-errors` 不接受拿普通对象去 reject。
 */
function uniqueViolation(): Error {
  const error = new Error(
    'Unique constraint failed on the fields: (`tenantId`,`customerId`)',
  );
  Object.assign(error, {
    code: 'P2002',
    meta: { target: ['tenantId', 'customerId'] },
  });
  return error;
}

/** 假 Prisma 的查询参数 */
interface QueryArgs {
  where?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

function fakePrisma(rows: Row[]) {
  /**
   * 按 where 选出**未软删**的行。
   *
   * ⚠️ 软删过滤是租户扩展干的（`deletedAt IS NULL`），
   *    这里照抄一份，不然测的就不是真行为。
   */
  function select(where: Record<string, unknown> = {}): Row[] {
    return rows.filter((row) => {
      if (row.deletedAt !== null) {
        return false;
      }
      if (typeof where.id === 'string' && row.id !== where.id) {
        return false;
      }
      if (where.id && typeof where.id === 'object') {
        const not = (where.id as { not?: string }).not;
        if (not !== undefined && row.id === not) {
          return false;
        }
      }
      if (
        typeof where.customerId === 'string' &&
        row.customerId !== where.customerId
      ) {
        return false;
      }
      if (
        typeof where.isDefault === 'boolean' &&
        row.isDefault !== where.isDefault
      ) {
        return false;
      }
      return true;
    });
  }

  const address = {
    // ⚠️ 返回**副本**：Prisma 每次查询都返回新对象，
    //    服务层不该能通过旧对象看到后续写入。
    findFirst: jest.fn((args?: QueryArgs) => {
      const found = select(args?.where).sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
      )[0];
      return Promise.resolve(found ? { ...found } : null);
    }),
    findMany: jest.fn((args?: QueryArgs) =>
      Promise.resolve(select(args?.where).map((row) => ({ ...row }))),
    ),
    create: jest.fn((args?: QueryArgs) => {
      const data = (args?.data ?? {}) as Partial<Row>;
      if (data.isDefault === true) {
        const others = rows.filter(
          (row) => row.deletedAt === null && row.isDefault,
        );
        if (others.length > 0) {
          return Promise.reject(uniqueViolation());
        }
      }
      const row = makeRow(`addr-${rows.length + 1}`, {
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      rows.push(row);
      return Promise.resolve({ ...row });
    }),
    updateMany: jest.fn((args?: QueryArgs) => {
      const matched = select(args?.where);
      const data = (args?.data ?? {}) as Partial<Row>;
      // ⚠️ **唯一索引检查**：把某条设成默认时，
      //    同一个消费者名下不能已经有别的默认地址。
      if (data.isDefault === true) {
        const others = rows.filter(
          (row) =>
            row.deletedAt === null &&
            row.isDefault &&
            !matched.some((m) => m.id === row.id),
        );
        if (others.length > 0) {
          return Promise.reject(uniqueViolation());
        }
      }
      for (const row of matched) {
        Object.assign(row, data);
      }
      return Promise.resolve({ count: matched.length });
    }),
  };

  const prisma = {
    address,
    user: {
      findFirst: jest.fn(() => Promise.resolve(null)),
    },
  };

  return { prisma, rows };
}

function makeService(prisma: ReturnType<typeof fakePrisma>['prisma']) {
  return new AddressService(prisma as unknown as never);
}

/** 在租户上下文里跑一段（`create` 要取 tenantId） */
function withTenant<T>(fn: () => Promise<T>): Promise<T> {
  return tenantContext.run(
    { tenantId: TENANT, userId: null, role: null },
    async () => fn(),
  );
}

describe('AddressService', () => {
  describe('update：取消默认地址', () => {
    it('先取消自己的默认，再把默认让给剩下的某一条（顺序反了会撞唯一索引）', async () => {
      // addr-1 是默认地址，addr-2 / addr-3 是普通地址（addr-2 更早创建）
      const { prisma, rows } = fakePrisma([
        makeRow('addr-1', {
          isDefault: true,
          createdAt: new Date('2026-01-03'),
        }),
        makeRow('addr-2', { createdAt: new Date('2026-01-02') }),
        makeRow('addr-3', { createdAt: new Date('2026-01-01') }),
      ]);
      const service = makeService(prisma);

      // ⚠️ 旧实现（先提升别人、后取消自己）在这里会抛 P2002 → 500
      await service.update(CUSTOMER, 'addr-1', { isDefault: false });

      const addr1 = rows.find((r) => r.id === 'addr-1');
      const addr2 = rows.find((r) => r.id === 'addr-2');
      const addr3 = rows.find((r) => r.id === 'addr-3');
      expect(addr1?.isDefault).toBe(false);
      // 默认让给「剩下的最早创建的那条」（addr-3 比 addr-2 更早）
      expect(addr3?.isDefault).toBe(true);
      expect(addr2?.isDefault).toBe(false);
      // 任何时刻都只有一条默认
      expect(
        rows.filter((r) => r.isDefault && r.deletedAt === null),
      ).toHaveLength(1);
    });

    it('剩下没有别的地址时允许「没有默认」（下单时可指定地址）', async () => {
      const { prisma, rows } = fakePrisma([
        makeRow('addr-1', { isDefault: true }),
      ]);
      const service = makeService(prisma);

      await service.update(CUSTOMER, 'addr-1', { isDefault: false });

      expect(rows[0]?.isDefault).toBe(false);
      expect(rows.filter((r) => r.isDefault)).toHaveLength(0);
    });
  });

  describe('update：设为默认地址', () => {
    it('先清掉旧默认再设新的，不撞唯一索引', async () => {
      const { prisma, rows } = fakePrisma([
        makeRow('addr-1', { isDefault: true }),
        makeRow('addr-2'),
      ]);
      const service = makeService(prisma);

      await service.update(CUSTOMER, 'addr-2', { isDefault: true });

      expect(rows[0]?.isDefault).toBe(false);
      expect(rows[1]?.isDefault).toBe(true);
      expect(rows.filter((r) => r.isDefault)).toHaveLength(1);
    });
  });

  describe('remove：删除默认地址', () => {
    it('软删后把默认让给剩下的最早一条', async () => {
      const { prisma, rows } = fakePrisma([
        makeRow('addr-1', {
          isDefault: true,
          createdAt: new Date('2026-01-03'),
        }),
        makeRow('addr-2', { createdAt: new Date('2026-01-02') }),
      ]);
      const service = makeService(prisma);

      await service.remove(CUSTOMER, 'addr-1');

      expect(rows[0]?.deletedAt).not.toBeNull();
      expect(rows[0]?.isDefault).toBe(false);
      expect(rows[1]?.isDefault).toBe(true);
    });
  });

  describe('create：新建默认地址', () => {
    it('先清掉旧默认再建新的', async () => {
      const { prisma, rows } = fakePrisma([
        makeRow('addr-1', { isDefault: true }),
      ]);
      const service = makeService(prisma);

      await withTenant(() =>
        service.create(CUSTOMER, {
          receiver: '李四',
          phone: '13900000000',
          province: '浙江省',
          city: '杭州市',
          district: '西湖区',
          detail: '文一西路 100 号',
          isDefault: true,
        }),
      );

      expect(rows[0]?.isDefault).toBe(false);
      expect(rows[1]?.isDefault).toBe(true);
      expect(rows.filter((r) => r.isDefault)).toHaveLength(1);
    });
  });
});
