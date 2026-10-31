import { PayoutStatus, SettlementStatus } from '@prisma/client';
import { PayoutExecutionService } from './payout-execution.service';
import { PayoutCipherService } from './payout-cipher.service';

/**
 * 出款执行状态落库服务的单元测试。
 *
 * ⚠️ **假 Prisma 是「配置驱动」的**，不按 `where` 过滤
 *    （与 `payout.service.spec.ts` 同款）。跨租户的实际行为靠 e2e 验。
 *
 * ⚠️ **事务客户端与顶层 Prisma 是两回事**：
 *    `claimForExecution` / `markPaid` / `markFailed` / `scheduleRetry`
 *    里的 `payout.findFirst` / `payout.updateMany` 都跑在**事务客户端 `tx`** 上
 *    → 断言用 `prisma.tx()!.payout.…`；
 *    而 `markStuckLogged` 跑在**顶层** `this.prisma` 上
 *    → 断言用 `prisma.payout.…`。
 */

/** 取某个 mock 的第一次调用的参数 */
function argsOf(mock: {
  mock: { calls: unknown[][] };
}): Record<string, unknown> {
  const [call] = mock.mock.calls;
  expect(call).toBeDefined();
  return ((call ?? [])[0] ?? {}) as Record<string, unknown>;
}

/** 事务客户端的形状（只列本服务真正用到的那几个方法） */
interface FakeTx {
  payout: {
    updateMany: jest.Mock;
    findFirst: jest.Mock;
  };
  payoutEntry: { deleteMany: jest.Mock };
  settlementStatement: { updateMany: jest.Mock };
}

/** 一只最小可用的假 Prisma */
function fakePrisma(
  options: {
    updateManyCount?: number;
    payout?: unknown;
    statementCount?: number;
    /** `scanStuck` 的两次 `findMany` 的返回（① PROCESSING、② APPROVED） */
    findManyResults?: unknown[][];
  } = {},
) {
  let tx: FakeTx | null = null;
  // ⚠️ **`findMany` 的调用序号** —— `scanStuck` 连着查两次
  //    （① PROCESSING、② APPROVED），配置驱动要能区分这两次
  let findManySeq = 0;

  const prisma = {
    $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => {
      tx = {
        payout: {
          updateMany: jest.fn<Promise<{ count: number }>, [unknown]>(() =>
            Promise.resolve({ count: options.updateManyCount ?? 1 }),
          ),
          findFirst: jest.fn<Promise<unknown>, [unknown]>(() =>
            Promise.resolve(
              // ⚠️ **用 `undefined` 判断「没配」** —— 不能用 `??`：
              //    `null ?? 默认值` 会返回默认值 → 配了 `payout: null`
              //    （模拟「读不到行」）反而拿到默认行。
              options.payout === undefined
                ? {
                    kind: 'NORMAL',
                    statementId: 'stmt-a',
                    attemptCount: 2,
                  }
                : options.payout,
            ),
          ),
        },
        payoutEntry: {
          deleteMany: jest.fn<Promise<{ count: number }>, [unknown]>(() =>
            Promise.resolve({ count: 1 }),
          ),
        },
        settlementStatement: {
          updateMany: jest.fn<Promise<{ count: number }>, [unknown]>(() =>
            Promise.resolve({ count: options.statementCount ?? 1 }),
          ),
        },
      };
      return fn(tx);
    }),
    // ⚠️ **顶层 `payout`** —— 只有 `markStuckLogged` 与 `scanStuck` 用它（不走事务）
    payout: {
      updateMany: jest.fn<Promise<{ count: number }>, [unknown]>(() =>
        Promise.resolve({ count: 1 }),
      ),
      // ⚠️ **按调用次序返回不同的结果** —— `scanStuck` 连着查两次
      //    （① PROCESSING、② APPROVED），配置驱动要能区分这两次
      findMany: jest.fn<Promise<unknown[]>, [unknown]>(() => {
        const result = options.findManyResults?.[findManySeq] ?? [];
        findManySeq += 1;
        return Promise.resolve(result);
      }),
    },
  };

  return Object.assign(prisma, { tx: () => tx });
}

function makeService(
  prisma: ReturnType<typeof fakePrisma>,
): PayoutExecutionService {
  return new PayoutExecutionService(
    prisma as unknown as never,
    new PayoutCipherService(),
  );
}

/**
 * ⚠️ **单元测试进程里没有 .env** —— `PayoutCipherService` 在构造时就要密钥，
 *    拿不到就直接抛错。所以这里显式设一个**测试用**密钥。
 */
