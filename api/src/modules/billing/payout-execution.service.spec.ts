import { ConflictException, Logger } from '@nestjs/common';
import { PayoutStatus, SettlementStatus } from '@prisma/client';
import { PayoutExecutionService } from './payout-execution.service';
import { PayoutCipherService } from './payout-cipher.service';
import type { PayoutVerificationTarget } from '../../common/payment/payout-verification';
import type { PayoutProviderRegistry } from '../../common/payment/payout-provider.registry';

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

/**
 * 取事务里 `payout.updateMany` 写下的 **`releasedEntryIds`**（阶段 5m）。
 *
 * ⚠️ **不能用 `argsOf`** —— 它取的是**第一次**调用，而 `releasedEntryIds`
 *    写在**第二次**（第一次是改状态）。这里按字段找那次调用。
 *
 * ⚠️ **找不到就返回 `undefined`** —— 调用方据此断言「一条都没写」。
 */
function releasedEntryIdsData(tx: {
  payout: { updateMany: { mock: { calls: unknown[][] } } };
}): string | undefined {
  for (const call of tx.payout.updateMany.mock.calls) {
    const data = (call[0] as { data?: Record<string, unknown> } | undefined)
      ?.data;
    if (data && 'releasedEntryIds' in data) {
      return data.releasedEntryIds as string;
    }
  }
  return undefined;
}

/** 事务客户端的形状（只列本服务真正用到的那几个方法） */
interface FakeTx {
  payout: {
    updateMany: jest.Mock;
    findFirst: jest.Mock;
  };
  payoutEntry: {
    deleteMany: jest.Mock;
    findMany: jest.Mock;
    createMany: jest.Mock;
  };
  settlementStatement: { updateMany: jest.Mock };
  payoutOperation: { create: jest.Mock };
  /** ⚠️ **阶段 6a：抢单时读商家偏好渠道**（在事务里，与抢单同一快照） */
  merchantPayoutAccount: { findFirst: jest.Mock };
}

/**
 * B 类人工处置的**默认出款单行**（顶层 `payout.findFirst` 的返回值）。
 *
 * ⚠️ **各项自洽** —— 闸 ② 会校验「明细金额合计 == receiptAmount」
 *    与「笔数 == entryCount」与「净额 == 货款 − 佣金」，
 *    默认值不满足这些恒等式的话，所有用例都会卡在闸 ② 后面都走不到。
 */
function defaultTopPayout() {
  return {
    id: 'payout-a',
    tenantId: 'tenant-a',
    payoutNo: 'PAY202508200000000001',
    status: PayoutStatus.FAILED,
    kind: 'NORMAL',
    statementId: 'stmt-a',
    releasedEntryIds: JSON.stringify(['entry-1', 'entry-2']),
    receiptAmount: 10000,
    commissionAmount: 500,
    netAmount: 9500,
    entryCount: 2,
    payoutChannel: 'fake-payout',
    payoutTxnId: 'txn-1',
    attemptCount: 3,
    periodStart: new Date('2025-08-01T00:00:00.000Z'),
  };
}

/** 一只最小可用的假 Prisma */
function fakePrisma(
  options: {
    updateManyCount?: number;
    /**
     * **顶层** `payout.updateMany` 返回的 `count`（阶段 5m 技术债）。
     *
     * ⚠️ **与 `updateManyCount` 是两回事** —— 后者管的是**事务里**的
     *    `tx.payout.updateMany`；`recordChannel` 不走事务，用的是顶层的。
     */
    topUpdateManyCount?: number;
    payout?: unknown;
    statementCount?: number;
    /** `scanStuck` 的两次 `findMany` 的返回（① PROCESSING、② APPROVED） */
    findManyResults?: unknown[][];
    /**
     * 事务里 `payoutEntry.findMany` 返回的**被释放的流水 id**（阶段 5m）。
     *
     * ⚠️ **默认空数组** —— 没有明细可释放时不该写 `releasedEntryIds`
     *    （空数组 ≠ null，语义不同：空数组意味着「当初就没有明细」）。
     */
    releasedEntryIds?: string[];
    /**
     * 顶层 `payout.findFirst` 返回的**出款单行**（B 类人工处置用，阶段 5m）。
     *
     * ⚠️ **与事务里的 `tx.payout.findFirst` 是两回事** ——
     *    B 类处置读的是顶层 `this.prisma.payout.findFirst`。
     */
    topPayout?: unknown;
    /** 顶层 `merchantReceipt.findMany` 返回的流水（闸 ② 的金额校验用） */
    receipts?: Array<{ id: string; amount: number }>;
    /** 顶层 `settlementStatement.findFirst` 返回的结算单（闸 ④ 的状态检查用） */
    statement?: { status: string } | null;
    /** 顶层 `payoutEntry.findMany` 返回的占用明细（闸 ③ 用） */
    occupiedEntries?: unknown[];
    /** 顶层 `merchantPayoutAccount.findFirst` 返回的商家偏好渠道行（阶段 6a） */
    preferredAccount?: { preferredChannel: string | null } | null;
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
          /**
           * ⚠️ **阶段 5m：删明细前先读出被释放的流水 id**（`markFailed`）——
           *    记到 `payouts.releasedEntryIds`，后面的「人工确认渠道已打款」
           *    靠它复原明细。
           *
           * ⚠️ **返回带 `entryId` 的对象数组**（不是 id 数组）——
           *    实现里是 `releasedEntries.map((e) => e.entryId)`。
           */
          findMany: jest.fn<Promise<unknown>, [unknown]>(() =>
            Promise.resolve(
              (options.releasedEntryIds ?? []).map((entryId) => ({ entryId })),
            ),
          ),
          /**
           * ⚠️ **B 类人工处置用** —— 复原明细。
           *    事务对象必须**齐备**：缺一个方法就是 TypeError。
           */
          createMany: jest.fn<Promise<{ count: number }>, [unknown]>(() =>
            Promise.resolve({ count: 1 }),
          ),
        },
        settlementStatement: {
          updateMany: jest.fn<Promise<{ count: number }>, [unknown]>(() =>
            Promise.resolve({ count: options.statementCount ?? 1 }),
          ),
        },
        // ⚠️ **阶段 6a：抢单事务里读商家偏好渠道**
        merchantPayoutAccount: {
          findFirst: jest.fn<Promise<unknown>, [unknown]>(() =>
            Promise.resolve(
              options.preferredAccount === undefined
                ? null
                : options.preferredAccount,
            ),
          ),
        },
        // ⚠️ **B 类人工处置用** —— 写留痕（`payoutOperation.create`）。
        payoutOperation: {
          create: jest.fn<Promise<unknown>, [unknown]>(() =>
            Promise.resolve({ id: 'op-1' }),
          ),
        },
      };
      return fn(tx);
    }),
    // ⚠️ **顶层 `payout`** —— 只有 `markStuckLogged`、`scanStuck`、
    //    `recordChannel` 用它（不走事务）
    payout: {
      updateMany: jest.fn<Promise<{ count: number }>, [unknown]>(() =>
        Promise.resolve({ count: options.topUpdateManyCount ?? 1 }),
      ),
      // ⚠️ **按调用次序返回不同的结果** —— `scanStuck` 连着查两次
      //    （① PROCESSING、② APPROVED），配置驱动要能区分这两次
      findMany: jest.fn<Promise<unknown[]>, [unknown]>(() => {
        const result = options.findManyResults?.[findManySeq] ?? [];
        findManySeq += 1;
        return Promise.resolve(result);
      }),
      /**
       * ⚠️ **B 类人工处置读的是顶层**（`this.prisma.payout.findFirst`），
       *    **不是事务里的 `tx.payout.findFirst`** —— 两个是不同的 mock。
       */
      findFirst: jest.fn<Promise<unknown>, [unknown]>(() =>
        Promise.resolve(
          options.topPayout === undefined
            ? defaultTopPayout()
            : options.topPayout,
        ),
      ),
    },
    // ⚠️ **阶段 6a：`claimForExecution` 读商家偏好渠道**（顶层，平台作用域）
    merchantPayoutAccount: {
      findFirst: jest.fn<Promise<unknown>, [unknown]>(() =>
        Promise.resolve(
          options.preferredAccount === undefined
            ? null
            : options.preferredAccount,
        ),
      ),
    },
    // ⚠️ **B 类人工处置：闸 ② 的金额校验**（顶层，不走事务）
    merchantReceipt: {
      findMany: jest.fn<Promise<unknown[]>, [unknown]>(() =>
        Promise.resolve(options.receipts ?? []),
      ),
    },
    // ⚠️ **B 类人工处置：闸 ③ 的占用检查**（顶层，`payout_entries` 不在租户白名单）
    payoutEntry: {
      findMany: jest.fn<Promise<unknown[]>, [unknown]>(() =>
        Promise.resolve(options.occupiedEntries ?? []),
      ),
    },
    // ⚠️ **B 类人工处置：闸 ④ 的结算单状态检查**（顶层，不走事务）
    settlementStatement: {
      findFirst: jest.fn<Promise<unknown>, [unknown]>(() =>
        Promise.resolve(
          options.statement === undefined
            ? { status: SettlementStatus.CONFIRMED }
            : options.statement,
        ),
      ),
    },
    // ⚠️ **数据库时钟** —— `confirmPaidAfterReconciliation` 用它取 `paidAt`
    databaseNow: jest.fn<Promise<Date>, []>(() =>
      Promise.resolve(new Date('2025-08-20T00:00:00.000Z')),
    ),
  };

  return Object.assign(prisma, { tx: () => tx });
}

