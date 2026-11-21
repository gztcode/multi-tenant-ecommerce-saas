/**
 * payouts 租户前缀索引的回归验证（阶段 11，P2-4 审计）。
 *
 * 背景：租户侧出款单列表按「创建时刻倒序」翻页
 * （`PayoutQueryService.listForTenant`：`where` 只带 tenantId，
 *  `orderBy: { createdAt: 'desc' }`）。原先 payouts 上没有任何以 tenantId
 * 打头的索引 —— 这条查询只能 Seq Scan 全表再 top-N 排序。
 *
 * 本用例用 `EXPLAIN (ANALYZE)` 把「走索引」这个事实钉住：
 * 索引一旦被误删（迁移回滚 / 手工 DROP），用例会立刻红。
 */
import { Prisma, PrismaClient } from '@prisma/client';

/** 探针租户：只属于本用例，用完即删 */
const PROBE_TENANT = 'payout-idx-probe';
/** 陪衬租户：给探针租户之外塞足量行，让「走索引 vs 全表扫」的差别可测 */
const FILLER_TENANT = 'payout-idx-probe-filler';

const PROBE_ROWS = 1_000;
const FILLER_ROWS = 4_000;

/** 新加的索引名（与迁移 20261121000000_add_payout_tenant_created_idx 一致） */
const INDEX_NAME = 'payouts_tenantId_createdAt_idx';

/** EXPLAIN 结果的列名 */
const PLAN_COLUMN = 'QUERY PLAN';

/** 计划里出现「走索引」的节点（Index Scan / Index Only Scan） */
const INDEX_SCAN = /Index (?:Only )?Scan/;

describe('payouts 租户前缀索引（阶段 11 / P2-4）', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    // ⚠️ 裸 PrismaClient：本用例要**跨租户**造数据（探针租户 + 陪衬租户），
    //    走租户扩展只会绑死在一个租户上，所以直接用原生客户端。
    prisma = new PrismaClient();

    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "payouts" (
        "id", "tenantId", "payoutNo", "periodStart", "periodEnd",
        "receiptAmount", "commissionAmount", "netAmount", "entryCount",
        "status", "requestedAmount", "requestedBy", "kind", "attemptCount",
        "failedBeforePayout", "snapshotEncryptionVersion",
        "requestedAt", "createdAt", "updatedAt"
      )
      SELECT
        gen_random_uuid()::text,
        t."tenant",
        'idx-probe-' || t."tenant" || '-' || g,
        TIMESTAMPTZ '2026-01-01 00:00:00+00' + (g || ' days')::interval,
        TIMESTAMPTZ '2026-01-01 00:00:00+00' + ((g + 1) || ' days')::interval,
        100000, 1000, 99000, 10,
        'PAID'::"PayoutStatus", 99000, 'idx-probe-user', 'NORMAL'::"PayoutKind", 1,
        false, 0,
        NOW() - (g || ' minutes')::interval,
        NOW() - (g || ' minutes')::interval,
        NOW() - (g || ' minutes')::interval
      FROM (VALUES (${PROBE_TENANT}::text), (${FILLER_TENANT}::text)) AS t("tenant")
      CROSS JOIN LATERAL (
        SELECT CASE
                 WHEN t."tenant" = ${PROBE_TENANT}::text
                   THEN CAST(${PROBE_ROWS} AS int)
                 ELSE CAST(${FILLER_ROWS} AS int)
               END AS n
      ) AS c
      CROSS JOIN LATERAL generate_series(1, c.n) AS g
    `);

    // ⚠️ 必须 VACUUM (ANALYZE)：
    //    1. ANALYZE —— PG 选计划靠的是统计信息，插完不更新的话
    //       统计信息还停留在「表是空的」那一份，计划选择会飘；
    //    2. VACUUM —— count(*) 走 Index Only Scan 的前提是 visibility map
    //       干净（否则每行都要回表，代价算下来比全表扫还高，PG 就改走 Seq Scan）。
    await prisma.$executeRaw(Prisma.sql`VACUUM (ANALYZE) "payouts"`);
  });

  afterAll(async () => {
    // 探针数据不能留给后面的用例（e2e 各文件共享同一个测试库）
    await prisma.$executeRaw(Prisma.sql`
      DELETE FROM "payouts"
      WHERE "tenantId" IN (${PROBE_TENANT}::text, ${FILLER_TENANT}::text)
    `);
    await prisma.$disconnect();
  });

  /** 跑一条 EXPLAIN (ANALYZE)，返回拼好的计划文本 */
  async function explain(sql: Prisma.Sql): Promise<string> {
    const rows = await prisma.$queryRaw<Array<Record<string, string>>>(sql);
    return rows.map((row) => row[PLAN_COLUMN]).join('\n');
  }

  it('租户侧出款单列表（按创建时刻倒序）走索引，不做全表扫', async () => {
    const plan = await explain(Prisma.sql`
      EXPLAIN (ANALYZE)
      SELECT * FROM "payouts"
      WHERE "tenantId" = ${PROBE_TENANT}::text
      ORDER BY "createdAt" DESC
      LIMIT 20
    `);

    expect(plan).toContain(INDEX_NAME);
    expect(plan).toMatch(INDEX_SCAN);
    // 走索引就不该再有全表扫
    expect(plan).not.toContain('Seq Scan');
    // 排序也不能靠全表 Sort 兜底
    expect(plan).not.toContain('Sort Method');
  });

  it('索引的租户前缀被用作 index condition（证明 tenantId 打头）', async () => {
    const plan = await explain(Prisma.sql`
      EXPLAIN (ANALYZE)
      SELECT * FROM "payouts"
      WHERE "tenantId" = ${PROBE_TENANT}::text
      ORDER BY "createdAt" DESC
      LIMIT 20
    `);

    expect(plan).toMatch(/Index Cond: \("tenantId" =/);
  });

  it('出款单总数统计（count）同样走索引', async () => {
    const plan = await explain(Prisma.sql`
      EXPLAIN (ANALYZE)
      SELECT count(*) FROM "payouts"
      WHERE "tenantId" = ${PROBE_TENANT}::text
    `);

    expect(plan).toContain(INDEX_NAME);
    expect(plan).toMatch(INDEX_SCAN);
    expect(plan).not.toContain('Seq Scan');
  });
});
