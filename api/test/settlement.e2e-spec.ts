import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import {
  CommissionEntryType,
  OrderStatus,
  PayoutStatus,
  SettlementStatus,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import {
  platformScope,
  tenantContext,
} from '../src/common/tenant/tenant-context';
import { http } from './helpers';
import { createMerchant, unique } from './merchant-fixture';

/**
 * 平台侧的结算单（阶段 5g）。
 *
 * 覆盖的护栏（编号见设计文档 §六·6.1）：S1–S12。
 *
 * ⚠️ **月份一律用 2024 年**：`billing-report.e2e-spec.ts` 的报表用例从
 * 2020-01-01 起每 60 天发一块区间、共 13 块 —— **最后一块是
 * 2021-12-21 → 2022-01-20**，已经吃进了 2022 年 1 月。
 *
 *    ⚠️ **计划里写的「用 2022 年」是不够的**：实际跑起来时
 *    `billing-report.e2e-spec.ts` 的「按商家的净抽佣」那条用例
 *    （窗口正好是 2021-12-21 → 2022-01-20）会把本文件的 2022-01 流水
 *    一起聚合进去，`byMerchant` 从 1 个商家变成 5 个 → 断言挂。
 *
 *    选 2024 年的理由：那块窗口要推进到 2024 年得 30 多次
 *    `nextWindow()` 调用，离当前的 13 次足够远 —— 报表文件以后加用例
 *    也不会轻易把窗口推到 2024。
 *
 *    ⚠️ **例外：阶段 5h-1 的两条出款引用用例用 2025-06 / 2025-07**。
 *    理由：2024 年 1–12 月已被本文件的其他用例占满，而这两条用例
 *    必须与已有的「取消确认」用例**错开月份**（结算单的幂等键是
 *    `(tenantId, periodStart)`，同一期反复造数据会互相污染）。
 *    2025 年同样在报表窗口之外 —— 那块窗口要推进到 2025 年得
 *    40 多次 `nextWindow()` 调用。
 *
 * ⚠️ **自己造流水行，不跑回填**：`CommissionService.backfill()` 会扫全表
 * `paidAt` 非空的订单补流水，跨文件影响不可控。直接造行也不受用例顺序影响。
 *
 * ⚠️ **每个用例用自己独立的月份**：结算单的幂等键是
 * `(tenantId, periodStart)`，同一个商家在同一期反复造数据会让后一个用例
 * 拿到前一个用例的单据（断言互相污染）。用例之间用不同的商家 + 不同的月份，
 * 两层隔离。
 */

/** 一天的毫秒数 */
const DAY_MS = 24 * 3600 * 1000;

/** 一个自然月的区间（左闭右开） */
interface Period {
  label: string;
  from: Date;
  to: Date;
}

/** 造一个自然月区间 */
function month(label: string): Period {
  const [year, m] = label.split('-').map(Number);
  return {
    label,
    from: new Date(Date.UTC(year, m - 1, 1)),
    to: new Date(Date.UTC(year, m, 1)),
  };
}

/** 区间内的某个时刻（避开边界） */
function inside(period: Period, offsetDays: number): Date {
  return new Date(period.from.getTime() + offsetDays * DAY_MS);
}

/** 结算单的一行（响应体） */
interface StatementBody {
  id: string;
  tenantId: string;
  tenantName: string;
  subdomain: string;
  statementNo: string;
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
  grossAmount: number;
  reversalAmount: number;
  netAmount: number;
  entryCount: number;
  status: string;
  confirmedAt: string | null;
  createdAt: string;
}

/** 列表响应体 */
interface StatementListBody {
  items: StatementBody[];
  total: number;
}

/** 生成接口的响应体 */
interface GenerateBody {
  items: StatementBody[];
  created: number;
  skipped: number;
  /**
   * 批量模式下没能出单的商家（冲突）。
   *
   * ⚠️ **后端总是返回这个字段**（哪怕是空数组）→ 断言时**不能写
   *    `body.conflicts ?? []`**：那样后端漏返字段时 `undefined ?? []` → `[]`
   *    → **断言照样通过**（假通过）。
   */
  conflicts: Array<{ tenantId: string; message: string }>;
  /** 过时（缺笔）的商家 id 列表。同上：后端总是返回，不能 `?? []` 兜底 */
  stale: string[];
}

/** 详情响应体 */
interface DetailBody extends StatementBody {
  entries: Array<{
    entryId: string;
    orderNo: string;
    type: string;
    amount: number;
    rateBps: number;
    baseAmount: number;
    occurredAt: string;
  }>;
}

/** 明细分页响应体（阶段 5l） */
interface EntriesPageBody {
  items: Array<{
    entryId: string;
    orderNo: string;
    type: string;
    amount: number;
    rateBps: number;
    baseAmount: number;
    occurredAt: string;
  }>;
  total: number;
  page: number;
  pageSize: number;
}

/** 报表响应体（对账用） */
interface ReportBody {
  commissionRevenue: number;
  reversal: number;
}

/** 全局异常过滤器的错误体 */
interface ErrorBody {
  code: string;
  message: string;
}

/**
 * 校验失败时的错误消息。
 *
 * ⚠️ **有全局过滤器时是字符串，没挂过滤器时是字符串数组**：
 *    `AllExceptionsFilter` 会把 `ValidationPipe` 聚合出来的数组用「；」拼成一句，
 *    但本文件没有挂那个过滤器 → 拿到的就是 NestJS 默认的 `{ message: string[] }`。
 *    这里两种形态都兼容。
 */
function errorText(body: unknown): string {
  const message = (body as { message?: unknown }).message;
  if (Array.isArray(message)) {
    return message.join('；');
  }
  return typeof message === 'string' ? message : '';
}

describe('平台侧的结算单 (e2e)', () => {
  let app: INestApplication;
  let prisma: TenantPrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalInterceptors(app.get(TenantContextInterceptor));
    await app.init();

    prisma = app.get(TenantPrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  /** 在平台作用域里执行一段逻辑（测试代码在 HTTP 请求之外，没有上下文） */
  function asPlatform<T>(fn: () => Promise<T>): Promise<T> {
    return tenantContext.run(platformScope(), async () => fn());
  }

  /** 平台超管登录（种子里已有这个账号） */
  async function loginPlatformAdmin(): Promise<string> {
    const email =
      process.env.SEED_PLATFORM_ADMIN_EMAIL ?? 'admin@platform.test';
    const password = process.env.SEED_PLATFORM_ADMIN_PASSWORD ?? 'Admin12345!';
    const response = await http(app)
      .post('/api/v1/auth/login')
      .send({ email, password, scope: 'PLATFORM' })
      .expect(200);
    return (response.body as { accessToken: string }).accessToken;
  }

  /**
   * 造一笔订单（**必须先有订单**，流水有指向它的外键 Restrict）。
   */
  async function seedOrder(
    tenantId: string,
    options: {
      status?: OrderStatus;
      totalAmount?: number;
      commissionRate?: number;
      commissionAmount?: number;
      paidAt?: Date | null;
      refundedAt?: Date | null;
    } = {},
  ): Promise<string> {
    const created = await asPlatform(() =>
      prisma.order.create({
        data: {
          tenantId,
          orderNo: `STL-ORD-${unique()}`,
          status: options.status ?? OrderStatus.PAID,
          totalAmount: options.totalAmount ?? 20000,
          itemCount: 1,
          receiverName: '测试收货人',
          receiverPhone: '13800000000',
          province: '广东省',
          city: '深圳市',
          district: '南山区',
          detail: '测试地址',
          commissionRate: options.commissionRate ?? 500,
          commissionAmount: options.commissionAmount ?? 0,
          // ⚠️ **不能用 `??`**：`null ?? x` 返回 `x`，那样「传 null 表示
          //    没付过钱」会被静默忽略。
          paidAt: options.paidAt === undefined ? new Date() : options.paidAt,
          refundedAt:
            options.refundedAt === undefined ? null : options.refundedAt,
        },
      }),
    );
    return created.id;
  }

  /**
   * 造一行抽佣流水。
   *
   * ⚠️ **`occurredAt` 是「业务发生时间」**：抽佣取支付时间、冲回取退款时间 ——
   *    与报表的归期口径逐字一致。
   *
   * ⚠️ **`REVERSAL` 的 `amount` 必须是负数**（护栏 N2）：`summarizeEntries`
   *    有一条「冲回恒 ≤ 0」的不变量断言，符号写反会直接抛错 → 500。
   */
  async function seedEntry(
    tenantId: string,
    orderId: string,
    options: {
      type: CommissionEntryType;
      amount: number;
      occurredAt: Date;
      rateBps?: number;
      baseAmount?: number;
    },
  ): Promise<string> {
    const created = await asPlatform(() =>
      prisma.commissionEntry.create({
        data: {
          tenantId,
          orderId,
          orderNo: `STL-ORD-${unique()}`,
          type: options.type,
          amount: options.amount,
          rateBps: options.rateBps ?? 500,
          baseAmount: options.baseAmount ?? 20000,
          occurredAt: options.occurredAt,
        },
      }),
    );
    return created.id;
  }

  /** 生成结算单 */
  async function generate(
    token: string,
    period: string,
    tenantId?: string,
  ): Promise<GenerateBody> {
    const response = await http(app)
      .post('/api/v1/platform/settlements')
      .set('authorization', `Bearer ${token}`)
      .send(tenantId ? { period, tenantId } : { period })
      .expect(200);
    return response.body as GenerateBody;
  }

  /** 拉列表 */
  async function fetchList(
    token: string,
    query: Record<string, string> = {},
  ): Promise<StatementListBody> {
    const params = new URLSearchParams(query);
    const suffix = params.toString();
    const response = await http(app)
      .get(`/api/v1/platform/settlements${suffix ? `?${suffix}` : ''}`)
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    return response.body as StatementListBody;
  }

  /** 拉详情 */
  async function fetchDetail(token: string, id: string): Promise<DetailBody> {
    const response = await http(app)
      .get(`/api/v1/platform/settlements/${id}`)
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    return response.body as DetailBody;
  }

  /**
   * 拉某个月的收入报表（**区间显式传入**，不依赖后端的缺省窗口）。
   *
   * ⚠️ **报表是平台维度的聚合**：别的商家在同一个月的数据也在里面 →
   *    对账时必须先取「基线」再取「造数之后」，**比差值**而不是比绝对值。
   */
  async function fetchReport(
    token: string,
    period: Period,
  ): Promise<ReportBody> {
    const response = await http(app)
      .get(
        `/api/v1/platform/reports?from=${period.from.toISOString()}&to=${period.to.toISOString()}`,
      )
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    return response.body as ReportBody;
  }

  // ============================================================
  // S1：只纳入该商家该自然月的流水
  // ============================================================

  it('S1：生成只纳入该商家该自然月的流水（上月、下月、别家都不进）', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const other = await createMerchant(app, prisma);
    const period = month('2024-01');
    const previous = month('2023-12');
    const next = month('2024-02');

    const ownOrderId = await seedOrder(merchant.tenantId);
    await seedEntry(merchant.tenantId, ownOrderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 10),
    });

    // 上月的流水 → 不该进 1 月的单
    const prevOrderId = await seedOrder(merchant.tenantId);
    await seedEntry(merchant.tenantId, prevOrderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 700,
      occurredAt: inside(previous, 10),
    });

    // 下月的流水 → 不该进 1 月的单
    const nextOrderId = await seedOrder(merchant.tenantId);
    await seedEntry(merchant.tenantId, nextOrderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 900,
      occurredAt: inside(next, 10),
    });

    // 别的商家的流水 → 不该进这家的单
    const otherOrderId = await seedOrder(other.tenantId);
    await seedEntry(other.tenantId, otherOrderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 800,
      occurredAt: inside(period, 12),
    });

    const body = await generate(adminToken, '2024-01', merchant.tenantId);

    expect(body.created).toBe(1);
    expect(body.items).toHaveLength(1);
    const statement = body.items[0];
    expect(statement.grossAmount).toBe(100);
    expect(statement.entryCount).toBe(1);
    expect(statement.tenantId).toBe(merchant.tenantId);
  });

  it('⚠️ 恰好落在周期边界那一瞬的流水 → 只被一期结算（不被相邻两期重复计）', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const period = month('2025-05');

    const orderA = await seedOrder(merchant.tenantId);
    await seedEntry(merchant.tenantId, orderA, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 10),
    });

    // ⚠️ **恰好落在「下期起点」= 本期终点那一瞬**（次月 1 日 00:00:00.000Z）。
    //    左闭右开 `[from, to)` 下它属于**下一期**；
    //    若区间写成右闭（`lte: to`），它会被**相邻两期各算一次** → 重复计账。
    //    （这条是失败注入 F2 发现的缺口：改右闭后 34 条测试**全绿**。）
    const orderB = await seedOrder(merchant.tenantId);
    await seedEntry(merchant.tenantId, orderB, {
      type: CommissionEntryType.COMMISSION,
      amount: 700,
      occurredAt: period.to,
    });

    const cur = await generate(adminToken, '2025-05', merchant.tenantId);
    expect(cur.items[0].entryCount).toBe(1);
    expect(cur.items[0].netAmount).toBe(100);

    const nxt = await generate(adminToken, '2025-06', merchant.tenantId);
    expect(nxt.items[0].entryCount).toBe(1);
    expect(nxt.items[0].netAmount).toBe(700);
  });

  // ============================================================
  // S2：三个金额由后端算
  // ============================================================

  it('S2：毛额 / 冲回 / 净额由后端算，且与逐笔之和一致', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const period = month('2024-02');

    const orderA = await seedOrder(merchant.tenantId);
    await seedEntry(merchant.tenantId, orderA, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 5),
    });
    const orderB = await seedOrder(merchant.tenantId);
    await seedEntry(merchant.tenantId, orderB, {
      type: CommissionEntryType.COMMISSION,
      amount: 200,
      occurredAt: inside(period, 6),
    });
    const orderC = await seedOrder(merchant.tenantId);
    await seedEntry(merchant.tenantId, orderC, {
      type: CommissionEntryType.REVERSAL,
      amount: -30,
      occurredAt: inside(period, 7),
    });

    const body = await generate(adminToken, '2024-02', merchant.tenantId);
    const statement = body.items[0];

    expect(statement.grossAmount).toBe(300);
    expect(statement.reversalAmount).toBe(-30);
    expect(statement.netAmount).toBe(270);
    expect(statement.entryCount).toBe(3);

    // ⚠️ **净额必须等于逐笔之和**：前端/后端都不许自己另算一套
    const detail = await fetchDetail(adminToken, statement.id);
    const sum = detail.entries.reduce((acc, e) => acc + e.amount, 0);
    expect(sum).toBe(statement.netAmount);
  });

  // ============================================================
  // S3：同一商家同一周期只有一张单（幂等）
  // ============================================================

  it('S3：重复生成同一商家同一周期 → 返回同一张单，不产生第二张', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const period = month('2024-03');

    const orderId = await seedOrder(merchant.tenantId);
    await seedEntry(merchant.tenantId, orderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 10),
    });

    const first = await generate(adminToken, '2024-03', merchant.tenantId);
    expect(first.created).toBe(1);
    expect(first.skipped).toBe(0);

    const second = await generate(adminToken, '2024-03', merchant.tenantId);
    // ⚠️ **幂等不是报错**：重复生成返回既有单据
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(1);
    expect(second.items[0].id).toBe(first.items[0].id);
    expect(second.items[0].statementNo).toBe(first.items[0].statementNo);

    // ⚠️ **库里也只有一张**
    const count = await asPlatform(() =>
      prisma.settlementStatement.count({
        where: { tenantId: merchant.tenantId, periodStart: period.from },
      }),
    );
    expect(count).toBe(1);
  });

  // ============================================================
  // S4：一笔流水只能被一期结算
  // ============================================================

  it('S4：一笔流水已被别的单据结算过 → 409（服务层的防线）', async () => {
    // ⚠️ **为什么要手写一张「周期对不上」的脏单据**：
    //    正常路径下这道闸走不到 —— 一笔流水的 `occurredAt` 只落在一个自然月，
    //    而同一商家同一周期只有一张单（`@@unique([tenantId, periodStart])`
    //    + 幂等分支先挡住了）。于是「重复结算」在真实数据里不可能发生。
    //
    //    但**防线必须被证明存在**，否则它只是「碰巧没被触发」。
    //    做法：手写一张**周期与流水错开**的结算单（周期在 2 月、流水在 4 月），
    //    并把流水关联上去 —— 这正是「手工改过 periodEnd」「并发下错配」
    //    这类脏数据会造成的样子。
    //
    //    然后正常调用生成接口（周期 4 月）：
    //    → 幂等分支查 `(tenantId, periodStart=2024-04-01)` 查不到（脏单在 2 月）
    //    → entriesInPeriod 找到那笔流水
    //    → `assertEntriesNotSettled` 发现它已被关联 → 409
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const period = month('2024-04');
    const mismatched = month('2024-02');

    const orderId = await seedOrder(merchant.tenantId);
    const entryId = await seedEntry(merchant.tenantId, orderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 10),
    });

    // ---- 手写一张「周期对不上」的脏结算单，并把流水关联上去 ----
    //
    // ⚠️ **`statementNo` 必须唯一**：它是全局唯一索引，撞了会得到 P2002，
    //    报错原因会被「单号撞了」带偏，看不出真正想验的东西。
    const dirty = await asPlatform(() =>
      prisma.settlementStatement.create({
        data: {
          tenantId: merchant.tenantId,
          statementNo: `STL-DIRTY-${unique()}`,
          // ⚠️ **周期故意与流水的 `occurredAt` 错开**：
          //    流水的 occurredAt 在 2024-04，脏单的周期起点却在 2024-02。
          periodStart: mismatched.from,
          periodEnd: mismatched.to,
          grossAmount: 100,
          reversalAmount: 0,
          netAmount: 100,
          entryCount: 1,
          status: SettlementStatus.DRAFT,
        },
      }),
    );
    await asPlatform(() =>
      prisma.settlementStatementEntry.create({
        data: { statementId: dirty.id, entryId },
      }),
    );

    // ---- 正常调用生成接口 → 必须被挡下 ----
    const response = await http(app)
      .post('/api/v1/platform/settlements')
      .set('authorization', `Bearer ${adminToken}`)
      .send({ period: '2024-04', tenantId: merchant.tenantId })
      .expect(409);

    // ⚠️ **错误消息要能指出是哪一笔流水**（带订单号）——
    //    只有一句「不能重复结算」的话，排查的人得自己去翻表。
    const error = response.body as ErrorBody;
    expect(error.message).toContain('已经被结算过了');

    // ⚠️ **这笔流水仍然只被关联了一次**（409 时不能留下半截数据）
    const links = await asPlatform(() =>
      prisma.settlementStatementEntry.findMany({ where: { entryId } }),
    );
    expect(links).toHaveLength(1);
    expect(links[0].statementId).toBe(dirty.id);
  });

  it('S4：同一笔流水被关联两次 → 数据库唯一约束拒绝（P2002）', async () => {
    // ⚠️ **这是数据层的兜底**：上面的用例验的是**服务层**主动查出来的
    //    409；这一条验的是**唯一约束真的建上了** ——
    //    `SettlementStatementEntry.entryId` 是全局唯一（不是
    //    `(statementId, entryId)` 复合唯一），复合唯一是这条护栏的弱化版，
    //    会放过「同一笔流水被两张单各结一次」。
    const merchant = await createMerchant(app, prisma);
    const period = month('2024-04');

    const orderId = await seedOrder(merchant.tenantId);
    const entryId = await seedEntry(merchant.tenantId, orderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 10),
    });

    const first = await asPlatform(() =>
      prisma.settlementStatement.create({
        data: {
          tenantId: merchant.tenantId,
          statementNo: `STL-UQ-A-${unique()}`,
          periodStart: period.from,
          periodEnd: period.to,
          grossAmount: 100,
          reversalAmount: 0,
          netAmount: 100,
          entryCount: 1,
          status: SettlementStatus.DRAFT,
        },
      }),
    );
    await asPlatform(() =>
      prisma.settlementStatementEntry.create({
        data: { statementId: first.id, entryId },
      }),
    );

    // ---- 再关联一次同一个 entryId → 必须被数据库拒绝 ----
    const second = await asPlatform(() =>
      prisma.settlementStatement.create({
        data: {
          tenantId: merchant.tenantId,
          statementNo: `STL-UQ-B-${unique()}`,
          periodStart: new Date(Date.UTC(2024, 4, 1)),
          periodEnd: new Date(Date.UTC(2024, 5, 1)),
          grossAmount: 100,
          reversalAmount: 0,
          netAmount: 100,
          entryCount: 1,
          status: SettlementStatus.DRAFT,
        },
      }),
    );

    let code: string | undefined;
    try {
      await asPlatform(() =>
        prisma.settlementStatementEntry.create({
          data: { statementId: second.id, entryId },
        }),
      );
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    // ⚠️ **P2002 = 唯一约束冲突**：不是 P2003（外键）、不是 P2003 之类的别的
    expect(code).toBe('P2002');

    // ⚠️ **库里只有一个关联行**：重复的插入没有落库
    const links = await asPlatform(() =>
      prisma.settlementStatementEntry.findMany({ where: { entryId } }),
    );
    expect(links).toHaveLength(1);
  });

  // ============================================================
  // S5：跨期冲回落退款期
  // ============================================================

  it('S5：1 月支付、3 月退款 → 冲回落在 3 月，3 月单净额为负', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const january = month('2024-01');
    const march = month('2024-03');

    const orderId = await seedOrder(merchant.tenantId, {
      status: OrderStatus.REFUNDED,
      commissionAmount: 100,
      paidAt: inside(january, 10),
      refundedAt: inside(march, 5),
    });
    await seedEntry(merchant.tenantId, orderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(january, 10),
    });
    await seedEntry(merchant.tenantId, orderId, {
      type: CommissionEntryType.REVERSAL,
      amount: -100,
      occurredAt: inside(march, 5),
    });

    const jan = await generate(adminToken, '2024-01', merchant.tenantId);
    const mar = await generate(adminToken, '2024-03', merchant.tenantId);

    // ⚠️ **1 月的单不受 3 月的退款影响**（冲回按退款时点归期）
    expect(jan.items[0].netAmount).toBe(100);
    expect(jan.items[0].grossAmount).toBe(100);
    expect(jan.items[0].reversalAmount).toBe(0);

    // ⚠️ **3 月的单净额为负**：那一期平台「倒欠」商家钱
    expect(mar.items[0].grossAmount).toBe(0);
    expect(mar.items[0].reversalAmount).toBe(-100);
    expect(mar.items[0].netAmount).toBe(-100);
  });

  // ============================================================
  // S6：重算只有 DRAFT 能做
  // ============================================================

  it('S6：CONFIRMED 的单据重算 → 409，DRAFT 的能重算', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const period = month('2024-05');

    const orderId = await seedOrder(merchant.tenantId);
    await seedEntry(merchant.tenantId, orderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 10),
    });

    const body = await generate(adminToken, '2024-05', merchant.tenantId);
    const id = body.items[0].id;

    // DRAFT 能重算
    await http(app)
      .post(`/api/v1/platform/settlements/${id}/recalculate`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(201);

    // 确认之后就不能重算了
    await http(app)
      .post(`/api/v1/platform/settlements/${id}/confirm`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(201);

    const conflict = await http(app)
      .post(`/api/v1/platform/settlements/${id}/recalculate`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(409);

    // ⚠️ **错误消息要说清是「状态不对」**：
    //    409 的理由有好几种（状态不对 / 流水被别人结算了 / 当期无流水），
    //    不区分的话「被拒」这个断言锁不住任何东西。
    expect(errorText(conflict.body)).toContain('不能重算');

    // ⚠️ **单据没被改坏**：被拒的重算不能顺手改金额、不能抹明细。
    //    若 `recalculate` 被改成「先写 0 再抛 409」，只断言状态码是测不出来的。
    const after = await fetchDetail(adminToken, id);
    expect(after.netAmount).toBe(100);
    expect(after.grossAmount).toBe(100);
    expect(after.entryCount).toBe(1);
    expect(after.entries).toHaveLength(1);
    expect(after.status).toBe('CONFIRMED');
  });

  // ============================================================
  // S7：确认幂等；确认后冻结
  // ============================================================

  it('S7：确认幂等（重复确认不报错），确认后金额冻结', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const period = month('2024-06');

    const orderId = await seedOrder(merchant.tenantId);
    await seedEntry(merchant.tenantId, orderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 10),
    });

    const body = await generate(adminToken, '2024-06', merchant.tenantId);
    const id = body.items[0].id;

    const first = await http(app)
      .post(`/api/v1/platform/settlements/${id}/confirm`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(201);
    expect((first.body as StatementBody).status).toBe('CONFIRMED');
    expect((first.body as StatementBody).confirmedAt).toBeTruthy();

    // ⚠️ **重复确认 → 幂等，不报错**
    // ⚠️ **先隔开一点时间**：确认时间取自数据库时钟（毫秒精度），
    //    两次调用若落在同一毫秒，「时间没变」会**假通过**。
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await http(app)
      .post(`/api/v1/platform/settlements/${id}/confirm`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(201);
    expect((second.body as StatementBody).status).toBe('CONFIRMED');
    // ⚠️ **确认时间不能被刷新**：`confirm` 的 `where` 带 `status: DRAFT`，
    //    已确认的单再次确认时**影响 0 行** → `confirmedAt` 保持原值。
    //    去掉那个条件 → 重复确认会把确认时间改成现在 → 冻结被破坏。
    //    （这条是失败注入 F6 发现的缺口：去掉 `status` 条件后测试**全绿**。）
    expect((second.body as StatementBody).confirmedAt).toBe(
      (first.body as StatementBody).confirmedAt,
    );

    // ⚠️ **确认后再来一笔流水 → 金额不变**（冻结）
    const orderB = await seedOrder(merchant.tenantId);
    await seedEntry(merchant.tenantId, orderB, {
      type: CommissionEntryType.COMMISSION,
      amount: 500,
      occurredAt: inside(period, 20),
    });

    const after = await fetchDetail(adminToken, id);
    expect(after.netAmount).toBe(100);
    expect(after.entryCount).toBe(1);
    // ⚠️ **冻结的是「明细关联集」，不只是冻结列**：
    //    `netAmount` / `entryCount` 都存在单据表里（冻结列），
    //    只断言它们的话，「确认后把新流水 link 进已确认单据」
    //    （明细集解冻、但不动冻结列）会**全部漏过**。
    //    `entries` 是从关联表 join 出来的 → 必须断言它也没变。
    expect(after.entries).toHaveLength(1);
  });

  // ============================================================
  // S8：鉴权
  // ============================================================

  it('S8：商家账号调平台接口 → 403', async () => {
    const merchant = await createMerchant(app, prisma);

    await http(app)
      .get('/api/v1/platform/settlements')
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(403);

    await http(app)
      .post('/api/v1/platform/settlements')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({ period: '2024-01' })
      .expect(403);
  });

  it('S8：没登录 → 401', async () => {
    await http(app).get('/api/v1/platform/settlements').expect(401);
    await http(app)
      .post('/api/v1/platform/settlements')
      .send({ period: '2024-01' })
      .expect(401);
  });

  // ============================================================
  // S9：对账 —— 结算单净额之和 == 收入报表同期的抽佣净额
  // ============================================================

  it('S9：对账：某期结算单的净额 == 收入报表同期的「抽佣收入 − 冲回」', async () => {
    // ⚠️ **这是本阶段最有价值的护栏**：
    //    结算单从**流水**聚合，收入报表从**订单**聚合 ——
    //    两条独立的路径给出同一个数，才算账对得上。
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const january = month('2024-01');
    const february = month('2024-02');

    // ---- 先取「基线」：造数据**之前**的报表值 ----
    //
    // ⚠️ **基线必须在造数据之前取**：报表是**平台维度**的聚合，
    //    别的 e2e 文件（以及本文件里先跑的用例）也可能在同一个月造数据 →
    //    绝对值会飘。**差值**才是「这个用例自己贡献了多少」。
    const janBefore = await fetchReport(adminToken, january);
    const febBefore = await fetchReport(adminToken, february);

    // ① 已支付未退款 → 1 月抽佣 100
    const orderA = await seedOrder(merchant.tenantId, {
      status: OrderStatus.PAID,
      totalAmount: 20000,
      commissionAmount: 100,
      paidAt: inside(january, 10),
    });
    await seedEntry(merchant.tenantId, orderA, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(january, 10),
    });

    // ② 已支付已退款：1 月支付（抽佣 150）、2 月退款（冲回 -150）
    const orderB = await seedOrder(merchant.tenantId, {
      status: OrderStatus.REFUNDED,
      totalAmount: 30000,
      commissionAmount: 150,
      paidAt: inside(january, 11),
      refundedAt: inside(february, 5),
    });
    await seedEntry(merchant.tenantId, orderB, {
      type: CommissionEntryType.COMMISSION,
      amount: 150,
      occurredAt: inside(january, 11),
    });
    await seedEntry(merchant.tenantId, orderB, {
      type: CommissionEntryType.REVERSAL,
      amount: -150,
      occurredAt: inside(february, 5),
    });

    // ---- 生成两期的结算单 ----
    const jan = await generate(adminToken, '2024-01', merchant.tenantId);
    const feb = await generate(adminToken, '2024-02', merchant.tenantId);

    // ---- 再取一次报表 ----
    const janAfter = await fetchReport(adminToken, january);
    const febAfter = await fetchReport(adminToken, february);

    // ---- 逐期对账 ----
    //
    // ⚠️ **断言的是「差值」，不是绝对值**：
    //    结算单只含**这一家**（生成时显式点名了 tenantId），
    //    报表是**平台维度**的 —— 别的商家在同月的抽佣也在里面。
    //    所以两边都要先减掉基线，才是同一笔账。
    const janReportDelta =
      janAfter.commissionRevenue -
      janBefore.commissionRevenue -
      (janAfter.reversal - janBefore.reversal);
    const febReportDelta =
      febAfter.commissionRevenue -
      febBefore.commissionRevenue -
      (febAfter.reversal - febBefore.reversal);

    // ⚠️ **1 月**：本用例贡献了抽佣 250（100 + 150），冲回 0（退款在 2 月）
    expect(janReportDelta).toBe(250);
    expect(jan.items[0].netAmount).toBe(janReportDelta);
    expect(jan.items[0].netAmount).toBe(250);

    // ⚠️ **2 月**：本用例贡献了抽佣 0（没有 2 月支付的订单），冲回 150
    expect(febReportDelta).toBe(-150);
    expect(feb.items[0].netAmount).toBe(febReportDelta);
    expect(feb.items[0].netAmount).toBe(-150);

    // ⚠️ **两期合起来是 100**，不是 0：
    //    ② 那笔单（1 月支付 150、2 月退款 150）跨两期合起来是 0 ——
    //    但 ① 那笔单**从没退款**，它对平台的净贡献就是 100。
    //    写成 0 会把「退款冲回把抽佣抵回去了」与「这笔抽佣本来就是赚的」
    //    两件事混为一谈。
    expect(jan.items[0].netAmount + feb.items[0].netAmount).toBe(100);
  });

  // ============================================================
  // S10：零额与负额
  // ============================================================

  it('S10：净额为 0 的单据正常生成；净额为负的单据也是负数（不是 0）', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const period = month('2024-07');

    // 一抽佣一冲回，金额相等 → 净额 0
    const orderA = await seedOrder(merchant.tenantId);
    await seedEntry(merchant.tenantId, orderA, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 5),
    });
    await seedEntry(merchant.tenantId, orderA, {
      type: CommissionEntryType.REVERSAL,
      amount: -100,
      occurredAt: inside(period, 6),
    });

    // 只有冲回 → 净额为负
    const orderB = await seedOrder(merchant.tenantId);
    await seedEntry(merchant.tenantId, orderB, {
      type: CommissionEntryType.REVERSAL,
      amount: -30,
      occurredAt: inside(period, 7),
    });

    const body = await generate(adminToken, '2024-07', merchant.tenantId);
    const statement = body.items[0];

    expect(statement.grossAmount).toBe(100);
    expect(statement.reversalAmount).toBe(-130);
    expect(statement.netAmount).toBe(-30);
    expect(statement.entryCount).toBe(3);
  });

  it('S10：净额为 0 的单据也能正常生成（不是被当成「没流水」）', async () => {
    // ⚠️ **「净额为 0」与「没有流水」是两回事**：
    //    前者有明细（该结的账结完了），后者没有。
    //    若服务端用「净额 != 0」判「有没有流水」，这张单会被漏掉。
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const period = month('2024-07');

    const orderId = await seedOrder(merchant.tenantId);
    await seedEntry(merchant.tenantId, orderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 5),
    });
    await seedEntry(merchant.tenantId, orderId, {
      type: CommissionEntryType.REVERSAL,
      amount: -100,
      occurredAt: inside(period, 6),
    });

    const body = await generate(adminToken, '2024-07', merchant.tenantId);
    expect(body.created).toBe(1);
    expect(body.items[0].netAmount).toBe(0);
    expect(body.items[0].grossAmount).toBe(100);
    expect(body.items[0].reversalAmount).toBe(-100);
    expect(body.items[0].entryCount).toBe(2);
  });

  // ============================================================
  // S11：周期未结束不能生成
  // ============================================================

  it('S11：周期尚未结束 → 400', async () => {
    const adminToken = await loginPlatformAdmin();

    // ⚠️ **用一个肯定还没结束的月份**：2999 年
    await http(app)
      .post('/api/v1/platform/settlements')
      .set('authorization', `Bearer ${adminToken}`)
      .send({ period: '2999-01' })
      .expect(400);
  });

  it('S11：周期格式非法 → 400', async () => {
    const adminToken = await loginPlatformAdmin();

    await http(app)
      .post('/api/v1/platform/settlements')
      .set('authorization', `Bearer ${adminToken}`)
      .send({ period: '2024-13' })
      .expect(400);
  });

  // ============================================================
  // S12：列表的 total 是真实总数
  // ============================================================

  it('S12：列表的 total 是真实总数（items 被 pageSize 截断，total 不能跟着截）', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2024-08');

    // ⚠️ **造 3 张单、都在同一期**（3 > pageSize=2）→ items 会被截断，
    //    total 不该跟着截。
    //
    // ⚠️ **必须是 3 个不同的商家**：同一商家同一周期只能有一张单
    //    （`@@unique([tenantId, periodStart])`），换商家才是「同一期多张单」。
    for (let i = 0; i < 3; i += 1) {
      const m = await createMerchant(app, prisma);
      const orderId = await seedOrder(m.tenantId);
      await seedEntry(m.tenantId, orderId, {
        type: CommissionEntryType.COMMISSION,
        amount: 100,
        occurredAt: inside(period, 10 + i),
      });
      // ⚠️ **显式点名商家**：批量生成会把这一期**所有**有流水的商家都出单，
      //    那样「这一期恰好 3 张」就说不清了。
      await generate(adminToken, '2024-08', m.tenantId);
    }

    const body = await fetchList(adminToken, {
      period: '2024-08',
      pageSize: '2',
    });

    // ⚠️ **items 确实被截断了**（这是前提，断了这条用例就失去意义）
    expect(body.items).toHaveLength(2);
    // ⚠️ **total 是真实总数**：若 `total` 用的是 `items.length`，这里会是 2。
    expect(body.total).toBe(3);
    // ⚠️ **total 严格大于 items.length**：这正是「total 不能跟着截」的证据
    expect(body.total).toBeGreaterThan(body.items.length);
  });

  it('S12：列表可按周期与状态筛选', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const period = month('2024-11');

    const orderId = await seedOrder(merchant.tenantId);
    await seedEntry(merchant.tenantId, orderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 10),
    });
    const body = await generate(adminToken, '2024-11', merchant.tenantId);
    await http(app)
      .post(`/api/v1/platform/settlements/${body.items[0].id}/confirm`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(201);

    const drafts = await fetchList(adminToken, {
      period: '2024-11',
      status: 'DRAFT',
    });
    expect(drafts.items).toHaveLength(0);

    const confirmed = await fetchList(adminToken, {
      period: '2024-11',
      status: 'CONFIRMED',
    });
    expect(confirmed.items).toHaveLength(1);
    expect(confirmed.items[0].tenantId).toBe(merchant.tenantId);
  });

  // ============================================================
  // 其它
  // ============================================================

  it('该商家本期没有流水 → 显式点名时 404，批量时静默跳过', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);

    await http(app)
      .post('/api/v1/platform/settlements')
      .set('authorization', `Bearer ${adminToken}`)
      .send({ period: '2024-10', tenantId: merchant.tenantId })
      .expect(404);

    // 批量：没有流水的商家不产生单据，也不报错
    //
    // ⚠️ **断言要具体**：`created >= 0` 恒真，什么都验不到。
    //    这一期（2024-10）**全库没有任何流水** —— 本文件里没有别的用例
    //    往这个月造数据 → 批量生成的结果必然是「一张单都没有」。
    const body = await generate(adminToken, '2024-10');
    expect(body.created).toBe(0);
    expect(body.skipped).toBe(0);
    expect(body.items).toHaveLength(0);
  });

  it('批量生成：该期所有有流水的商家各有一张单', async () => {
    const adminToken = await loginPlatformAdmin();
    const a = await createMerchant(app, prisma);
    const b = await createMerchant(app, prisma);
    const period = month('2024-12');

    const orderA = await seedOrder(a.tenantId);
    await seedEntry(a.tenantId, orderA, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 10),
    });
    const orderB = await seedOrder(b.tenantId);
    await seedEntry(b.tenantId, orderB, {
      type: CommissionEntryType.COMMISSION,
      amount: 200,
      occurredAt: inside(period, 11),
    });

    const body = await generate(adminToken, '2024-12');

    // ⚠️ **这一期只有这两家有流水**（本文件里没有别的用例往 2024-12 造数据）
    //    → 批量生成的结果恰好是 2 张。
    const mine = body.items.filter(
      (item) => item.tenantId === a.tenantId || item.tenantId === b.tenantId,
    );
    expect(mine).toHaveLength(2);
    expect(body.created).toBe(2);
    expect(body.skipped).toBe(0);
    // ⚠️ **两家各自的金额都对**：不能只看「有 2 张」。
    expect(mine.find((item) => item.tenantId === a.tenantId)?.netAmount).toBe(
      100,
    );
    expect(mine.find((item) => item.tenantId === b.tenantId)?.netAmount).toBe(
      200,
    );
  });

  it('取消确认：CONFIRMED → DRAFT，且 DRAFT 不能取消确认', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const period = month('2024-09');

    const orderId = await seedOrder(merchant.tenantId);
    await seedEntry(merchant.tenantId, orderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 10),
    });

    const body = await generate(adminToken, '2024-09', merchant.tenantId);
    const id = body.items[0].id;

    // DRAFT 不能取消确认
    await http(app)
      .post(`/api/v1/platform/settlements/${id}/unconfirm`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(409);

    await http(app)
      .post(`/api/v1/platform/settlements/${id}/confirm`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(201);

    const unconfirmed = await http(app)
      .post(`/api/v1/platform/settlements/${id}/unconfirm`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(201);
    expect((unconfirmed.body as StatementBody).status).toBe('DRAFT');
    expect((unconfirmed.body as StatementBody).confirmedAt).toBeNull();
  });

  it('⚠️ 已被出款单引用的结算单 → 不能取消确认（护栏 P6）', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const period = month('2025-06');

    const orderId = await seedOrder(merchant.tenantId);
    await seedEntry(merchant.tenantId, orderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 10),
    });

    const body = await generate(adminToken, '2025-06', merchant.tenantId);
    const id = body.items[0].id;

    // 先确认
    await http(app)
      .post(`/api/v1/platform/settlements/${id}/confirm`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(201);

    // ⚠️ **手工造一张引用了这张结算单的出款单**：
    // 本阶段出款单的创建要走商家申请，而 e2e 里出款端点是 Task 7 才有的。
    // 这里直接插库 —— 测的是「结算单被引用后取消确认被拒」这条闸本身。
    //
    // ⚠️ **平台作用域下写租户模型必须显式带 `tenantId`**：
    //    `Payout` 在 `TENANT_SCOPED_MODELS` 白名单里，平台作用域写入
    //    若不显式指定 `tenantId` 会直接抛 `TenantScopeError`。
    await asPlatform(() =>
      prisma.payout.create({
        data: {
          tenantId: merchant.tenantId,
          payoutNo: `PAY-TEST-${unique()}`,
          periodStart: period.from,
          periodEnd: period.to,
          statementId: id,
          receiptAmount: 100,
          commissionAmount: 100,
          netAmount: 0,
          entryCount: 0,
          status: PayoutStatus.APPROVED,
          requestedAmount: 0,
          requestedBy: 'test-user',
          approvedBy: 'test-admin',
        },
      }),
    );

    // ⚠️ **取消确认 → 409**，且结算单仍是 CONFIRMED
    const response = await http(app)
      .post(`/api/v1/platform/settlements/${id}/unconfirm`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(409);
    expect(errorText(response.body)).toContain('出款单');

    const after = await fetchDetail(adminToken, id);
    expect(after.status).toBe('CONFIRMED');
    expect(after.confirmedAt).toBeTruthy();
    // ⚠️ **金额不能被顺手改掉**：被拒的取消确认只该拒绝，不该有任何副作用
    expect(after.netAmount).toBe(100);
    expect(after.entryCount).toBe(1);
  });

  it('⚠️ 只被已拒绝 / 已撤回的出款单引用的结算单 → 仍能取消确认', async () => {
    // ⚠️ **反面用例**（这道闸不能挡过头）：
    //    `REJECTED` / `CANCELLED` 的出款单**没有打钱**，
    //    它们不构成「钱已经出去了」的事实 → 不该拦住修正漏结的路径。
    //    若闸写成「只要有出款单引用就拦」，这条会挂。
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const period = month('2025-07');

    const orderId = await seedOrder(merchant.tenantId);
    await seedEntry(merchant.tenantId, orderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 10),
    });

    const body = await generate(adminToken, '2025-07', merchant.tenantId);
    const id = body.items[0].id;

    await http(app)
      .post(`/api/v1/platform/settlements/${id}/confirm`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(201);

    await asPlatform(() =>
      prisma.payout.create({
        data: {
          tenantId: merchant.tenantId,
          payoutNo: `PAY-TEST-${unique()}`,
          periodStart: period.from,
          periodEnd: period.to,
          statementId: id,
          receiptAmount: 100,
          commissionAmount: 100,
          netAmount: 0,
          entryCount: 0,
          status: PayoutStatus.REJECTED,
          requestedAmount: 0,
          requestedBy: 'test-user',
          approvedBy: 'test-admin',
          rejectedReason: '测试用：已拒绝的出款单不构成出款事实',
        },
      }),
    );

    const unconfirmed = await http(app)
      .post(`/api/v1/platform/settlements/${id}/unconfirm`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(201);
    expect((unconfirmed.body as StatementBody).status).toBe('DRAFT');
  });

  it('重算：新的流水进来后重算，金额跟着变', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const period = month('2024-03');

    const orderA = await seedOrder(merchant.tenantId);
    await seedEntry(merchant.tenantId, orderA, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 10),
    });

    const body = await generate(adminToken, '2024-03', merchant.tenantId);
    const id = body.items[0].id;
    expect(body.items[0].netAmount).toBe(100);

    // ⚠️ **又来一笔同期的流水**（模拟回填补进来的历史流水）
    const orderB = await seedOrder(merchant.tenantId);
    await seedEntry(merchant.tenantId, orderB, {
      type: CommissionEntryType.COMMISSION,
      amount: 250,
      occurredAt: inside(period, 20),
    });

    const recalculated = await http(app)
      .post(`/api/v1/platform/settlements/${id}/recalculate`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(201);
    expect((recalculated.body as StatementBody).netAmount).toBe(350);
    expect((recalculated.body as StatementBody).entryCount).toBe(2);

    // ⚠️ **明细里不能有重复的行**（重算要先删旧的关联行）
    const detail = await fetchDetail(adminToken, id);
    expect(detail.entries).toHaveLength(2);
  });

  it('详情：明细里的每一行都能对上流水', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const period = month('2024-02');

    const orderA = await seedOrder(merchant.tenantId);
    await seedEntry(merchant.tenantId, orderA, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 5),
    });
    const orderB = await seedOrder(merchant.tenantId);
    await seedEntry(merchant.tenantId, orderB, {
      type: CommissionEntryType.REVERSAL,
      amount: -30,
      occurredAt: inside(period, 6),
    });

    const body = await generate(adminToken, '2024-02', merchant.tenantId);
    const detail = await fetchDetail(adminToken, body.items[0].id);

    expect(detail.entries).toHaveLength(2);
    expect(detail.entries[0].type).toBe('COMMISSION');
    expect(detail.entries[0].amount).toBe(100);
    expect(detail.entries[0].rateBps).toBe(500);
    expect(detail.entries[1].type).toBe('REVERSAL');
    expect(detail.entries[1].amount).toBe(-30);
    // ⚠️ **明细是按时间排的**（流水按 `occurredAt` 升序）
    expect(detail.entries[0].occurredAt < detail.entries[1].occurredAt).toBe(
      true,
    );
  });

  it('详情：单据不存在 → 404', async () => {
    const adminToken = await loginPlatformAdmin();

    await http(app)
      .get('/api/v1/platform/settlements/00000000-0000-4000-8000-000000000000')
      .set('authorization', `Bearer ${adminToken}`)
      .expect(404);
  });

  it('详情：id 不是 uuid → 400', async () => {
    const adminToken = await loginPlatformAdmin();

    await http(app)
      .get('/api/v1/platform/settlements/not-a-uuid')
      .set('authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  // ============================================================
  // 明细分页（阶段 5l）
  // ============================================================

  /** 拉明细分页 */
  async function fetchEntries(
    token: string,
    id: string,
    query: Record<string, string> = {},
  ): Promise<EntriesPageBody> {
    const params = new URLSearchParams(query);
    const suffix = params.toString();
    const response = await http(app)
      .get(
        `/api/v1/platform/settlements/${id}/entries${suffix ? `?${suffix}` : ''}`,
      )
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    return response.body as EntriesPageBody;
  }

  it('明细分页：每一行都能对上流水，且按发生时间排序', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const period = month('2024-08');

    const orderA = await seedOrder(merchant.tenantId);
    await seedEntry(merchant.tenantId, orderA, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 20),
    });
    const orderB = await seedOrder(merchant.tenantId);
    await seedEntry(merchant.tenantId, orderB, {
      type: CommissionEntryType.REVERSAL,
      amount: -30,
      occurredAt: inside(period, 10),
    });

    const body = await generate(adminToken, '2024-08', merchant.tenantId);
    const page = await fetchEntries(adminToken, body.items[0].id);

    expect(page.total).toBe(2);
    expect(page.page).toBe(1);
    expect(page.items).toHaveLength(2);
    // ⚠️ **明细是按时间排的**：10 日那笔（REVERSAL）在前，20 日那笔在后。
    expect(page.items[0].type).toBe('REVERSAL');
    expect(page.items[0].amount).toBe(-30);
    expect(page.items[1].type).toBe('COMMISSION');
    expect(page.items[1].amount).toBe(100);
    expect(page.items[0].occurredAt < page.items[1].occurredAt).toBe(true);
  });

  it('⚠️ 明细分页：跨页不漏行、不重复', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const period = month('2024-09');

    // ⚠️ **5 笔**：每页 2 笔 → 3 页
    for (let day = 1; day <= 5; day += 1) {
      const orderId = await seedOrder(merchant.tenantId);
      await seedEntry(merchant.tenantId, orderId, {
        type: CommissionEntryType.COMMISSION,
        amount: 100,
        occurredAt: inside(period, day),
      });
    }

    const body = await generate(adminToken, '2024-09', merchant.tenantId);
    const id = body.items[0].id;

    const first = await fetchEntries(adminToken, id, { page: '1', pageSize: '2' });
    const second = await fetchEntries(adminToken, id, {
      page: '2',
      pageSize: '2',
    });
    const third = await fetchEntries(adminToken, id, {
      page: '3',
      pageSize: '2',
    });

    const ids = [
      ...first.items.map((item) => item.entryId),
      ...second.items.map((item) => item.entryId),
      ...third.items.map((item) => item.entryId),
    ];

    // ⚠️ **5 笔一行不多一行不少**：漏行 → 超管核账核不上；
    //    重复行 → 同一笔流水被算两次。
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    // ⚠️ **每页的 total 都是全量笔数**（不是本页条数）
    expect(first.total).toBe(5);
    expect(second.total).toBe(5);
    expect(third.total).toBe(5);
    // ⚠️ **页内顺序按发生时间**
    expect(first.items[0].occurredAt < first.items[1].occurredAt).toBe(true);
  });

  it('⚠️ 明细分页：pageSize 超过上限时夹到 100', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const period = month('2024-10');

    const orderId = await seedOrder(merchant.tenantId);
    await seedEntry(merchant.tenantId, orderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 10),
    });

    const body = await generate(adminToken, '2024-10', merchant.tenantId);
    const page = await fetchEntries(adminToken, body.items[0].id, {
      pageSize: '999999',
    });

    // ⚠️ **不能一次拖走全部**（`clampPagination` 的 `MAX_PAGE_SIZE`）
    expect(page.pageSize).toBe(100);
  });

  it('明细分页：单据不存在 → 404', async () => {
    const adminToken = await loginPlatformAdmin();

    await http(app)
      .get(
        '/api/v1/platform/settlements/00000000-0000-4000-8000-000000000000/entries',
      )
      .set('authorization', `Bearer ${adminToken}`)
      .expect(404);
  });

  it('明细分页：id 不是 uuid → 400', async () => {
    const adminToken = await loginPlatformAdmin();

    await http(app)
      .get('/api/v1/platform/settlements/not-a-uuid/entries')
      .set('authorization', `Bearer ${adminToken}`)
      .expect(400);
  });

  it('⚠️ 明细分页：商家账号调 → 403（不能看别人家的明细）', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const period = month('2024-11');

    const orderId = await seedOrder(merchant.tenantId);
    await seedEntry(merchant.tenantId, orderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 10),
    });

    const body = await generate(adminToken, '2024-11', merchant.tenantId);
    const id = body.items[0].id;

    await http(app)
      .get(`/api/v1/platform/settlements/${id}/entries`)
      .set('authorization', `Bearer ${merchant.token}`)
      .expect(403);
  });

  // ============================================================
  // 审查修复项：重算不能把单据抹成 0 元 0 明细
  // ============================================================

  it('重算：当期已无流水 → 409，且单据金额没被清零', async () => {
    // ⚠️ **要锁住的是「金额没被抹掉」**，不是「返回了 409」：
    //    静默抹账（单据变成 0/0/0、entryCount=0）才是真正的危害 ——
    //    调用方只会看到「重算成功」，账却被清空了。
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const period = month('2024-06');

    const orderId = await seedOrder(merchant.tenantId);
    const entryId = await seedEntry(merchant.tenantId, orderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 10),
    });

    const body = await generate(adminToken, '2024-06', merchant.tenantId);
    const id = body.items[0].id;
    expect(body.items[0].netAmount).toBe(100);
    expect(body.items[0].entryCount).toBe(1);

    // ---- 让当期流水消失 ----
    //
    // ⚠️ **流水是 append-only 的**（不软删），外键也是 Restrict ——
    //    正常路径下删不掉它。这里**把 `occurredAt` 改到别的月份**，
    //    模拟「查不到当期流水但单据还在」的场景。
    //    改时间不是删行 → 外键 Restrict 不拦，`entryCount` 的语义也不受影响。
    //
    // ⚠️ **必须用 `updateMany` 而不是 `update`**：`CommissionEntry` 在
    //    租户作用域白名单里，`update` 只接受唯一字段、无法附加 `tenantId`
    //    条件 → 扩展会直接抛 `TenantScopeError`。
    await asPlatform(() =>
      prisma.commissionEntry.updateMany({
        where: { id: entryId },
        data: { occurredAt: inside(month('2024-07'), 10) },
      }),
    );

    // ---- 重算 → 必须 409 ----
    const response = await http(app)
      .post(`/api/v1/platform/settlements/${id}/recalculate`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(409);

    // ⚠️ **错误消息要说清是「当期没有流水」**，不能是别的理由
    const error = response.body as ErrorBody;
    expect(error.message).toContain('已无抽佣流水');

    // ⚠️ **单据没被抹成 0**：金额、明细、状态都要原样
    const after = await fetchDetail(adminToken, id);
    expect(after.netAmount).toBe(100);
    expect(after.grossAmount).toBe(100);
    expect(after.entryCount).toBe(1);
    expect(after.entries).toHaveLength(1);
    expect(after.status).toBe('DRAFT');
  });

  // ============================================================
  // 审查修复项：取消确认必须检查 updateMany 的 affected.count
  // ============================================================

  it('取消确认：单据不存在 → 404；DRAFT 状态 → 409 且状态没被改', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const period = month('2024-05');

    const orderId = await seedOrder(merchant.tenantId);
    await seedEntry(merchant.tenantId, orderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 10),
    });

    const body = await generate(adminToken, '2024-05', merchant.tenantId);
    const id = body.items[0].id;

    // ---- DRAFT 不能取消确认 → 409，状态不变 ----
    const response = await http(app)
      .post(`/api/v1/platform/settlements/${id}/unconfirm`)
      .set('authorization', `Bearer ${adminToken}`)
      .expect(409);
    expect((response.body as ErrorBody).message).toContain('不能取消确认');

    const after = await fetchDetail(adminToken, id);
    expect(after.status).toBe('DRAFT');
    expect(after.confirmedAt).toBeNull();
    // ⚠️ **金额没被动过**：状态不该的取消确认不能顺手改金额
    expect(after.netAmount).toBe(100);

    // ---- 单据不存在 → 404 ----
    await http(app)
      .post(
        '/api/v1/platform/settlements/00000000-0000-4000-8000-000000000000/unconfirm',
      )
      .set('authorization', `Bearer ${adminToken}`)
      .expect(404);
  });

  // ============================================================
  // 审查修复项：幂等复用时要标出「这张单已经缺笔」
  // ============================================================

  it('生成：复用已存在的单据时，若该期又进了流水 → 响应里标出这张单过时了', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const period = month('2024-03');

    const orderA = await seedOrder(merchant.tenantId);
    await seedEntry(merchant.tenantId, orderA, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 10),
    });

    const first = await generate(adminToken, '2024-03', merchant.tenantId);
    expect(first.created).toBe(1);
    // ⚠️ **不能写 `first.stale ?? []`**：后端漏返 `stale` 时那样会假通过
    expect(first.stale).toEqual([]);

    // ---- 该期又进了流水（模拟回填补录进来的历史流水）----
    const orderB = await seedOrder(merchant.tenantId);
    await seedEntry(merchant.tenantId, orderB, {
      type: CommissionEntryType.COMMISSION,
      amount: 250,
      occurredAt: inside(period, 20),
    });

    // ---- 再生成 → 走幂等复用，但必须能看出这张单缺笔了 ----
    const second = await generate(adminToken, '2024-03', merchant.tenantId);
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(1);
    expect(second.items[0].id).toBe(first.items[0].id);

    // ⚠️ **调用方必须能看见「这张单与当期流水对不上」**：
    //    否则 `skipped: 1` 会被读成「本期已结清」，实际金额差了 250。
    expect(second.stale).toContain(merchant.tenantId);

    // ⚠️ **但单据本身不能被改动**：金额仍是生成时的 100，
    //    修改要走「取消确认 → 重算」这条显式路径。
    const after = await fetchDetail(adminToken, first.items[0].id);
    expect(after.netAmount).toBe(100);
    expect(after.entryCount).toBe(1);
  });

  it('生成：复用已存在的单据且当期流水没变 → 不标过时', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const period = month('2024-09');

    const orderId = await seedOrder(merchant.tenantId);
    await seedEntry(merchant.tenantId, orderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 10),
    });

    await generate(adminToken, '2024-09', merchant.tenantId);
    const second = await generate(adminToken, '2024-09', merchant.tenantId);

    expect(second.skipped).toBe(1);
    // ⚠️ **不能误报**：没缺笔就不能说它过时，否则这个标记没人敢信
    // ⚠️ **不能写 `?? []`**：后端漏返 `stale` 时那样会假通过
    expect(second.stale).toEqual([]);
  });

  // ============================================================
  // 审查修复项：批量生成部分成功时要看得见
  // ============================================================

  it('批量生成：某个商家冲突 → 其余商家的单照常生成，冲突被收集起来（200）', async () => {
    // ⚠️ **要锁住三件事**：
    //    ① 其余商家的单**真的落库了**（不是「整批回滚」）；
    //    ② 冲突的那个商家在响应里**看得见**；
    //    ③ 状态码是 200 而不是 409 —— 已经有单生成了，
    //       整体报冲突会让调用方以为「什么都没发生」。
    //
    // ⚠️ **用 2025-03 这个「没人用过的月份」**：
    //    批量模式会处理**该期所有有流水的商家**，
    //    用 2024 的月份会把别的用例造的商家也拉进来 →
    //    断言就只能说「至少有一张」，锁不住具体语义。
    const adminToken = await loginPlatformAdmin();
    const ok = await createMerchant(app, prisma);
    const bad = await createMerchant(app, prisma);
    const period = month('2025-03');

    // ---- 冲突方：流水已经被另一张「周期对不上」的脏单结算过了 ----
    const badOrderId = await seedOrder(bad.tenantId);
    const badEntryId = await seedEntry(bad.tenantId, badOrderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 10),
    });
    const dirty = await asPlatform(() =>
      prisma.settlementStatement.create({
        data: {
          tenantId: bad.tenantId,
          statementNo: `STL-DIRTY-${unique()}`,
          // ⚠️ **周期故意与流水的 `occurredAt` 错开**：
          //    脏单的周期起点在 2025-02，而流水在 2025-03。
          periodStart: month('2025-02').from,
          periodEnd: month('2025-02').to,
          grossAmount: 100,
          reversalAmount: 0,
          netAmount: 100,
          entryCount: 1,
          status: SettlementStatus.DRAFT,
        },
      }),
    );
    await asPlatform(() =>
      prisma.settlementStatementEntry.create({
        data: { statementId: dirty.id, entryId: badEntryId },
      }),
    );

    // ---- 正常方：这一期有流水，能出单 ----
    const okOrderId = await seedOrder(ok.tenantId);
    await seedEntry(ok.tenantId, okOrderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 700,
      occurredAt: inside(period, 11),
    });

    // ---- 批量生成 ----
    const response = await http(app)
      .post('/api/v1/platform/settlements')
      .set('authorization', `Bearer ${adminToken}`)
      .send({ period: '2025-03' })
      .expect(200);

    const body = response.body as GenerateBody;

    // ⚠️ **正常方的单真的生成了**
    const okItems = body.items.filter((item) => item.tenantId === ok.tenantId);
    expect(okItems).toHaveLength(1);
    expect(okItems[0].netAmount).toBe(700);

    // ⚠️ **冲突方在响应里看得见**，且消息能指出原因
    expect(body.conflicts).toBeDefined();
    const conflict = body.conflicts.find(
      (item) => item.tenantId === bad.tenantId,
    );
    expect(conflict).toBeDefined();
    expect(conflict?.message).toContain('已经被结算过了');

    // ⚠️ **冲突方没有单据**（不能既冲突又出单）
    const badItems = body.items.filter(
      (item) => item.tenantId === bad.tenantId,
    );
    expect(badItems).toHaveLength(0);

    // ⚠️ **单据真的落库了**（不能只是响应里「说有」）：
    //    整批回滚的话响应里的 items 会是空的。
    const persisted = await asPlatform(() =>
      prisma.settlementStatement.findFirst({
        where: { tenantId: ok.tenantId, periodStart: period.from },
      }),
    );
    expect(persisted).not.toBeNull();
    expect(persisted?.netAmount).toBe(700);
  });

  it('批量生成：全部成功 → conflicts 是空数组', async () => {
    // ⚠️ **必须走真正的批量**（不点名商家）：
    //    点名时走的是「一个商家」的分支，压根不会收集冲突。
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const period = month('2025-04');

    const orderId = await seedOrder(merchant.tenantId);
    await seedEntry(merchant.tenantId, orderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 10),
    });

    const body = await generate(adminToken, '2025-04');
    // ⚠️ **不能写 `body.conflicts ?? []`**：后端漏返 `conflicts` 时
    //    `undefined ?? []` → `[]` → **断言照样通过**（假通过）。
    expect(body.conflicts).toEqual([]);
    expect(body.created).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].tenantId).toBe(merchant.tenantId);
  });

  it('生成：显式点名商家而这家冲突 → 仍然直接 409（不收集）', async () => {
    // ⚠️ **点名与批量是两套语义**：
    //    点名时调用方明确知道是哪一家 → 直接 409 更直接；
    //    批量时才知道是谁 → 收集进 `conflicts`。
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);
    const period = month('2024-04');

    const orderId = await seedOrder(merchant.tenantId);
    const entryId = await seedEntry(merchant.tenantId, orderId, {
      type: CommissionEntryType.COMMISSION,
      amount: 100,
      occurredAt: inside(period, 10),
    });

    const dirty = await asPlatform(() =>
      prisma.settlementStatement.create({
        data: {
          tenantId: merchant.tenantId,
          statementNo: `STL-DIRTY-${unique()}`,
          periodStart: month('2024-02').from,
          periodEnd: month('2024-02').to,
          grossAmount: 100,
          reversalAmount: 0,
          netAmount: 100,
          entryCount: 1,
          status: SettlementStatus.DRAFT,
        },
      }),
    );
    await asPlatform(() =>
      prisma.settlementStatementEntry.create({
        data: { statementId: dirty.id, entryId },
      }),
    );

    const response = await http(app)
      .post('/api/v1/platform/settlements')
      .set('authorization', `Bearer ${adminToken}`)
      .send({ period: '2024-04', tenantId: merchant.tenantId })
      .expect(409);
    expect((response.body as ErrorBody).message).toContain('已经被结算过了');
  });

  // ============================================================
  // 审查修复项：DTO 的周期正则要与 service 一致
  // ============================================================

  it('周期年份超出范围（0000-01 / 9999-12）→ 400', async () => {
    const adminToken = await loginPlatformAdmin();

    // ⚠️ **DTO 的正则要与 `resolveMonthlyPeriod` 一致**：
    //    `0000-01` / `0099-12` / `9999-12` 的**格式**是合法的，
    //    是**年份超范围** —— 报「格式非法」是误导。
    for (const period of ['0000-01', '0099-12', '0100-01', '9999-12']) {
      const response = await http(app)
        .post('/api/v1/platform/settlements')
        .set('authorization', `Bearer ${adminToken}`)
        .send({ period })
        .expect(400);
      // ⚠️ **文案要说清是「年份超范围」**，不是笼统的「格式非法」
      expect(errorText(response.body)).toContain('年份');
    }
  });

  it('列表的周期参数年份超范围 → 400', async () => {
    const adminToken = await loginPlatformAdmin();

    for (const period of ['0000-01', '9999-12']) {
      await http(app)
        .get(`/api/v1/platform/settlements?period=${period}`)
        .set('authorization', `Bearer ${adminToken}`)
        .expect(400);
    }
  });

  it('周期年份在合法区间内 → 不被 DTO 误拦', async () => {
    const adminToken = await loginPlatformAdmin();
    const merchant = await createMerchant(app, prisma);

    // ⚠️ **收紧正则不能误伤合法输入**：1000 是 service 允许的年份下界，
    //    DTO 也必须放行。
    //    ⚠️ **怎么证明 DTO 放行了**：错误消息。DTO 拦下时文案含「年份」，
    //    service 拦下时文案是「没有抽佣流水」——
    //    两者的措辞不同，可以据此区分是哪一层拦的。
    //
    //    1000-01：DTO 放行 → service 发现该商家这一期没有流水 → 404。
    const response = await http(app)
      .post('/api/v1/platform/settlements')
      .set('authorization', `Bearer ${adminToken}`)
      .send({ period: '1000-01', tenantId: merchant.tenantId })
      .expect(404);
    expect(errorText(response.body)).toContain('没有抽佣流水');
  });
});
