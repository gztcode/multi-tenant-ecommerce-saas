import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { PayoutKind, PayoutStatus } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { TenantContextInterceptor } from '../src/modules/tenancy/tenant-context.interceptor';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import {
  platformScope,
  tenantContext,
} from '../src/common/tenant/tenant-context';
import { PayoutEncryptionSelfCheck } from '../src/modules/billing/payout-encryption-self-check.service';
import { http } from './helpers';
import { createMerchant, unique } from './merchant-fixture';

/**
 * 阶段 5k：启动时的账目加密自检（e2e）。
 *
 * ⚠️ **这个文件要独占跑** —— 它会**改库里的密文**。
 *    与其它 e2e 并发时，别的用例可能正好读到被改坏的那一行。
 *
 * Run: `cd api && npm run test:e2e -- payout-encryption-self-check`
 */

describe('账目加密启动自检 (e2e)', () => {
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

  it('库里没有可校验的行 → 自检通过（不抛错）', async () => {
    // ⚠️⚠️ **前提必须显式造出来** —— 不能指望「跑的时候库里恰好没有行」：
    //    整轮 e2e 共用同一个库，前面的文件（`payout-encryption.e2e-spec.ts`）
    //    已经造出了版本 1 的账户行与出款快照行 → 「没有行」这个前提在
    //    整轮跑批里是**假的**，这条用例只是因为「那行恰好能解开」才通过
    //    → **断言恒真（没有牙齿）**。
    //    → 这里把两张表的版本号都按回 0，让「没有可校验的行」成为
    //    **被断言的事实**，而不是碰巧。
    const accountTargets = await asPlatform(() =>
      prisma.merchantPayoutAccount.findMany({
        where: { encryptionVersion: 1 },
        select: { id: true },
      }),
    );
    const payoutTargets = await asPlatform(() =>
      prisma.payout.findMany({
        where: {
          snapshotEncryptionVersion: 1,
          snapshotAccountNoCipher: { not: null },
        },
        select: { id: true },
      }),
    );

    try {
      await asPlatform(() =>
        prisma.merchantPayoutAccount.updateMany({
          where: { encryptionVersion: 1 },
          data: { encryptionVersion: 0 },
        }),
      );
      await asPlatform(() =>
        prisma.payout.updateMany({
          where: {
            snapshotEncryptionVersion: 1,
            snapshotAccountNoCipher: { not: null },
          },
          data: { snapshotEncryptionVersion: 0 },
        }),
      );

      // ⚠️ **前提本身要断言** —— 「前提没造出来」也必须失败，
      //    否则这条用例又变成恒真。
      expect(
        await asPlatform(() =>
          prisma.merchantPayoutAccount.count({
            where: { encryptionVersion: 1 },
          }),
        ),
      ).toBe(0);
      expect(
        await asPlatform(() =>
          prisma.payout.count({
            where: {
              snapshotEncryptionVersion: 1,
              snapshotAccountNoCipher: { not: null },
            },
          }),
        ),
      ).toBe(0);

      const selfCheck = app.get(PayoutEncryptionSelfCheck);
      await expect(selfCheck.check()).resolves.toBeUndefined();
    } finally {
      // ⚠️⚠️ **必须还原** —— 真库上残留「版本 0」会让后面的用例
      //    （以及迁移脚本）误判这些行「还没加密」。
      for (const target of accountTargets) {
        await asPlatform(() =>
          prisma.merchantPayoutAccount.updateMany({
            where: { id: target.id },
            data: { encryptionVersion: 1 },
          }),
        );
      }
      for (const target of payoutTargets) {
        await asPlatform(() =>
          prisma.payout.updateMany({
            where: { id: target.id },
            data: { snapshotEncryptionVersion: 1 },
          }),
        );
      }
    }
  });

  it('⚠️ 账户的密文被改坏 → 自检抛错，且消息指明检查哪个环境变量', async () => {
    const merchant = await createMerchant(app, prisma);
    const accountNo = `62258800${unique().slice(0, 8)}`;

    // ---- 先建一张正常的账户行（版本 1） ----
    await http(app)
      .put('/api/v1/merchant/payout-account')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        accountName: '张三',
        bankName: '招商银行',
        accountNo,
      })
      .expect(200);

    const row = (await asPlatform(() =>
      prisma.merchantPayoutAccount.findFirst({
        where: { tenantId: merchant.tenantId },
        select: { id: true, accountNoCipher: true },
      }),
    ))!;
    expect(row.accountNoCipher).not.toBe('');

    // ⚠️⚠️ **必须把「所有版本 1 的行」都改坏** ——
    //    自检只取**一行**（`findFirst({ where: { encryptionVersion: 1 } })`），
    //    而 `findFirst` **没有 `orderBy` → 取到哪一行是不确定的**
    //    （实测：改坏其中一行后，同一个 `findFirst` 会返回**另一行** ——
    //    Postgres 的查询计划在 `UPDATE` 之后变了）。
    //    → 只改一行的话，自检很可能读到的是没坏的那行 → **断言恒真（没有牙齿）**。
    //    → 改坏全部候选行，「读哪行都坏」→ 断言才有牙齿。
    const targets = await asPlatform(() =>
      prisma.merchantPayoutAccount.findMany({
        where: { encryptionVersion: 1 },
        select: { id: true, accountNoCipher: true },
      }),
    );
    expect(targets.length).toBeGreaterThan(0);

    try {
      // ---- 把所有候选行的密文改成乱码 ----
      await asPlatform(() =>
        prisma.merchantPayoutAccount.updateMany({
          where: { encryptionVersion: 1 },
          data: { accountNoCipher: '这不是合法的密文' },
        }),
      );

      const selfCheck = app.get(PayoutEncryptionSelfCheck);
      await expect(selfCheck.check()).rejects.toThrow(/账目加密自检失败/);
      await expect(selfCheck.check()).rejects.toThrow(
        /PAYOUT_ACCOUNT_ENCRYPTION_KEY/,
      );
    } finally {
      // ⚠️⚠️ **必须还原** —— 真库上残留坏密文会让后面所有轮次都起不来
      for (const target of targets) {
        await asPlatform(() =>
          prisma.merchantPayoutAccount.updateMany({
            where: { id: target.id },
            data: { accountNoCipher: target.accountNoCipher },
          }),
        );
      }
    }
  });

  it('⚠️ 账户的密文是空串 → 自检抛错（空串是脏数据，不是「跳过」）', async () => {
    const merchant = await createMerchant(app, prisma);

    await http(app)
      .put('/api/v1/merchant/payout-account')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        accountName: '张三',
        bankName: '招商银行',
        accountNo: `62258800${unique().slice(0, 8)}`,
      })
      .expect(200);

    const row = (await asPlatform(() =>
      prisma.merchantPayoutAccount.findFirst({
        where: { tenantId: merchant.tenantId },
        select: { id: true, accountNoCipher: true },
      }),
    ))!;
    expect(row.accountNoCipher).not.toBe('');

    // ⚠️⚠️ **同样必须改「所有版本 1 的行」** ——
    //    自检的 `findFirst` 没有 `orderBy` → 取哪行不确定（理由同上一条）。
    const targets = await asPlatform(() =>
      prisma.merchantPayoutAccount.findMany({
        where: { encryptionVersion: 1 },
        select: { id: true, accountNoCipher: true },
      }),
    );
    expect(targets.length).toBeGreaterThan(0);

    try {
      await asPlatform(() =>
        prisma.merchantPayoutAccount.updateMany({
          where: { encryptionVersion: 1 },
          data: { accountNoCipher: '' },
        }),
      );

      const selfCheck = app.get(PayoutEncryptionSelfCheck);
      await expect(selfCheck.check()).rejects.toThrow(/空串/);
    } finally {
      for (const target of targets) {
        await asPlatform(() =>
          prisma.merchantPayoutAccount.updateMany({
            where: { id: target.id },
            data: { accountNoCipher: target.accountNoCipher },
          }),
        );
      }
    }
  });

  it('⚠️ 只改坏出款快照（账户行不动）→ 自检抛错，且消息指明是出款单快照', async () => {
    const merchant = await createMerchant(app, prisma);

    // ---- 先建一张正常的账户行（版本 1，正确密钥加密） ----
    await http(app)
      .put('/api/v1/merchant/payout-account')
      .set('authorization', `Bearer ${merchant.token}`)
      .send({
        accountName: '张三',
        bankName: '招商银行',
        accountNo: `62258800${unique().slice(0, 8)}`,
      })
      .expect(200);

    // ---- 造一张带坏快照的出款单 ----
    //
    // ⚠️ **必须自己造** —— 库里现成的出款单可能没有快照（快照是审批那一刻
    //    从账户行抄下来的，没走到审批就没有）。
    const payout = await asPlatform(() =>
      prisma.payout.create({
        data: {
          tenantId: merchant.tenantId,
          payoutNo: `PAY5K-SELFCHK-${unique()}`,
          periodStart: new Date(Date.UTC(2026, 6, 1)),
          periodEnd: new Date(Date.UTC(2026, 7, 1)),
          receiptAmount: 100000,
          commissionAmount: 5000,
          netAmount: 95000,
          entryCount: 1,
          status: PayoutStatus.PAID,
          requestedAmount: 95000,
          requestedBy: 'test-self-check',
          kind: PayoutKind.NORMAL,
          snapshotAccountName: '张三',
          snapshotBankName: '招商银行',
          // ⚠️ **坏快照**：版本号是 1（说自己加密过），密文却是乱码
          snapshotAccountNoCipher: '这不是合法的密文',
          snapshotMaskedAccountNo: '************1234',
          snapshotEncryptionVersion: 1,
        },
      }),
    );

    // ⚠️⚠️ **必须把「所有候选快照行」都改坏** ——
    //    自检的 `findFirst` 没有 `orderBy` → 取到哪一行是不确定的
    //    （理由同上面的账户行）。整轮 e2e 共用同一个库，前面文件留下的
    //    快照行也是候选 → 只改这一张的话，自检很可能读到的是没坏的那行
    //    → **断言恒真（没有牙齿）**。
    const targets = await asPlatform(() =>
      prisma.payout.findMany({
        where: {
          snapshotEncryptionVersion: 1,
          snapshotAccountNoCipher: { not: null },
        },
        select: { id: true, snapshotAccountNoCipher: true },
      }),
    );

    try {
      // ⚠️ **断言放在 try 里** —— 失败时也要走 finally 把造出来的单删掉
      expect(targets.length).toBeGreaterThan(0);

      await asPlatform(() =>
        prisma.payout.updateMany({
          where: {
            snapshotEncryptionVersion: 1,
            snapshotAccountNoCipher: { not: null },
          },
          data: { snapshotAccountNoCipher: '这不是合法的密文' },
        }),
      );

      const selfCheck = app.get(PayoutEncryptionSelfCheck);
      await expect(selfCheck.check()).rejects.toThrow(/账目加密自检失败/);
      // ⚠️ **这条断言同时证明了两件事**：
      //    1. 抛的错来自**出款快照那张表**（账户行是好的 —— 前面用正确
      //       密钥建的，自检先查账户表，通过了才轮到快照表）；
      //    2. 实现**没有在查到账户行之后早退** —— 早退的话这里根本不会抛。
      await expect(selfCheck.check()).rejects.toThrow(/出款单收款账号快照/);
    } finally {
      // ⚠️⚠️ **必须还原** —— 真库上残留坏密文会让后面所有轮次都起不来
      for (const target of targets) {
        await asPlatform(() =>
          prisma.payout.updateMany({
            where: { id: target.id },
            data: { snapshotAccountNoCipher: target.snapshotAccountNoCipher },
          }),
        );
      }
      // ⚠️ **造出来的单不能留在真库里** —— 残留的 PAID 单会被别的用例数到
      await asPlatform(() =>
        prisma.payout.deleteMany({ where: { id: payout.id } }),
      );
    }
  });
});