/**
 * 假核实服务（阶段 5m）。
 *
 * ⚠️ **默认给「渠道说没打」**（`FAILED`）—— 老用例都不碰核实，
 *    默认值只要能让闸放行即可，老用例的行为就不变。
 *
 * ⚠️ **核实闸本身的三种结论由 e2e 验**（`test/payout-reconciliation.e2e-spec.ts`）——
 *    这里只保证老用例不被新增的闸改变行为。
 */
function fakeVerification(verdict: 'PAID' | 'FAILED' | 'UNKNOWN' = 'FAILED') {
  return {
    // ⚠️ **带参数类型** —— 用例要断言「核实对象是谁」（闸 ④ 的回归测试），
    //    参数不声明的话 `mock.calls[0][0]` 是 `undefined`，TS 直接报错。
    verify: jest.fn((target: PayoutVerificationTarget) => {
      void target;
      return Promise.resolve({ verdict, source: 'REALTIME' as const });
    }),
  };
}

/**
 * 假的出款渠道注册表（阶段 6a）。
 *
 * ⚠️ **模拟真实的 `resolveForPayout` 顺序**：已定 → 商家 → 平台 → 抛中文 409。
 *    「已启用渠道」用 `enabled` 集合控制，不在其中的渠道抛 409（与真实注册表同口径）。
 *
 * ⚠️ **阶段 6b：`get()` 返回的渠道带能力声明与 `queryPayout`** ——
 *    `scanStuck` 用 `capabilities.asyncPayout` 决定要不要轮询。
 */
function fakeRegistry(
  options: {
    enabled: string[];
    /**
     * 渠道是否声明为**异步出款**（阶段 6b）。
     *
     * ⚠️ **默认 `false`（同步）** —— 老用例的 `PROCESSING` 单按「只告警」处置，
     *    行为与阶段 6a 一致。
     */
    asyncPayout?: boolean;
    /** 渠道的 `queryPayout` 实现（默认返回 `PROCESSING`） */
    queryPayout?: jest.Mock;
  } = { enabled: [] },
) {
  const enabled = new Set(options.enabled);
  const queryPayout =
    options.queryPayout ??
    jest.fn<Promise<unknown>, [unknown]>(() =>
      Promise.resolve({ status: 'PROCESSING' }),
    );
  const get = (channel: string) => {
    if (!enabled.has(channel)) {
      throw new ConflictException(
        `出款渠道 ${channel} 未注册：请检查 PAYOUT_ENABLED_CHANNELS 与部署的渠道实现。`,
      );
    }
    return {
      channel,
      capabilities: {
        refund: false,
        asyncRefund: false,
        asyncPayout: options.asyncPayout === true,
        queryByReferenceNo: true,
        authorizedCharge: false,
        paymentMethod: false,
      },
      queryPayout,
    };
  };
  return {
    get: jest.fn(get),
    get queryPayout() {
      return queryPayout;
    },
    resolveForPayout: jest.fn(
      (input: {
        payoutChannel?: string | null;
        merchantChannel?: string | null;
        platformChannel?: string | null;
      }) => {
        const picked =
          [input.payoutChannel, input.merchantChannel, input.platformChannel]
            .map((v) => (v ?? '').trim())
            .find((v) => v.length > 0) ?? '';
        if (!picked) {
          throw new ConflictException(
            '无法确定出款渠道：商家未配置默认渠道，平台也未配置默认渠道。',
          );
        }
        return get(picked);
      },
    ),
    descriptor: jest.fn(() => null),
    list: jest.fn(() => []),
    registeredChannels: jest.fn(() => Array.from(enabled)),
  } as unknown as PayoutProviderRegistry & {
    resolveForPayout: jest.Mock;
    get: jest.Mock;
    /** ⚠️ **阶段 6b：所有渠道共用的 `queryPayout`**（用例断言「调了几次」） */
    queryPayout: jest.Mock;
  };
}

/** 假的平台设置服务（阶段 6a）—— 平台默认渠道可配置 */
function fakeSettings(channel = 'fake-payout') {
  return {
    getPayoutDefaultChannel: jest.fn(() =>
      Promise.resolve({ channel, source: 'DATABASE' as const }),
    ),
  };
}