const TEST_ENCRYPTION_KEY = 'test-payout-encryption-key-at-least-32-chars';

beforeAll(() => {
  process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
});

describe('PayoutExecutionService', () => {
  describe('claimForExecution', () => {
    it('APPROVED → PROCESSING，attemptCount + 1，返回金额与账户快照', async () => {
      const plain = '6222000000000000';
      const prisma = fakePrisma({
        payout: {
          attemptCount: 1,
          netAmount: 8500,
          payoutNo: 'PAY202508010000000001',
          snapshotAccountName: '张三',
          snapshotBankName: '测试银行',
          snapshotAccountNoCipher: new PayoutCipherService().encrypt(plain),
          snapshotMaskedAccountNo: '************0000',
          snapshotEncryptionVersion: 1,
        },
      });
      const service = makeService(prisma);

      const claim = await service.claimForExecution(
        'payout-a',
        new Date('2025-08-20T00:00:00.000Z'),
      );

      expect(claim).not.toBeNull();
      expect(claim!.attemptCount).toBe(1);
      // ⚠️ **金额是审批锁定的值**（护栏 X2：worker 不重算）
      expect(claim!.netAmount).toBe(8500);
      // ⚠️ **账户是快照**（护栏 X2b：不实时查账户表）
      // ⚠️ **快照里的密文解出来 == 原文** —— 比「不等于原文」更强：
      //    它证明 worker 拿到的是**正确的明文**，而不是随便一个非空串。
      expect(claim!.account).toEqual({
        accountName: '张三',
        bankName: '测试银行',
        accountNo: plain,
      });
    });

    it('条件更新影响 0 行 → 返回 null（抢不到就静默返回）', async () => {
      const prisma = fakePrisma({ updateManyCount: 0 });
      const service = makeService(prisma);

      const claim = await service.claimForExecution('payout-a', new Date());

      expect(claim).toBeNull();
    });

    it('快照账号为空 → account 为 null（worker 据此落 FAILED）', async () => {
      const prisma = fakePrisma({
        payout: {
          attemptCount: 1,
          netAmount: 8500,
          payoutNo: 'PAY1',
          snapshotAccountName: null,
          snapshotBankName: null,
          snapshotAccountNoCipher: null,
          snapshotMaskedAccountNo: null,
          snapshotEncryptionVersion: 0,
        },
      });
      const service = makeService(prisma);

      const claim = await service.claimForExecution('payout-a', new Date());

      expect(claim!.account).toBeNull();
    });

    it('⚠️ 快照还没加密（版本 0）→ 不抛错，accountError 带着根因', async () => {
      // ⚠️ **原来这里是「抛错」** —— 抛错会让整个事务回滚，单子停在
      //    `APPROVED` 且 `attemptCount` 一起被回滚 → 兜底扫描把它当成
      //    「审批后入队失败」重新入队 → **每 5 分钟无限循环**（设计 §二·2.1）。
      //
      // ⚠️ **根因必须留在 `accountError` 里** —— 底层
      //    `decryptVersioned` 照样抛带中文原因的错，worker 只把它记进日志。
      const prisma = fakePrisma({
        payout: {
          attemptCount: 1,
          netAmount: 8500,
          payoutNo: 'PAY1',
          snapshotAccountName: '张三',
          snapshotBankName: '测试银行',
          snapshotAccountNoCipher: '6222000000000000',
          snapshotMaskedAccountNo: '************0000',
          snapshotEncryptionVersion: 0,
        },
      });
      const service = makeService(prisma);

      const claim = await service.claimForExecution('payout-a', new Date());

      // ⚠️ **根因指向「没加密」** —— 运维要靠它知道该跑哪条命令
      expect(claim!.accountError).toContain('尚未加密');
      expect(claim!.accountError).toContain('migrate:payout-encryption');
      // ⚠️ **绝不按明文兜底** —— 「忘了迁移」若被当成「就是明文」，
      //    等于把加密悄悄关掉了
      expect(claim!.account).toBeNull();
    });

    it('⚠️ 解密成功 → accountError 为 null，账户照常返回', async () => {
      // ⚠️ **对照组** —— 防止「捕获异常」的改动把正常路径也弄坏
      const plain = '6222000000000000';
      const prisma = fakePrisma({
        payout: {
          attemptCount: 1,
          netAmount: 8500,
          payoutNo: 'PAY1',
          snapshotAccountName: '张三',
          snapshotBankName: '测试银行',
          snapshotAccountNoCipher: new PayoutCipherService().encrypt(plain),
          snapshotMaskedAccountNo: '************0000',
          snapshotEncryptionVersion: 1,
        },
      });
      const service = makeService(prisma);

      const claim = await service.claimForExecution('payout-a', new Date());

      expect(claim!.accountError).toBeNull();
      expect(claim!.account).toEqual({
        accountName: '张三',
        bankName: '测试银行',
        accountNo: plain,
      });
    });
  });

  describe('markPaid', () => {
    it('PROCESSING → PAID，写入渠道交易号与打款时刻', async () => {
      const prisma = fakePrisma();
      const service = makeService(prisma);
      const paidAt = new Date('2025-08-20T00:00:00.000Z');

      const ok = await service.markPaid('payout-a', {
        providerTxnId: 'txn-1',
        channel: 'fake-payout',
        paidAt,
      });

      expect(ok).toBe(true);
      const data = argsOf(prisma.tx()!.payout.updateMany).data as {
        status: string;
        paidAt: Date;
        payoutTxnId: string;
      };
      expect(data.status).toBe(PayoutStatus.PAID);
      expect(data.paidAt).toBe(paidAt);
      expect(data.payoutTxnId).toBe('txn-1');
    });

    it('条件更新影响 0 行 → 返回 false，不碰结算单', async () => {
      const prisma = fakePrisma({ updateManyCount: 0 });
      const service = makeService(prisma);

      const ok = await service.markPaid('payout-a', {
        providerTxnId: 'txn-1',
        channel: 'fake-payout',
        paidAt: new Date(),
      });

      expect(ok).toBe(false);
      expect(
        prisma.tx()!.settlementStatement.updateMany,
      ).not.toHaveBeenCalled();
    });

    it('正常单 → 结算单 CONFIRMED → PAID，且写 paidAt', async () => {
      const prisma = fakePrisma({
        payout: { kind: 'NORMAL', statementId: 'stmt-a', attemptCount: 1 },
      });
      const service = makeService(prisma);
      const paidAt = new Date('2025-08-20T00:00:00.000Z');

      await service.markPaid('payout-a', {
        providerTxnId: 'txn-1',
        channel: 'fake-payout',
        paidAt,
      });

      const data = argsOf(prisma.tx()!.settlementStatement.updateMany).data as {
        status: string;
        paidAt: Date;
      };
      expect(data.status).toBe(SettlementStatus.PAID);
      // ⚠️ **paidAt 与 status 同一次 data 里写** —— 分开写会出矛盾行
      expect(data.paidAt).toBe(paidAt);
    });

    it('补差单 → 不碰结算单状态（护栏 X6）', async () => {
      const prisma = fakePrisma({
        payout: { kind: 'SUPPLEMENT', statementId: 'stmt-a', attemptCount: 1 },
      });
      const service = makeService(prisma);

      await service.markPaid('payout-a', {
        providerTxnId: 'txn-1',
        channel: 'fake-payout',
        paidAt: new Date(),
      });

      expect(
        prisma.tx()!.settlementStatement.updateMany,
      ).not.toHaveBeenCalled();
    });
  });

  describe('markFailed', () => {
    it('PROCESSING → FAILED，写失败原因与失败时刻', async () => {
      const prisma = fakePrisma();
      const service = makeService(prisma);
      const failedAt = new Date('2025-08-20T00:00:00.000Z');

      const ok = await service.markFailed('payout-a', {
        reason: '渠道超时',
        failedAt,
      });

      expect(ok).toBe(true);
      const data = argsOf(prisma.tx()!.payout.updateMany).data as {
        status: string;
        failureReason: string;
        failedAt: Date;
      };
      expect(data.status).toBe(PayoutStatus.FAILED);
      expect(data.failureReason).toBe('渠道超时');
      expect(data.failedAt).toBe(failedAt);
    });

    it('⚠️ 释放明细占用（否则商家重新申请撞唯一索引 → 500）', async () => {
      const prisma = fakePrisma();
      const service = makeService(prisma);

      await service.markFailed('payout-a', {
        reason: '渠道超时',
        failedAt: new Date(),
      });

      expect(prisma.tx()!.payoutEntry.deleteMany).toHaveBeenCalled();
    });

    it('⚠️ 落 FAILED 时带上「钱确定没打出去」的标记', async () => {
      const prisma = fakePrisma();
      const service = makeService(prisma);

      await service.markFailed('payout-a', {
        reason: '收款账号信息异常，本次未打款，请更新收款账户后重新申请',
        failedAt: new Date(),
        failedBeforePayout: true,
      });

      const data = argsOf(prisma.tx()!.payout.updateMany).data as {
        failedBeforePayout: boolean;
      };
      expect(data.failedBeforePayout).toBe(true);
    });

    it('⚠️ 不传时默认 false（宁可不给重试，也不能误重试）', async () => {
      const prisma = fakePrisma();
      const service = makeService(prisma);

      await service.markFailed('payout-a', {
        reason: '渠道超时',
        failedAt: new Date(),
      });

      const data = argsOf(prisma.tx()!.payout.updateMany).data as {
        failedBeforePayout: boolean;
      };
      expect(data.failedBeforePayout).toBe(false);
    });
  });

  describe('scheduleRetry', () => {
    it('PROCESSING → APPROVED，清空 processingAt，不重置 attemptCount', async () => {
      const prisma = fakePrisma({
        payout: { kind: 'NORMAL', statementId: 'stmt-a', attemptCount: 2 },
      });
      const service = makeService(prisma);

      const attemptCount = await service.scheduleRetry('payout-a', {
        now: new Date(),
        reason: '渠道超时',
      });

      expect(attemptCount).toBe(2);
      const data = argsOf(prisma.tx()!.payout.updateMany).data as {
        status: string;
        processingAt: Date | null;
        failureReason: string;
      };
      expect(data.status).toBe(PayoutStatus.APPROVED);
      // ⚠️ **必须清空 processingAt** —— 不清的话兜底扫描会把它当卡住的单
      expect(data.processingAt).toBeNull();
      expect(data.failureReason).toBe('渠道超时');
    });

    it('条件更新影响 0 行 → 返回 null（不重试）', async () => {
      const prisma = fakePrisma({ updateManyCount: 0 });
      const service = makeService(prisma);

      const attemptCount = await service.scheduleRetry('payout-a', {
        now: new Date(),
        reason: '渠道超时',
      });

      expect(attemptCount).toBeNull();
    });

    it('⚠️ 读不到行 → 返回 null（不是 0）', async () => {
      // ⚠️ **返回 0 是危险的**：调用方会拿 `0` 算出 `delay = 0`
      //    并入队 `payout-{id}-0` → **立即重投**（绕过退避）→ 抢跑重试预算。
      const prisma = fakePrisma({ payout: null });
      const service = makeService(prisma);

      const attemptCount = await service.scheduleRetry('payout-a', {
        now: new Date(),
        reason: '渠道超时',
      });

      expect(attemptCount).toBeNull();
      expect(attemptCount).not.toBe(0);
    });
  });

  describe('markStuckLogged', () => {
    it('空数组 → 直接返回 0，不查库', async () => {
      const prisma = fakePrisma();
      const service = makeService(prisma);

      expect(await service.markStuckLogged([], new Date())).toBe(0);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.payout.updateMany).not.toHaveBeenCalled();
    });

    it('只写 stuckLoggedAt，不改状态、不入队', async () => {
      const prisma = fakePrisma();
      const service = makeService(prisma);
      const now = new Date('2025-08-20T00:00:00.000Z');

      const count = await service.markStuckLogged(
        ['payout-a', 'payout-b'],
        now,
      );

      expect(count).toBe(1);
      const args = argsOf(prisma.payout.updateMany) as {
        where: { id: { in: string[] }; status: string };
        data: Record<string, unknown>;
      };
      expect(args.where.id.in).toEqual(['payout-a', 'payout-b']);
      expect(args.where.status).toBe(PayoutStatus.PROCESSING);
      // ⚠️ **只写 stuckLoggedAt** —— 卡住的单绝不自动重试（设计 §九·R3）
      expect(Object.keys(args.data)).toEqual(['stuckLoggedAt']);
      expect(args.data.stuckLoggedAt).toBe(now);
    });
  });

  describe('scanStuck', () => {
    it('PROCESSING 卡死 → 只写 stuckLoggedAt，绝不改状态', async () => {
      const prisma = fakePrisma({
        findManyResults: [
          [{ id: 'payout-a', payoutNo: 'PAY1', attemptCount: 1 }],
          [],
        ],
      });
      const service = makeService(prisma);
      const now = new Date('2025-08-20T00:00:00.000Z');

      const rescues = await service.scanStuck(now);

      // ⚠️ **PROCESSING 的单不进返回值** —— 绝不自动重试（设计 §九·R3）
      expect(rescues).toEqual([]);
      expect(prisma.payout.updateMany).toHaveBeenCalled();
      const args = argsOf(prisma.payout.updateMany) as {
        where: { id: { in: string[] }; status: string };
        data: Record<string, unknown>;
      };
      expect(args.where.id.in).toEqual(['payout-a']);
      expect(args.where.status).toBe(PayoutStatus.PROCESSING);
      expect(Object.keys(args.data)).toEqual(['stuckLoggedAt']);
    });

    it('APPROVED 卡死 → 返回 id 与 attemptCount（供重新入队）', async () => {
      const prisma = fakePrisma({
        // ⚠️ **`attemptCount` 必须是 0** —— 新判据只捞「从未被执行过」的单
        //    （`attemptCount = 0`）；`> 0` 的单正在退避等待重试，不能捞。
        findManyResults: [[], [{ id: 'payout-b', attemptCount: 0 }]],
      });
      const service = makeService(prisma);

      const rescues = await service.scanStuck(new Date());

      expect(rescues).toEqual([{ id: 'payout-b', attemptCount: 0 }]);
    });

    it('⚠️ attemptCount > 0 的 APPROVED 单（正在退避等重试）不被救援', async () => {
      // ⚠️ **救回来会与重试 job 抢跑**：
      //    救援 jobId（`payout-{id}-rescue-{n}`）与重试 jobId（`payout-{id}-{n}`）
      //    是不同命名空间 → BullMQ 不去重 → 两个 job 抢同一张单 →
      //    本该按 30s / 60s 退避打完的 3 次预算几秒内被烧完。
      const prisma = fakePrisma({
        findManyResults: [
          [],
          // ⚠️ **退避中的单**：`attemptCount = 1` → 查询条件带 `attemptCount: 0`
          //    → 真实 Prisma 根本不会返回它（这里只验查询条件）
          [{ id: 'payout-c', attemptCount: 1 }],
        ],
      });
      const service = makeService(prisma);

      const rescues = await service.scanStuck(new Date());

      // ⚠️ **判据在 `where` 里** —— 假 Prisma 不按 where 过滤，
      //    所以这里断言的是**查询条件**（见下一条用例）
      expect(rescues).toEqual([{ id: 'payout-c', attemptCount: 1 }]);

      const calls = prisma.payout.findMany.mock.calls as unknown[][];
      const approvedArgs = (calls[1]?.[0] ?? {}) as {
        where: { status: string; attemptCount: number };
      };
      // ⚠️ **必须带 `attemptCount: 0`** —— 否则退避中的单会被捞出来
      expect(approvedArgs.where.attemptCount).toBe(0);
    });

    it('APPROVED 的查询条件：状态 APPROVED + approvedAt 早于阈值', async () => {
      const prisma = fakePrisma({ findManyResults: [[], []] });
      const service = makeService(prisma);
      const now = new Date('2025-08-20T00:00:00.000Z');

      await service.scanStuck(now, 60_000);

      const calls = prisma.payout.findMany.mock.calls as unknown[][];
      // ⚠️ **两次 findMany 的顺序**：① PROCESSING、② APPROVED
      const approvedArgs = (calls[1]?.[0] ?? {}) as {
        where: { status: string; approvedAt: { lt: Date } };
      };
      expect(approvedArgs.where.status).toBe(PayoutStatus.APPROVED);
      expect(approvedArgs.where.approvedAt.lt.getTime()).toBe(
        now.getTime() - 60_000,
      );
    });

    it('PROCESSING 的查询条件：只捞还没告警过的', async () => {
      const prisma = fakePrisma({ findManyResults: [[], []] });
      const service = makeService(prisma);

      await service.scanStuck(new Date());

      const calls = prisma.payout.findMany.mock.calls as unknown[][];
      const processingArgs = (calls[0]?.[0] ?? {}) as {
        where: {
          status: string;
          stuckLoggedAt: null;
          processingAt: { lt: Date };
        };
      };
      expect(processingArgs.where.status).toBe(PayoutStatus.PROCESSING);
      expect(processingArgs.where.stuckLoggedAt).toBeNull();
    });

    it('两类都不卡 → 返回空数组，不写库', async () => {
      const prisma = fakePrisma({ findManyResults: [[], []] });
      const service = makeService(prisma);

      expect(await service.scanStuck(new Date())).toEqual([]);
      expect(prisma.payout.updateMany).not.toHaveBeenCalled();
    });
  });
});