function makeService(
  prisma: ReturnType<typeof fakePrisma>,
  verification: ReturnType<typeof fakeVerification> = fakeVerification(),
  registry: ReturnType<typeof fakeRegistry> = fakeRegistry({
    enabled: ['fake-payout'],
  }),
  settings: ReturnType<typeof fakeSettings> = fakeSettings(),
): PayoutExecutionService {
  return new PayoutExecutionService(
    prisma as unknown as never,
    new PayoutCipherService(),
    verification,
    registry,
    settings as never,
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
          attemptCount: 0,
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

    it('⚠️ 新一次执行清掉上一次的 stuckLoggedAt（否则永不再被轮询）', async () => {
      const prisma = fakePrisma();
      const service = makeService(prisma);

      await service.claimForExecution('payout-a', new Date());

      const data = argsOf(prisma.tx()!.payout.updateMany).data as {
        stuckLoggedAt?: unknown;
        status: string;
      };
      expect(data.status).toBe(PayoutStatus.PROCESSING);
      // ⚠️ **`scanStuck` 只捞 `stuckLoggedAt: null`** —— 上一次执行留下的
      //    告警标记不清掉，这张单重试后再卡住就永远不会被轮询。
      expect(data.stuckLoggedAt).toBeNull();
    });

    it('⚠️ 新单：商家配置了偏好渠道 → 解析出该渠道，与状态改 PROCESSING 同一个 updateMany', async () => {
      const prisma = fakePrisma({
        payout: { attemptCount: 0, netAmount: 8500, payoutNo: 'PAY1' },
        preferredAccount: { preferredChannel: 'channel-a' },
      });
      const registry = fakeRegistry({ enabled: ['channel-a', 'fake-payout'] });
      const settings = fakeSettings('fake-payout');
      const service = makeService(
        prisma,
        fakeVerification(),
        registry,
        settings,
      );

      const claim = await service.claimForExecution('payout-a', new Date());

      expect(claim!.channel).toBe('channel-a');
      expect(claim!.channelError).toBeNull();
      // ⚠️ **商家优先于平台默认** —— resolveForPayout 的顺序：单 > 商家 > 平台
      // ⚠️ 假注册表按 Mock 断言（属性形态），不受 unbound-method 约束
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(registry.resolveForPayout).toHaveBeenCalledWith({
        payoutChannel: null,
        merchantChannel: 'channel-a',
        platformChannel: null,
      });
      // ⚠️ **商家配了就不该再去读平台默认** —— 平台配置缺失不该连坐这张单

      expect(settings.getPayoutDefaultChannel).not.toHaveBeenCalled();
      // ⚠️ **解析结果与状态改 PROCESSING 同一次 updateMany** ——
      //    分开写会出现「单子进 PROCESSING、渠道还没解析」的窗口
      const data = argsOf(prisma.tx()!.payout.updateMany).data as {
        status: string;
        payoutChannel: string | null;
      };
      expect(data.status).toBe(PayoutStatus.PROCESSING);
      expect(data.payoutChannel).toBe('channel-a');
    });

    it('⚠️ 新单：商家没配 → 用平台默认渠道', async () => {
      const prisma = fakePrisma({
        payout: { attemptCount: 0, netAmount: 8500, payoutNo: 'PAY1' },
        preferredAccount: { preferredChannel: null },
      });
      const registry = fakeRegistry({ enabled: ['channel-b', 'fake-payout'] });
      const settings = fakeSettings('channel-b');
      const service = makeService(
        prisma,
        fakeVerification(),
        registry,
        settings,
      );

      const claim = await service.claimForExecution('payout-a', new Date());

      expect(claim!.channel).toBe('channel-b');
      expect(claim!.channelError).toBeNull();
      // ⚠️ 假注册表按 Mock 断言（属性形态），不受 unbound-method 约束
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(registry.resolveForPayout).toHaveBeenCalledWith({
        payoutChannel: null,
        merchantChannel: null,
        platformChannel: 'channel-b',
      });
    });

    it('⚠️ 新单：商家配置与平台默认都没 → channel=null + 中文 channelError，不抛异常', async () => {
      const prisma = fakePrisma({
        payout: { attemptCount: 0, netAmount: 8500, payoutNo: 'PAY1' },
        preferredAccount: { preferredChannel: null },
      });
      const registry = fakeRegistry({ enabled: [] });
      const settings = fakeSettings();
      settings.getPayoutDefaultChannel.mockRejectedValue(
        new ConflictException(
          '平台未配置默认出款渠道：请在超管后台设置，或配置环境变量 PAYOUT_PLATFORM_DEFAULT_CHANNEL。',
        ),
      );
      const service = makeService(
        prisma,
        fakeVerification(),
        registry,
        settings,
      );

      // ⚠️ **绝不能抛** —— 抛错会回滚事务，单子停在 `APPROVED`，
      //    而 `markFailed` 只接受 `PROCESSING` → 单子永远卡在那里，
      //    兜底扫描每 5 分钟把它重新入队一次（无限重投）。
      const claim = await service.claimForExecution('payout-a', new Date());

      expect(claim).not.toBeNull();
      expect(claim!.channel).toBeNull();
      expect(claim!.channelError).toContain('平台未配置默认出款渠道');
    });

    it('⚠️ 新单：商家配了渠道、平台默认未配置 → 仍能解析（平台配置缺失不连坐）', async () => {
      // ⚠️ **只会发生在「商家已明确配置」的单上** —— 平台默认渠道读到没配
      //    时应该抛错，但那是「需要兜底」的场景；商家已经给了渠道，
      //    就不该因为平台配置缺失把这张单打成 FAILED。
      const prisma = fakePrisma({
        payout: { attemptCount: 0, netAmount: 8500, payoutNo: 'PAY1' },
        preferredAccount: { preferredChannel: 'channel-a' },
      });
      const registry = fakeRegistry({ enabled: ['channel-a'] });
      const settings = fakeSettings();
      settings.getPayoutDefaultChannel.mockRejectedValue(
        new ConflictException('平台未配置默认出款渠道'),
      );
      const service = makeService(
        prisma,
        fakeVerification(),
        registry,
        settings,
      );

      const claim = await service.claimForExecution('payout-a', new Date());

      expect(claim!.channel).toBe('channel-a');
      expect(claim!.channelError).toBeNull();

      expect(settings.getPayoutDefaultChannel).not.toHaveBeenCalled();
    });

    it('⚠️ 新单：商家配置已停用 → channelError 带可读原因（不静默回落平台默认）', async () => {
      // ⚠️ **fail-closed，绝不静默切到平台默认** —— 钱打到哪家必须确定。
      const prisma = fakePrisma({
        payout: { attemptCount: 0, netAmount: 8500, payoutNo: 'PAY1' },
        preferredAccount: { preferredChannel: 'channel-x' },
      });
      const registry = fakeRegistry({ enabled: ['channel-b'] });
      const settings = fakeSettings('channel-b');
      const service = makeService(
        prisma,
        fakeVerification(),
        registry,
        settings,
      );

      const claim = await service.claimForExecution('payout-a', new Date());

      expect(claim!.channel).toBeNull();
      expect(claim!.channelError).toContain('channel-x');
      expect(claim!.channelError).toContain('未注册');
      // ⚠️ **回落了平台默认** 的话，resolveForPayout 里的 merchantChannel 仍是 channel-x
      // ⚠️ 假注册表按 Mock 断言（属性形态），不受 unbound-method 约束
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(registry.resolveForPayout).toHaveBeenCalledWith({
        payoutChannel: null,
        merchantChannel: 'channel-x',
        platformChannel: null,
      });
    });

    it('⚠️ 已有 payoutChannel 的重试：直接沿用，不重查商家偏好与平台默认', async () => {
      const prisma = fakePrisma({
        payout: {
          attemptCount: 1,
          netAmount: 8500,
          payoutNo: 'PAY1',
          payoutChannel: 'channel-a',
        },
      });
      const registry = fakeRegistry({ enabled: ['channel-a', 'fake-payout'] });
      const settings = fakeSettings('fake-payout');
      const service = makeService(
        prisma,
        fakeVerification(),
        registry,
        settings,
      );

      const claim = await service.claimForExecution('payout-a', new Date());

      // ⚠️ **重试不换渠道** —— 上一次已经写进 `payouts.payoutChannel` 的那家
      expect(claim!.channel).toBe('channel-a');
      // ⚠️ 假注册表按 Mock 断言（属性形态），不受 unbound-method 约束
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(registry.resolveForPayout).toHaveBeenCalledWith({
        payoutChannel: 'channel-a',
        merchantChannel: null,
        platformChannel: null,
      });
      // ⚠️ **不重读默认渠道** —— 重试必须按单子上已有的渠道打
      expect(settings.getPayoutDefaultChannel).not.toHaveBeenCalled();
      // ⚠️ **商家的 `preferredChannel` 不参与**（`account` 为 null 表示没读）
      expect(
        prisma.tx()!.merchantPayoutAccount.findFirst,
      ).not.toHaveBeenCalled();
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
          attemptCount: 0,
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
          attemptCount: 0,
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
          attemptCount: 0,
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

  describe('claimForExecution 的渠道解析落库', () => {
    it('⚠️ 解析出的渠道写进 payoutChannel（与状态改 PROCESSING 同一个 updateMany）', async () => {
      const prisma = fakePrisma();
      const registry = fakeRegistry({ enabled: ['channel-a'] });
      const service = makeService(
        prisma,
        fakeVerification(),
        registry,
        fakeSettings('channel-a'),
      );

      await service.claimForExecution('payout-a', new Date());

      const data = argsOf(prisma.tx()!.payout.updateMany).data as {
        status: string;
        payoutChannel: string | null;
      };
      expect(data.status).toBe(PayoutStatus.PROCESSING);
      expect(data.payoutChannel).toBe('channel-a');
    });

    it('⚠️ 解析失败时不写 payoutChannel（只改状态），且 channelError 带中文原因', async () => {
      const prisma = fakePrisma({
        preferredAccount: { preferredChannel: null },
      });
      const registry = fakeRegistry({ enabled: [] });
      const settings = fakeSettings();
      settings.getPayoutDefaultChannel.mockRejectedValue(
        new ConflictException('平台未配置默认出款渠道'),
      );
      const service = makeService(
        prisma,
        fakeVerification(),
        registry,
        settings,
      );

      const claim = await service.claimForExecution('payout-a', new Date());

      expect(claim).not.toBeNull();
      expect(claim!.channel).toBeNull();
      expect(claim!.channelError).toContain('平台未配置默认出款渠道');
      const data = argsOf(prisma.tx()!.payout.updateMany).data as {
        status: string;
        payoutChannel: string | null;
      };
      // ⚠️ **失败时不写渠道名** —— 连 `payoutChannel: null` 都不写，
      //    避免把已有值覆盖掉（重试不换渠道的依据）
      expect(data).not.toHaveProperty('payoutChannel');
    });

    it('⚠️ 商家的偏好渠道查询必须显式带 tenantId（平台作用域下不会被自动过滤）', async () => {
      // ⚠️ **同 `confirmPaidAfterReconciliation` 的同一类坑**：
      //    `MerchantPayoutAccount` 在租户白名单里，但本服务跑在**平台作用域**
      //    → 租户扩展**不附加任何过滤** → 不显式带 `tenantId` 就是跨租户读。
      const prisma = fakePrisma({
        payout: {
          attemptCount: 0,
          netAmount: 8500,
          payoutNo: 'PAY1',
          tenantId: 'tenant-a',
        },
      });
      const registry = fakeRegistry({ enabled: ['channel-a', 'fake-payout'] });
      const service = makeService(
        prisma,
        fakeVerification(),
        registry,
        fakeSettings('fake-payout'),
      );

      await service.claimForExecution('payout-a', new Date());

      const where = argsOf(prisma.tx()!.merchantPayoutAccount.findFirst)
        .where as {
        tenantId?: string;
      };
      expect(where.tenantId).toBe('tenant-a');
    });
  });

  describe('recordChannel', () => {
    it('只写 payoutChannel 一个字段，且带 PROCESSING 守卫', async () => {
      const prisma = fakePrisma();
      const service = makeService(prisma);

      await service.recordChannel('payout-a', 'fake-payout');

      const args = argsOf(prisma.payout.updateMany) as {
        where: { id: string; status: string };
        data: Record<string, unknown>;
      };
      expect(args.where.id).toBe('payout-a');
      // ⚠️ **守卫必须在** —— 状态已被对账纠正 / 人工处置改过时不该误写
      expect(args.where.status).toBe(PayoutStatus.PROCESSING);
      // ⚠️ **只写一个字段** —— 不碰状态、不碰 attemptCount
      expect(Object.keys(args.data)).toEqual(['payoutChannel']);
      expect(args.data.payoutChannel).toBe('fake-payout');
    });

    it('⚠️ 条件更新影响 0 行 → 不抛异常，只记 warn', async () => {
      // ⚠️ **不抛** —— 状态已被别人改过不是错误，只是「渠道名没记上」。
      //    抛出去会让 worker 的 catch 分支把原因记成「数据库故障」，掩盖真相。
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      try {
        const prisma = fakePrisma({ topUpdateManyCount: 0 });
        const service = makeService(prisma);

        await expect(
          service.recordChannel('payout-a', 'fake-payout'),
        ).resolves.toBeUndefined();

        // ⚠️ **日志不能丢** —— 状态已被改过时静默无写入会让问题查不出来
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('payout-a'),
        );
      } finally {
        warnSpy.mockRestore();
      }
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

    /**
     * ⚠️ **失败时刻必须被清掉** —— 这条护栏以前**没有任何测试咬住**
     *    （阶段 5m 的失败注入把 `failedAt: null` 删掉，全量 627 条单测 +
     *    646 条 e2e 全绿）。
     *
     * ⚠️ **为什么重要** —— `failedAt` 记的是「落 FAILED 那一刻」的判断。
     *    残留着它，一张**已经 PAID** 的单会被对账引擎按 `failedAt` 再次捞进
     *    另一个时间窗（引擎按 `paidAt` / `processingAt` / `failedAt` 三个
     *    时间戳捞本地单）→ 造出假差异，或让 E 类（本地已付、渠道查不到）
     *    的口径判错。
     */
    it('重试成功后清掉失败时刻与「钱没打出去」的标记', async () => {
      const prisma = fakePrisma({
        payout: { kind: 'NORMAL', statementId: 'stmt-a', attemptCount: 2 },
      });
      const service = makeService(prisma);

      await service.markPaid('payout-a', {
        providerTxnId: 'txn-1',
        channel: 'fake-payout',
        paidAt: new Date('2025-08-20T00:00:00.000Z'),
      });

      const data = argsOf(prisma.tx()!.payout.updateMany).data as {
        failedAt: Date | null;
        failedBeforePayout: boolean;
      };
      expect(data.failedAt).toBeNull();
      expect(data.failedBeforePayout).toBe(false);
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
      const prisma = fakePrisma({ releasedEntryIds: ['entry-1', 'entry-2'] });
      const service = makeService(prisma);

      await service.markFailed('payout-a', {
        reason: '渠道超时',
        failedAt: new Date(),
      });

      expect(prisma.tx()!.payoutEntry.deleteMany).toHaveBeenCalled();
      // ⚠️ **阶段 5m：被释放的流水 id 要记进 `releasedEntryIds`** ——
      //    后面的「人工确认渠道已打款」靠它复原明细，不记就永远复原不了
      expect(prisma.tx()!.payoutEntry.findMany).toHaveBeenCalledWith({
        where: { payoutId: 'payout-a' },
        select: { entryId: true },
      });
      expect(releasedEntryIdsData(prisma.tx()!)).toBe(
        JSON.stringify(['entry-1', 'entry-2']),
      );
    });

    it('⚠️ 没有明细可释放时，绝不写 `releasedEntryIds`（空数组 ≠ null）', async () => {
      // ⚠️ **空数组的语义是「当初就没有明细」**（与 null 不同）→
      //    B 类处置会据此误判「可复原」→ 这里必须一条都不写
      const prisma = fakePrisma();
      const service = makeService(prisma);

      await service.markFailed('payout-a', {
        reason: '渠道超时',
        failedAt: new Date(),
      });

      expect(releasedEntryIdsData(prisma.tx()!)).toBeUndefined();
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

  describe('scanStuck 轮询异步渠道（阶段 6b）', () => {
    /** 一张卡住的 `PROCESSING` 单（`findMany` 第 ① 次返回） */
    function stuckRow(overrides: Record<string, unknown> = {}) {
      return {
        id: 'payout-a',
        payoutNo: 'PAY1',
        attemptCount: 1,
        payoutChannel: 'channel-a',
        // ⚠️ **补记已付款前要核对金额** —— 与下面渠道回报的 8500 一致
        netAmount: 8500,
        ...overrides,
      };
    }

    /** 让两张查询（① PROCESSING、② APPROVED）都只返回给定的一批 PROCESSING 单 */
    function findManyWith(stuck: unknown[]) {
      return {
        findManyResults: ([] as unknown[][]).concat([stuck, []]),
      };
    }

    it('⚠️ 渠道说 SUCCESS → 单子变 PAID，写 paidAt / payoutTxnId / payoutChannel', async () => {
      const prisma = fakePrisma(findManyWith([stuckRow()]));
      const dbNow = new Date('2025-08-20T00:00:00.000Z');
      prisma.databaseNow.mockResolvedValue(dbNow);
      const queryPayout = jest.fn(() =>
        Promise.resolve({
          status: 'SUCCESS' as const,
          providerTxnId: 'txn-9',
          amount: 8500,
          paidAt: new Date('2025-08-19T23:00:00.000Z'),
        }),
      );
      const registry = fakeRegistry({
        enabled: ['channel-a'],
        asyncPayout: true,
        queryPayout,
      });
      const service = makeService(
        prisma,
        fakeVerification(),
        registry,
        fakeSettings('channel-a'),
      );

      const rescues = await service.scanStuck(new Date());

      // ⚠️ **PROCESSING 的单不进返回值** —— 绝不自动重试（设计 §九·R3）
      expect(rescues).toEqual([]);
      // ⚠️ **用 referenceNo（payoutNo）查** —— PROCESSING 的单没有 payoutTxnId
      expect(queryPayout).toHaveBeenCalledWith({ referenceNo: 'PAY1' });
      const data = argsOf(prisma.tx()!.payout.updateMany).data as {
        status: string;
        paidAt: Date;
        payoutTxnId: string;
        payoutChannel: string;
      };
      expect(data.status).toBe(PayoutStatus.PAID);
      // ⚠️ **落库时刻用数据库时钟**，不是渠道返回的时刻，也不是 `new Date()`
      expect(data.paidAt).toBe(dbNow);
      expect(data.payoutTxnId).toBe('txn-9');
      expect(data.payoutChannel).toBe('channel-a');
      // ⚠️ **已补记账，不再去写 stuckLoggedAt**
      expect(prisma.payout.updateMany).not.toHaveBeenCalled();
    });

    it('⚠️ 渠道说 SUCCESS 但金额与出款单不一致 → FAILED 且禁止自动重试', async () => {
      const prisma = fakePrisma(findManyWith([stuckRow()]));
      prisma.databaseNow.mockResolvedValue(
        new Date('2025-08-20T00:00:00.000Z'),
      );
      const queryPayout = jest.fn(() =>
        Promise.resolve({
          status: 'SUCCESS' as const,
          providerTxnId: 'txn-9',
          // ⚠️ 应付出款净额是 8500，渠道只报了 8000
          amount: 8000,
        }),
      );
      const registry = fakeRegistry({
        enabled: ['channel-a'],
        asyncPayout: true,
        queryPayout,
      });
      const service = makeService(
        prisma,
        fakeVerification(),
        registry,
        fakeSettings('channel-a'),
      );

      await service.scanStuck(new Date());

      const data = argsOf(prisma.tx()!.payout.updateMany).data as {
        status: string;
        failedBeforePayout: boolean;
        failureReason: string;
      };
      expect(data.status).toBe(PayoutStatus.FAILED);
      // ⚠️ **钱可能已经出去了** —— 绝不能允许运营一键重试（会重复打款）
      expect(data.failedBeforePayout).toBe(false);
      expect(data.failureReason).toMatch(/金额与出款单不一致/);
    });

    it('⚠️ 渠道说 FAILED 且 definitive=true → FAILED + failedBeforePayout=true', async () => {
      const prisma = fakePrisma(findManyWith([stuckRow()]));
      const dbNow = new Date('2025-08-20T00:00:00.000Z');
      prisma.databaseNow.mockResolvedValue(dbNow);
      const queryPayout = jest.fn(() =>
        Promise.resolve({
          status: 'FAILED' as const,
          definitive: true,
          providerTxnId: 'txn-9',
          failureReason: '渠道拒付',
        }),
      );
      const registry = fakeRegistry({
        enabled: ['channel-a'],
        asyncPayout: true,
        queryPayout,
      });
      const service = makeService(
        prisma,
        fakeVerification(),
        registry,
        fakeSettings('channel-a'),
      );

      await service.scanStuck(new Date());

      const data = argsOf(prisma.tx()!.payout.updateMany).data as {
        status: string;
        failedAt: Date;
        failedBeforePayout: boolean;
        failureReason: string;
        payoutTxnId: string;
      };
      expect(data.status).toBe(PayoutStatus.FAILED);
      // ⚠️ **钱确定没打出去 → 可安全重试**
      expect(data.failedBeforePayout).toBe(true);
      expect(data.failedAt).toBe(dbNow);
      expect(data.failureReason).toContain('渠道拒付');
      // ⚠️ **渠道给了交易号就要存**（事后去渠道定位靠它）
      expect(data.payoutTxnId).toBe('txn-9');
      expect(prisma.payout.updateMany).not.toHaveBeenCalled();
    });

    it('⚠️⚠️ 渠道说 FAILED 但 definitive=false → 状态不变，且**不写** stuckLoggedAt（下一轮继续问）', async () => {
      // ⚠️ **「结果未知」落 FAILED = 运营以为可以重试 → 重复打款**
      const prisma = fakePrisma(findManyWith([stuckRow()]));
      const queryPayout = jest.fn(() =>
        Promise.resolve({ status: 'FAILED' as const, definitive: false }),
      );
      const registry = fakeRegistry({
        enabled: ['channel-a'],
        asyncPayout: true,
        queryPayout,
      });
      const service = makeService(
        prisma,
        fakeVerification(),
        registry,
        fakeSettings('channel-a'),
      );

      await service.scanStuck(new Date());

      // ⚠️ **绝不碰状态机** —— 不写 PAID、不写 FAILED
      expect(prisma.$transaction).not.toHaveBeenCalled();
      // ⚠️ **也不能写 stuckLoggedAt** —— `scanStuck` 只捞 `stuckLoggedAt: null`
      //    的单，写了就等于「以后再也不问这张单」；异步渠道的中间态必须继续轮询。
      expect(prisma.payout.updateMany).not.toHaveBeenCalled();
    });

    it('⚠️ 渠道说 UNKNOWN → 状态不变，且不写 stuckLoggedAt（下一轮继续问）', async () => {
      const prisma = fakePrisma(findManyWith([stuckRow()]));
      const queryPayout = jest.fn(() =>
        Promise.resolve({ status: 'UNKNOWN' as const }),
      );
      const registry = fakeRegistry({
        enabled: ['channel-a'],
        asyncPayout: true,
        queryPayout,
      });
      const service = makeService(
        prisma,
        fakeVerification(),
        registry,
        fakeSettings('channel-a'),
      );

      await service.scanStuck(new Date());

      expect(prisma.$transaction).not.toHaveBeenCalled();
      // 问不出结论 ≠ 不再问：保留 `stuckLoggedAt = null` 让下一轮继续轮询
      expect(prisma.payout.updateMany).not.toHaveBeenCalled();
    });

    it('⚠️ 渠道查询抛异常（超时）→ 状态不变、下一轮继续问，不中断整轮', async () => {
      const prisma = fakePrisma(
        findManyWith([
          stuckRow(),
          stuckRow({ id: 'payout-b', payoutNo: 'PAY2' }),
        ]),
      );
      const queryPayout = jest
        .fn()
        .mockRejectedValueOnce(new Error('渠道超时'))
        .mockResolvedValueOnce({ status: 'UNKNOWN' as const });
      const registry = fakeRegistry({
        enabled: ['channel-a'],
        asyncPayout: true,
        queryPayout,
      });
      const service = makeService(
        prisma,
        fakeVerification(),
        registry,
        fakeSettings('channel-a'),
      );

      // ⚠️ **不抛** —— 第一张抛出后，第二张照样要被处理
      await expect(service.scanStuck(new Date())).resolves.toEqual([]);
      expect(queryPayout).toHaveBeenCalledTimes(2);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      // ⚠️ **两张都不写 stuckLoggedAt** —— 下一轮还要继续问；
      //    一张超时也不能连累另一张（第二张照样被问过）。
      expect(prisma.payout.updateMany).not.toHaveBeenCalled();
    });

    it('⚠️⚠️ 同步渠道（asyncPayout=false）的 PROCESSING → 不调用 queryPayout（0 次）', async () => {
      // ⚠️ **同步渠道的 submit 不会返回 PROCESSING** —— 它出现在这里是异常，
      //    去问渠道只会制造噪声；必须显式挡掉。
      const prisma = fakePrisma(findManyWith([stuckRow()]));
      const queryPayout = jest.fn(() =>
        Promise.resolve({ status: 'SUCCESS' as const, providerTxnId: 't' }),
      );
      const registry = fakeRegistry({
        enabled: ['channel-a'],
        asyncPayout: false,
        queryPayout,
      });
      const service = makeService(
        prisma,
        fakeVerification(),
        registry,
        fakeSettings('channel-a'),
      );

      await service.scanStuck(new Date());

      expect(queryPayout).toHaveBeenCalledTimes(0);
      const args = argsOf(prisma.payout.updateMany) as {
        data: Record<string, unknown>;
      };
      expect(Object.keys(args.data)).toEqual(['stuckLoggedAt']);
    });

    it('单轮超过 50 张 → 只轮询 50 张', async () => {
      const rows = Array.from({ length: 60 }, (_, i) =>
        stuckRow({ id: `payout-${i}`, payoutNo: `PAY${i}` }),
      );
      const prisma = fakePrisma(findManyWith(rows));
      const queryPayout = jest.fn(() =>
        Promise.resolve({ status: 'PROCESSING' as const }),
      );
      const registry = fakeRegistry({
        enabled: ['channel-a'],
        asyncPayout: true,
        queryPayout,
      });
      const service = makeService(
        prisma,
        fakeVerification(),
        registry,
        fakeSettings('channel-a'),
      );

      await service.scanStuck(new Date());

      // ⚠️ **单轮上限 50**（设计 §6.3）—— 被截掉的单下一轮再处理
      expect(queryPayout).toHaveBeenCalledTimes(50);
      const queryArgs = argsOf(prisma.payout.findMany) as {
        take?: number;
      };
      expect(queryArgs.take).toBe(50);
    });

    it('⚠️ 单子没有 payoutChannel → 用平台默认渠道查（存量单前向兼容）', async () => {
      const prisma = fakePrisma(
        findManyWith([stuckRow({ payoutChannel: null })]),
      );
      const queryPayout = jest.fn(() =>
        Promise.resolve({ status: 'UNKNOWN' as const }),
      );
      const registry = fakeRegistry({
        enabled: ['channel-b'],
        asyncPayout: true,
        queryPayout,
      });
      const settings = fakeSettings('channel-b');
      const service = makeService(
        prisma,
        fakeVerification(),
        registry,
        settings,
      );

      await service.scanStuck(new Date());

      expect(settings.getPayoutDefaultChannel).toHaveBeenCalled();
      // ⚠️ 假注册表按 Mock 断言（属性形态），不受 unbound-method 约束
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(registry.get).toHaveBeenCalledWith('channel-b');
    });

    it('⚠️ 取不到渠道（已停用 / 未配置）→ 只记 warn，不中断整轮', async () => {
      const prisma = fakePrisma(
        findManyWith([stuckRow({ payoutChannel: 'channel-x' })]),
      );
      const registry = fakeRegistry({
        enabled: [],
        asyncPayout: true,
      });
      const service = makeService(
        prisma,
        fakeVerification(),
        registry,
        fakeSettings('channel-a'),
      );

      await expect(service.scanStuck(new Date())).resolves.toEqual([]);
      expect(registry.queryPayout).not.toHaveBeenCalled();
      // ⚠️ **取不到渠道也照样告警去重**
      const args = argsOf(prisma.payout.updateMany) as {
        data: Record<string, unknown>;
      };
      expect(Object.keys(args.data)).toEqual(['stuckLoggedAt']);
    });
  });

  describe('confirmPaidAfterReconciliation', () => {
    /** 一份「四闸全过」的默认配置 —— 各用例只覆盖自己关心的那一项 */
    function bClassOptions(overrides: Parameters<typeof fakePrisma>[0] = {}) {
      return {
        // ⚠️ **金额自洽** —— 闸 ② 要「明细合计 == receiptAmount」
        //    「笔数 == entryCount」「净额 == 货款 − 佣金」
        receipts: [
          { id: 'entry-1', amount: 6000 },
          { id: 'entry-2', amount: 4000 },
        ],
        ...overrides,
      };
    }

    it('四闸全过 → FAILED 转 PAID，复原明细并写留痕', async () => {
      const prisma = fakePrisma(bClassOptions());
      const service = makeService(prisma, fakeVerification('PAID'));

      const ok = await service.confirmPaidAfterReconciliation('payout-a', {
        reason: '渠道确认已打款',
        operatorId: 'admin-1',
      });

      expect(ok).toBe(true);
      expect(prisma.tx()!.payoutEntry.createMany).toHaveBeenCalled();
      expect(prisma.tx()!.payoutOperation.create).toHaveBeenCalled();
    });

    it('⚠️ 闸 ④ 的核实对象来自库里的 payoutNo（调用方无从替换）', async () => {
      // ⚠️ **回归测试** —— 修复前是 `input.payoutNo ?? payout.payoutNo`，
      //    调用方传别的单号就能核实别的单 → **闸 ④ 被完全绕过**。
      //    现在核实对象**只**来自库里读到的 `payout.payoutNo`。
      const prisma = fakePrisma(bClassOptions());
      const verification = fakeVerification('PAID');
      const service = makeService(prisma, verification);

      await service.confirmPaidAfterReconciliation('payout-a', {
        reason: '渠道确认已打款',
        operatorId: 'admin-1',
        // ⚠️ **传别的单号** —— 修复前它会覆盖核实对象
        ...({ payoutNo: 'PAY-OTHER-TENANT-999' } as Record<string, unknown>),
      });

      // ⚠️ **核实用的必须是本单的号** —— 不能是被替换的别的单号
      const target = verification.verify.mock.calls[0][0];
      expect(target.payoutNo).toBe('PAY202508200000000001');
      expect(target.payoutNo).not.toBe('PAY-OTHER-TENANT-999');
      expect(target.id).toBe('payout-a');
    });

    it('⚠️ 补差单确认已付款 → 结算单状态不变（护栏 X6）', async () => {
      // ⚠️ **回归测试** —— 修复前补差单也会把结算单改成 PAID。
      //    `markPaid` 里有这道护栏，B 类处置的事务里漏了。
      const prisma = fakePrisma(
        bClassOptions({
          topPayout: { ...defaultTopPayout(), kind: 'SUPPLEMENT' },
        }),
      );
      const service = makeService(prisma, fakeVerification('PAID'));

      const ok = await service.confirmPaidAfterReconciliation('payout-a', {
        reason: '渠道确认已打款',
        operatorId: 'admin-1',
      });

      expect(ok).toBe(true);
      // ⚠️ **结算单联动一次都不能发生**
      expect(
        prisma.tx()!.settlementStatement.updateMany,
      ).not.toHaveBeenCalled();
    });

    it('正常单 → 结算单 CONFIRMED → PAID', async () => {
      const prisma = fakePrisma(bClassOptions());
      const service = makeService(prisma, fakeVerification('PAID'));

      await service.confirmPaidAfterReconciliation('payout-a', {
        reason: '渠道确认已打款',
        operatorId: 'admin-1',
      });

      const data = argsOf(prisma.tx()!.settlementStatement.updateMany).data as {
        status: string;
        paidAt: Date;
      };
      expect(data.status).toBe(SettlementStatus.PAID);
      // ⚠️ **用 `getTime()` 比** —— `toBe` 比的是引用，同一时刻的两个
      //    `Date` 实例不相等 → 断言会假失败
      expect(data.paidAt.getTime()).toBe(
        new Date('2025-08-20T00:00:00.000Z').getTime(),
      );
    });

    it('⚠️ 事务内状态更新没命中 → 抛 ConflictException，不写留痕', async () => {
      // ⚠️ **回归测试** —— 修复前无视 `affected.count`：
      //    事务照样提交 → 留痕说「从 FAILED 改到 PAID」，**但状态根本没改**
      //    → 留痕会说谎。留痕是事后追责的唯一凭据，不能撒谎。
      const prisma = fakePrisma(bClassOptions({ updateManyCount: 0 }));
      const service = makeService(prisma, fakeVerification('PAID'));

      await expect(
        service.confirmPaidAfterReconciliation('payout-a', {
          reason: '渠道确认已打款',
          operatorId: 'admin-1',
        }),
      ).rejects.toBeInstanceOf(ConflictException);

      // ⚠️ **留痕绝不能写** —— 状态没改，留痕却写了就是撒谎
      expect(prisma.tx()!.payoutOperation.create).not.toHaveBeenCalled();
    });

    it('⚠️ 跨租户读被 tenantId 限制住（闸 ② 的货款流水）', async () => {
      // ⚠️ **`MerchantReceipt` 在租户白名单里，但本方法跑在平台作用域**
      //    → 租户扩展不附加任何过滤 → 不显式带 `tenantId` 就是跨租户读。
      const prisma = fakePrisma(bClassOptions());
      const service = makeService(prisma, fakeVerification('PAID'));

      await service.confirmPaidAfterReconciliation('payout-a', {
        reason: '渠道确认已打款',
        operatorId: 'admin-1',
      });

      const where = argsOf(prisma.merchantReceipt.findMany).where as {
        tenantId: string;
        id: { in: string[] };
      };
      expect(where.tenantId).toBe('tenant-a');
      expect(where.id.in).toEqual(['entry-1', 'entry-2']);
    });

    it('⚠️ 跨租户读被 tenantId 限制住（闸 ④ 的结算单）', async () => {
      // ⚠️ **`SettlementStatement` 同样在租户白名单里** → 平台作用域下
      //    扩展不附加过滤 → 不显式带 `tenantId` 就会读到别的租户的结算单
      const prisma = fakePrisma(bClassOptions());
      const service = makeService(prisma, fakeVerification('PAID'));

      await service.confirmPaidAfterReconciliation('payout-a', {
        reason: '渠道确认已打款',
        operatorId: 'admin-1',
      });

      const where = argsOf(prisma.settlementStatement.findFirst).where as {
        id: string;
        tenantId: string;
      };
      expect(where.id).toBe('stmt-a');
      expect(where.tenantId).toBe('tenant-a');
    });

    it('⚠️ 结算单联动没命中（已是 PAID）→ 不抛错，事务照常提交', async () => {
      // ⚠️ **结算单联动没命中是正常的** —— 可能已经被另一张单联动过了
      //    → 幂等，不是异常 → **不能抛**（抛了会连累出款单本身改成 PAID）。
      const prisma = fakePrisma(bClassOptions({ statementCount: 0 }));
      const service = makeService(prisma, fakeVerification('PAID'));

      const ok = await service.confirmPaidAfterReconciliation('payout-a', {
        reason: '渠道确认已打款',
        operatorId: 'admin-1',
      });

      expect(ok).toBe(true);
      expect(prisma.tx()!.payoutOperation.create).toHaveBeenCalled();
    });

    it('渠道核实不是 PAID → 拒绝，不动账', async () => {
      const prisma = fakePrisma(bClassOptions());
      const service = makeService(prisma, fakeVerification('FAILED'));

      await expect(
        service.confirmPaidAfterReconciliation('payout-a', {
          reason: '渠道确认已打款',
          operatorId: 'admin-1',
        }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    // ---- 闸 ③：明细未被他人占用 ----

    it('⚠️ 闸 ③：明细已被同期的另一个出款单占用 → 拒绝，不动钱', async () => {
      // ⚠️ **闸 ③ 之前一直零覆盖** —— 这句「疑似重复付款，需人工退款处理」
      //    只在源码里出现过，从没被断言过。
      const prisma = fakePrisma(
        bClassOptions({
          occupiedEntries: [
            {
              entryId: 'entry-1',
              // ⚠️ **别的出款单** —— 闸 ③ 查的就是「被本单之外的单子占用」的明细
              payoutId: 'payout-b',
              payout: {
                // ⚠️ **同租户 + 同期** —— 闸 ③ 的判定条件（缺一不可）
                tenantId: 'tenant-a',
                periodStart: new Date('2025-08-01T00:00:00.000Z'),
              },
            },
          ],
        }),
      );
      const service = makeService(prisma, fakeVerification('PAID'));

      const call = service.confirmPaidAfterReconciliation('payout-a', {
        reason: '渠道确认已打款',
        operatorId: 'admin-1',
      });

      await expect(call).rejects.toBeInstanceOf(ConflictException);
      // ⚠️ **文案必须带「疑似重复付款」的指向** —— 操作员据此判断要人工退款
      await expect(call).rejects.toThrow(/疑似重复付款，需人工退款处理/);

      // ⚠️ **闸没过就不许动钱** —— 事务压根没开
      expect(prisma.$transaction).not.toHaveBeenCalled();
      // ⚠️ **`tx` 都没建出来** → `tx.payout.updateMany` / `tx.payoutOperation.create`
      //    一次都不可能发生 → 钱的状态没被改
      expect(prisma.tx()).toBeNull();
    });

    it('⚠️ 闸 ③：只查本单释放出来的明细，且排除本单自己', async () => {
      const prisma = fakePrisma(bClassOptions());
      const service = makeService(prisma, fakeVerification('PAID'));

      await service.confirmPaidAfterReconciliation('payout-a', {
        reason: '渠道确认已打款',
        operatorId: 'admin-1',
      });

      const where = argsOf(prisma.payoutEntry.findMany).where as {
        entryId: { in: string[] };
        NOT: { payoutId: string };
      };
      expect(where.entryId.in).toEqual(['entry-1', 'entry-2']);
      // ⚠️ **排除本单自己** —— 否则本单已释放的明细会把自己判成冲突
      expect(where.NOT.payoutId).toBe('payout-a');
    });

    it('⚠️ 闸 ③：占用明细属于别的租户 → 不拦，继续往下走', async () => {
      // ⚠️ **判定条件是「同租户 + 同期」** —— 只满足其一就不算冲突
      const prisma = fakePrisma(
        bClassOptions({
          occupiedEntries: [
            {
              entryId: 'entry-1',
              payoutId: 'payout-b',
              payout: {
                // ⚠️ **别的租户** —— 同同期，但不同租户
                tenantId: 'tenant-b',
                periodStart: new Date('2025-08-01T00:00:00.000Z'),
              },
            },
          ],
        }),
      );
      const service = makeService(prisma, fakeVerification('PAID'));

      const ok = await service.confirmPaidAfterReconciliation('payout-a', {
        reason: '渠道确认已打款',
        operatorId: 'admin-1',
      });

      expect(ok).toBe(true);
      // ⚠️ **闸 ③ 没拦** → 走到后面的闸并完成处置
      expect(prisma.tx()!.payoutOperation.create).toHaveBeenCalled();
    });

    it('⚠️ 闸 ③：占用明细属于同期之外 → 不拦，继续往下走', async () => {
      const prisma = fakePrisma(
        bClassOptions({
          occupiedEntries: [
            {
              entryId: 'entry-1',
              payoutId: 'payout-b',
              payout: {
                // ⚠️ **同期之外** —— 同租户，但不是一个结算期
                tenantId: 'tenant-a',
                periodStart: new Date('2025-09-01T00:00:00.000Z'),
              },
            },
          ],
        }),
      );
      const service = makeService(prisma, fakeVerification('PAID'));

      const ok = await service.confirmPaidAfterReconciliation('payout-a', {
        reason: '渠道确认已打款',
        operatorId: 'admin-1',
      });

      expect(ok).toBe(true);
      expect(prisma.tx()!.payoutOperation.create).toHaveBeenCalled();
    });

    it('⚠️ 撞唯一索引（P2002）→ 翻成 409，文案同时覆盖两个来源', async () => {
      // ⚠️ **P2002 有两个来源** ——
      //    ① `payouts_tenantId_period_kind_active_uniq`（商家重新申请了同一期）；
      //    ② `payout_entries_entryId_key`（明细已被别的出款单占用 = 疑似重复付款）。
      //    只说 ① 会把 ② 的信号一起掩盖掉。
      const prisma = fakePrisma(bClassOptions());
      prisma.$transaction.mockImplementation(() =>
        Promise.reject(
          Object.assign(new Error('Unique constraint failed'), {
            code: 'P2002',
          }),
        ),
      );
      const service = makeService(prisma, fakeVerification('PAID'));

      const call = service.confirmPaidAfterReconciliation('payout-a', {
        reason: '渠道确认已打款',
        operatorId: 'admin-1',
      });

      await expect(call).rejects.toBeInstanceOf(ConflictException);
      const err = await call.then(
        () => null,
        (e: unknown) => e as Error,
      );
      // ⚠️ **两个来源都要在文案里** —— 少了任一条操作员就会误判
      expect(err?.message).toContain('商家可能已重新申请同一期');
      expect(err?.message).toContain('疑似重复付款，需人工退款处理');
    });
  });
});
