# 阶段 5l「出款运维兜底」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「钱出问题时运营只能改数据库」变成界面上的几个按钮 —— 出款单能人工重试与解卡、失败原因的口径统一、出款/结算单列表能翻页。

**Architecture:** 数据层加一列 `payouts.failedBeforePayout`（区分「确定没打」与「可能已打」）+ 一张 `payout_operations` 留痕表。服务层在 `PayoutService` 加 `retry` / `unstick` 两个平台端方法（重试要**按 kind 分支重算金额 + 重新纳入流水**）。视图层把 `failureReason` 换成业务口径（商家端与平台端共用），平台端额外拿 `failureDetail` 原文。分页复用后端已有的 `page`/`pageSize`/`total`（出款列表后端零改动），结算单明细新增一个独立分页端点。

**Tech Stack:** NestJS 11 + Prisma 6 + BullMQ + Jest（单测）+ Jest/Supertest（e2e）+ Next.js 15 + React 19 + Vitest。

**设计依据:** `docs/superpowers/specs/2026-10-30-plan-05l-payout-ops-design.md`（阶段 5l 设计，已过独立审查，修正记录见其 §九）。

---

## 0. 实施须知

### 0.1 本机环境

| 组件 | 地址 |
|------|------|
| Postgres（测试库） | `localhost:15432`（`DATABASE_URL_TEST` 在 `api/.env`） |
| Redis | `localhost:16380`（e2e 用 `bull-e2e` 前缀） |
| API / merchant-admin / platform-admin | 3000 / 3002 / 3003 |

### 0.2 命令

```bash
# 单测（rootDir 是 api/src）
cd api && npx jest src/modules/billing/payout-execution.service.spec.ts
cd api && npx jest src/modules/billing/payout.service.spec.ts
cd api && npx jest src/modules/payment/payout-worker.spec.ts
cd api && npx jest src/modules/billing/payout-encryption-self-check.service.spec.ts

# 全量
cd api && npm test
cd api && npm run test:e2e -- payout-ops

# 编译
cd api && npm run build
cd merchant-admin && npx tsc --noEmit && npm run build
cd platform-admin && npx tsc --noEmit && npm run build
```

⚠️ **失败注入必须独占跑**（不与全量测试并发）—— 注入期间源码是坏的。

### 0.3 迁移纪律

⚠️ **本仓 `prisma migrate dev` 不可用** —— 实测有 **3 条**历史迁移的 checksum 与文件不符
（`20261021062421_drop_user_tenant_email_unique`、`20261022100000_add_catalog_tables`、
`20261028190000_add_settlement_statements`），`migrate dev` 会要求 `migrate reset`
（**会清库**，本项目明令禁用）。

→ **一律手写 SQL + `prisma migrate resolve --applied`**（与 5e / 5j 同款做法）。

⚠️ **改完 schema 必须 `npx prisma generate`** —— Prisma 的类型是从 schema 生成的，
不 generate 的话 `prisma.payout.create` 不认新字段。

### 0.4 提交纪律

⚠️ **实施代理不提交**（agent-team 模式）—— 代理只改代码 + 跑定向测试，**由协调者统一提交**。

---

### Task 1: 数据模型 —— `failedBeforePayout` 列 + `payout_operations` 表

**Files:**
- Modify: `api/prisma/schema.prisma`
- Modify: `api/src/common/tenant/tenant-models.ts`（排除注释区）
- Create: `api/prisma/migrations/20261030130000_add_payout_ops/migration.sql`

- [ ] **Step 1: 写迁移 SQL**

新建 `api/prisma/migrations/20261030130000_add_payout_ops/migration.sql`：

```sql
-- ⚠️ **枚举必须先建**（PostgreSQL 的顺序要求：建表时要用到它）
CREATE TYPE "PayoutOperationAction" AS ENUM ('RETRY', 'UNSTUCK_TO_FAILED', 'UNSTUCK_TO_APPROVED');

-- ⚠️ **先加列再回填** —— 回填要用到这句业务口径
ALTER TABLE "payouts" ADD COLUMN IF NOT EXISTS "failedBeforePayout" BOOLEAN NOT NULL DEFAULT false;

-- ⚠️ **回填历史行**：5k 引入的那句业务口径在 5k 之前不存在
--    （git log -S 实测确认只在 5k 的 commit 首次出现），
--    所以精确等于它的行必然来自「打款前」的路径 → 确定没打 → 可以置 true。
--
-- ⚠️ **只回填这一句** —— 另一句「出款金额异常，本次未打款，请联系平台核对」
--    故意**不**置 true：金额非法是脏数据，重算大概率仍 ≤ 0 → 重试会 409，
--    置 true 只会让按钮出现后再被拒，体验更差。
UPDATE "payouts"
   SET "failedBeforePayout" = true
 WHERE "status" = 'FAILED'
   AND "failureReason" = '收款账号信息异常，本次未打款，请更新收款账户后重新申请';

CREATE TABLE IF NOT EXISTS "payout_operations" (
  "id" TEXT NOT NULL,
  "payoutId" TEXT NOT NULL,
  "action" "PayoutOperationAction" NOT NULL,
  "operatorId" TEXT NOT NULL,
  "operatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reason" TEXT NOT NULL,
  "fromStatus" "PayoutStatus" NOT NULL,
  "toStatus" "PayoutStatus" NOT NULL,
  "attemptCountBefore" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payout_operations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payout_operations_payoutId_fkey" FOREIGN KEY ("payoutId")
    REFERENCES "payouts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "payout_operations_payoutId_operatedAt_idx"
  ON "payout_operations" ("payoutId", "operatedAt");
CREATE INDEX IF NOT EXISTS "payout_operations_operatorId_idx"
  ON "payout_operations" ("operatorId");
```

- [ ] **Step 2: 应用迁移 + 生成 Prisma client**

```bash
cd api && npx prisma migrate deploy && npx prisma generate
```

Expected: 迁移应用成功，`prisma generate` 无错。

⚠️ **开发库与测试库都要应用** —— 测试库在 e2e 的 `globalSetup` 里会自动
`prisma migrate deploy`（`api/test/setup-e2e.ts`），开发库要手动跑一次。

- [ ] **Step 3: 改 schema**

在 `api/prisma/schema.prisma` 里：

① `model Payout` 里，在 `snapshotEncryptionVersion Int @default(0)` 之后加：

```prisma
  /// 这次失败发生在**打款之前** —— 钱确定没打出去。
  ///
  /// ⚠️ **true = 可安全重试**（渠道从未被调用）；
  ///    **false = 钱可能已经打出去**（渠道调过了，只是没成功回包）
  ///    —— 这种情况**只能人工核对渠道**，不能重试。
  ///
  /// ⚠️ **不能靠 `failureReason` 的文案推断** —— 文案会被改、
  ///    会被手工编辑。判断依据必须是**打款动作有没有发生**。
  failedBeforePayout Boolean @default(false)
```

② `model Payout` 里，在 `entries PayoutEntry[]` 之后加（**Prisma 的双向关系两端都要声明**）：

```prisma
  /// 人工操作留痕（阶段 5l）
  operations PayoutOperation[]
```

③ 新增两个模型（放在 `model PayoutEntry` 之后）：

```prisma
/// 出款单的人工操作留痕（阶段 5l）。
///
/// ⚠️ **涉及钱的操作必须能追溯** —— 「谁在什么时候把哪张单重打了」
///    是运营出问题时第一个要回答的问题。
///    只在 `payouts` 上记「最近一次」会丢掉反复解卡的历史。
model PayoutOperation {
  id String @id @default(uuid())
  /// 出款单 id
  payoutId String
  /// 操作类型
  action PayoutOperationAction
  /// 操作人（平台超管的用户 id）
  operatorId String
  /// 操作时刻
  operatedAt DateTime @default(now())
  /// 操作原因（**必填** —— 涉及钱的操作不能没有理由）
  reason String
  /// 操作前的状态（留痕要能看出「从哪来」）
  fromStatus PayoutStatus
  /// 操作后的状态
  toStatus PayoutStatus
  /// 操作前的尝试次数（留痕要能看出「重试了几次」）
  attemptCountBefore Int?
  createdAt DateTime @default(now())

  /// 所属出款单（与 `payout_entries` 同款：`onDelete: Cascade` ——
  /// 出款单被删则留痕跟着删；实际上出款单**没有删除接口**
  /// （只有 `CANCELLED` 状态），所以这条几乎不会触发）
  payout Payout @relation(fields: [payoutId], references: [id], onDelete: Cascade)

  @@index([payoutId, operatedAt])
  @@index([operatorId])
  @@map("payout_operations")
}

/// 出款单的人工操作类型
enum PayoutOperationAction {
  /// 重试：FAILED → APPROVED（确定没打，安全重打）
  RETRY
  /// 解卡转失败：PROCESSING → FAILED（认定没打，结束这件事）
  UNSTUCK_TO_FAILED
  /// 解卡重打：PROCESSING → APPROVED（⚠️ 可能重复打款）
  UNSTUCK_TO_APPROVED
}
```

- [ ] **Step 4: 在 `tenant-models.ts` 的排除注释区补一段**

在 `api/src/common/tenant/tenant-models.ts` 里，找到**刻意排除**的模型（`PayoutEntry` /
`SettlementStatementEntry` / `Plan` / `PaymentWebhookEvent`）的那段注释，
补一段 `PayoutOperation` 的说明：

```ts
 * ⚠️ **`PayoutOperation` 刻意排除**（阶段 5l）——
 *    它是「出款单的人工操作留痕」，**没有 `tenantId`**（租户从出款单反查）。
 *    ⚠️ **不要把它登记进白名单** —— 登记了扩展会给它附加 tenantId 条件，
 *    而它**没有 `tenantId` 列** → Prisma 直接报错。
 *    ⚠️ 它**不受作用域约束** → 任何忘了带 `payoutId` 的查询都会返回全平台数据。
 *    它只在**平台作用域**下读写（只有平台超管能操作出款单）。
```

⚠️ **这一步是本仓的既定惯例**（那个文件里每个被排除的模型都有一段说明），
漏了会被下一个人「顺手登记进去」。

- [ ] **Step 5: 验证 schema 编译**

```bash
cd api && npx prisma validate && npx tsc --noEmit
```

Expected: 无错。

---

### Task 2: `markFailed` 加参数 + worker 五个调用点传值

**Files:**
- Modify: `api/src/modules/billing/payout-execution.service.ts`
- Modify: `api/src/modules/payment/payout.worker.ts`
- Test: `api/src/modules/billing/payout-execution.service.spec.ts`
- Test: `api/src/modules/payment/payout-worker.spec.ts`

- [ ] **Step 1: 写失败的测试 —— `markFailed` 落 `failedBeforePayout`**

在 `api/src/modules/billing/payout-execution.service.spec.ts` 的 `describe('markFailed')` 里加：

```ts
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
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
cd api && npx jest src/modules/billing/payout-execution.service.spec.ts
```

Expected: FAIL —— `MarkFailedInput` 没有 `failedBeforePayout` 字段（TypeScript 编译错）。

- [ ] **Step 3: 实现 `markFailed` 的参数**

在 `api/src/modules/billing/payout-execution.service.ts` 里，把 `MarkFailedInput` 改成：

```ts
/** 打款失败的结果 */
export interface MarkFailedInput {
  /** 失败原因（给运营看） */
  reason: string;
  /** 落 FAILED 的时刻（数据库时钟） */
  failedAt: Date;
  /**
   * 这次失败是否发生在**打款之前**。
   *
   * ⚠️ **true = 钱确定没打出去**（渠道从未被调用）→ 该单**可安全重试**。
   * ⚠️ **false = 钱可能已经打出去**（渠道调过了，只是没成功回包）
   *    → **不能重试**，只能人工核对渠道。
   *
   * ⚠️ **默认 false** —— 宁可保守。新增调用点若忘了传，
   *    会落成「不可重试」（安全方向）。
   */
  failedBeforePayout?: boolean;
}
```

并把 `markFailed` 方法体里 `updateMany` 的 `data` 改成：

```ts
        const affected = await tx.payout.updateMany({
          where: { id: payoutId, status: PayoutStatus.PROCESSING },
          data: {
            status: PayoutStatus.FAILED,
            failedAt: input.failedAt,
            failureReason: input.reason,
            // ⚠️ **「钱确定没打出去」的标记**（阶段 5l）——
            //    平台端的「重试」按钮只对 true 的单出现。
            failedBeforePayout: input.failedBeforePayout ?? false,
          },
        });
```

- [ ] **Step 4: 跑测试，确认通过**

```bash
cd api && npx jest src/modules/billing/payout-execution.service.spec.ts
```

Expected: PASS。

- [ ] **Step 5: 写失败的测试 —— worker 的调用点各自传对值**

在 `api/src/modules/payment/payout-worker.spec.ts` 里加一条：

```ts
  it('⚠️ 打款前的失败 → 标记「确定没打」（可安全重试）', async () => {
    const execution = fakeExecution({
      ...claim,
      account: null,
      accountError: '出款单的收款账号快照 尚未加密（版本 0）',
    });
    const provider = fakeProvider({ status: 'SUCCESS' });
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      fakeQueues() as unknown as never,
      new Map([['fake-payout', provider]]),
    );

    await worker.process({
      name: 'execute',
      data: { payoutId: 'payout-a' },
    } as never);

    const call = execution.markFailed.mock.calls[0] as unknown as [
      string,
      { failedBeforePayout?: boolean },
    ];
    // ⚠️ **渠道从未被调用 → 钱确定没打出去** → 可安全重试
    expect(call[1].failedBeforePayout).toBe(true);
  });

  it('⚠️ 渠道失败试满上限 → 标记「可能已打」（不可重试）', async () => {
    const execution = fakeExecution({
      ...claim,
      attemptCount: PAYOUT_MAX_ATTEMPTS,
    });
    const provider = fakeProvider({
      status: 'FAILED',
      failureReason: '渠道超时',
    });
    const worker = new PayoutWorker(
      execution as unknown as never,
      fakePrisma() as unknown as never,
      fakeQueues() as unknown as never,
      new Map([['fake-payout', provider]]),
    );

    await worker.process({
      name: 'execute',
      data: { payoutId: 'payout-a' },
    } as never);

    const call = execution.markFailed.mock.calls[0] as unknown as [
      string,
      { failedBeforePayout?: boolean },
    ];
    // ⚠️ **渠道调过了（可能已打出去）→ 不能重试**
    expect(call[1].failedBeforePayout).toBe(false);
  });
```

- [ ] **Step 6: 跑测试，确认失败**

```bash
cd api && npx jest src/modules/payment/payout-worker.spec.ts
```

Expected: FAIL —— worker 还没传 `failedBeforePayout`。

- [ ] **Step 7: worker 五个调用点传值**

在 `api/src/modules/payment/payout.worker.ts` 里：

① `:133` 附近的 `accountError` 分支（**打款前**）：

```ts
      await this.execution.markFailed(payoutId, {
        // ⚠️ **文案要自证「没打钱」**
        reason: '收款账号信息异常，本次未打款，请更新收款账户后重新申请',
        failedAt: await this.prisma.databaseNow(),
        // ⚠️ **渠道从未被调用** → 钱确定没打出去 → 可安全重试
        failedBeforePayout: true,
      });
```

② `:144` 附近的 `checkGates` 分支（**打款前**）：

```ts
      await this.execution.markFailed(payoutId, {
        reason: gateFailure,
        failedAt: await this.prisma.databaseNow(),
        // ⚠️ **渠道从未被调用** → 钱确定没打出去 → 可安全重试
        failedBeforePayout: true,
      });
```

③ `:157` 附近的「没有可用的出款渠道」分支（**打款前**）：

```ts
      await this.execution.markFailed(payoutId, {
        reason: '没有可用的出款渠道',
        failedAt: await this.prisma.databaseNow(),
        // ⚠️ **渠道压根没被调用** → 钱确定没打出去 → 可安全重试
        failedBeforePayout: true,
      });
```

④ `:246` 附近的「渠道金额核对不通过」分支（**打款后**）：

```ts
      await this.execution.markFailed(payoutId, {
        reason: `渠道金额核对不通过（请求 ${requestedAmount} 分，渠道返回 ${result.amount} 分）`,
        failedAt: now,
        // ⚠️ **渠道已经调过了** → 钱**可能**已经打出去 → 不能重试
        failedBeforePayout: false,
      });
```

⑤ `:273` 附近的 `handleFailure` 里达到上限时（**打款后**）：

```ts
      await this.execution.markFailed(payoutId, {
        reason,
        failedAt: now,
        // ⚠️ **渠道已经调过了** → 钱**可能**已经打出去 → 不能重试
        failedBeforePayout: false,
      });
```

- [ ] **Step 8: 跑两个测试，确认通过**

```bash
cd api && npx jest src/modules/payment/payout-worker.spec.ts src/modules/billing/payout-execution.service.spec.ts
```

Expected: PASS。

---

### Task 3: `PayoutService.retry` / `unstick` + 两个平台端点

**Files:**
- Modify: `api/src/modules/billing/payout.service.ts`
- Create: `api/src/modules/billing/dto/payout-manual-action.dto.ts`
- Modify: `api/src/modules/billing/platform-payout.controller.ts`
- Test: `api/src/modules/billing/payout.service.spec.ts`

⚠️ **本 Task 的实现量大，但每一步都有明确的前置检查** —— 按顺序做，不要跳步。

- [ ] **Step 1: 写 DTO**

新建 `api/src/modules/billing/dto/payout-manual-action.dto.ts`：

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * 平台端人工操作出款单的请求体（阶段 5l）。
 *
 * ⚠️ **原因必填** —— 涉及钱的操作不能没有理由。
 *    理由会进 `payout_operations.reason`（留痕表）。
 */
export class PayoutManualActionDto {
  @ApiProperty({
    description: '操作原因（必填，会记进操作留痕）',
    maxLength: 500,
  })
  @IsString()
  @IsNotEmpty({ message: '操作原因不能为空' })
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({
    description:
      '解卡的目标状态：FAILED = 标记失败（认定没打出去）；APPROVED = 重新打款（⚠️ 可能重复打款）',
    enum: ['FAILED', 'APPROVED'],
  })
  @IsIn(['FAILED', 'APPROVED'])
  to?: 'FAILED' | 'APPROVED';
}
```

- [ ] **Step 2: 给 `payout()` 夹具加 `failedBeforePayout`**

`api/src/modules/billing/payout.service.spec.ts` 的 `payout()` 夹具（`:88`）要能造出
「确定没打」的单 → 在它的 overrides 类型里加一行，并在返回对象里加一行：

```ts
function payout(overrides: {
  // …现有字段…
  /**
   * 这次失败是否发生在打款之前（阶段 5l）。
   *
   * ⚠️ **默认 false** —— 与真实数据一致（老数据一律 false）。
   */
  failedBeforePayout?: boolean;
}) {
  // …
  return {
    // …现有字段…
    failedBeforePayout: overrides.failedBeforePayout ?? false,
    // …
  };
}
```

- [ ] **Step 3: 写失败的测试 —— 重试的前置条件**

在 `api/src/modules/billing/payout.service.spec.ts` 里加一个 describe：

```ts
describe('平台端人工重试（阶段 5l）', () => {
  it('⚠️ 不是 FAILED 状态 → 409', async () => {
    const prisma = fakePrisma({
      payoutSequence: [payout({ status: PayoutStatus.APPROVED })],
    });
    const service = makeService(prisma, fakeQueues());

    await expect(
      asPlatform(() => service.retry('payout-a', '渠道恢复了')),
    ).rejects.toThrow(/状态已变/);
  });

  it('⚠️ failedBeforePayout = false → 409（钱可能已打，不能重试）', async () => {
    const prisma = fakePrisma({
      payoutSequence: [
        payout({ status: PayoutStatus.FAILED, failedBeforePayout: false }),
      ],
    });
    const service = makeService(prisma, fakeQueues());

    await expect(
      asPlatform(() => service.retry('payout-a', '想再试一次')),
    ).rejects.toThrow(/可能已经打款/);
  });

  it('⚠️ 该期有别的活跃出款单 → 409，且消息点名那张单', async () => {
    // ⚠️ **`payoutSequence` 按调用顺序返回** —— 第 1 次是「查这张单」，
    //    第 2 次是「查该期有没有别的活跃单」。
    const prisma = fakePrisma({
      payoutSequence: [
        payout({
          status: PayoutStatus.FAILED,
          failedBeforePayout: true,
        }),
        payout({
          id: 'payout-other',
          payoutNo: 'PAY-OTHER-1',
          status: PayoutStatus.REQUESTED,
        }),
      ],
    });
    const service = makeService(prisma, fakeQueues());

    await expect(
      asPlatform(() => service.retry('payout-a', '渠道恢复了')),
    ).rejects.toThrow(/PAY-OTHER-1/);
  });

  it('⚠️ 原因为空 → 400', async () => {
    const prisma = fakePrisma({
      payoutSequence: [
        payout({
          status: PayoutStatus.FAILED,
          failedBeforePayout: true,
        }),
      ],
    });
    const service = makeService(prisma, fakeQueues());

    await expect(
      asPlatform(() => service.retry('payout-a', '   ')),
    ).rejects.toThrow(/原因/);
  });
});
```

⚠️ **`payoutNo` 是夹具里写死的 `'PAY202508010000000001'`** —— 上面那条要断言
「消息点名另一张单的 `payoutNo`」，所以要给夹具加一个 `payoutNo` 的 override
（现在的 `payout()` 没有这个 override）：

```ts
  /** 出款单号（对外凭证） */
  payoutNo?: string;
```

⚠️ **`asPlatform` / `makeService` / `fakeQueues` 是现有 spec 里已有的 helper**，
直接用，不要另造。

- [ ] **Step 4: 跑测试，确认失败**

```bash
cd api && npx jest src/modules/billing/payout.service.spec.ts
```

Expected: FAIL —— `service.retry` 不存在。

- [ ] **Step 5: 实现 `retry`**

在 `api/src/modules/billing/payout.service.ts` 里，加一个方法（放在 `approve` 之后）：

```ts
  /**
   * 平台端人工重试（阶段 5l）。
   *
   * ⚠️ **只允许「确定没打钱」的单重试** —— `failedBeforePayout = true`
   *    意味着渠道**从未被调用**（解密失败 / 打款前的闸 / 没有可用渠道）。
   *    `false` 的单钱**可能已经打出去** → 重试 = **重复打款**。
   *
   * ⚠️ **重试要重新纳入流水 + 重算金额** ——
   *    `markFailed` 落 `FAILED` 时释放了 `payout_entries`，
   *    而那张表**同时是「这张单要打哪些流水」的凭证**。
   *    不重新纳入 → 账实不符（商家能对同期重新申请 → 同一笔打两次）。
   *
   * @param reason 操作原因（必填，会记进 `payout_operations`）
   */
  async retry(payoutId: string, reason: string): Promise<PlatformPayoutView> {
    const trimmed = reason?.trim() ?? '';
    if (!trimmed) {
      throw new BadRequestException('操作原因不能为空');
    }
    const context = getTenantContext();
    const operatorId = context.userId;
    if (!operatorId) {
      throw new BadRequestException('缺少用户上下文');
    }

    return tenantContext.run(platformScope(), async () => {
      const payout = await this.prisma.payout.findFirst({
        where: { id: payoutId },
      });
      if (!payout) {
        throw new NotFoundException('出款单不存在');
      }
      if (payout.status !== PayoutStatus.FAILED) {
        throw new ConflictException(
          `出款单状态已变（当前是 ${payout.status}），只有失败的出款单能重试`,
        );
      }
      // ⚠️ **硬闸**：钱可能已打出去的单**不能重试**
      if (!payout.failedBeforePayout) {
        throw new ConflictException(
          '该出款单可能已经打款（渠道调过了，只是没成功回包），不能直接重试。' +
            '请先核对渠道是否已到账。',
        );
      }

      const period = { from: payout.periodStart, to: payout.periodEnd };
      const periodLabel = formatPeriodLabel(payout.periodStart);

      // ⚠️⚠️ **活跃单检查不能直接用 `findActivePayout`** ——
      //    那个方法**只在商家侧（租户作用域）调用**（不手写 tenantId，
      //    靠扩展附加）。这里跑在**平台作用域**下 → 扩展不附加 tenantId →
      //    直接用会**跨租户匹配**（所有租户的 periodStart 都是同一天）。
      //    → 自己写，口径必须与部分唯一索引
      //    `payouts_tenantId_period_kind_active_uniq`
      //    （`(tenantId, periodStart, kind)`，
      //    `WHERE status NOT IN ('REJECTED','CANCELLED','FAILED')`）**逐字一致**。
      const other = await this.prisma.payout.findFirst({
        where: {
          tenantId: payout.tenantId,
          periodStart: payout.periodStart,
          // ⚠️ **kind 是索引的一部分，必须带** —— 同期不同 kind 的单不冲突
          kind: payout.kind,
          status: {
            notIn: [
              PayoutStatus.REJECTED,
              PayoutStatus.CANCELLED,
              PayoutStatus.FAILED,
            ],
          },
          // ⚠️ **排除自己**
          id: { not: payout.id },
        },
      });
      if (other) {
        throw new ConflictException(
          `该期（${periodLabel}）已有另一张活跃出款单 ${other.payoutNo}，` +
            '请先处理那张单再重试这张。',
        );
      }

      // ⚠️⚠️ **按 kind 分支重算** —— 补差单**绝不能**调 `computeAmounts`
      //    （那会把整期佣金再扣一遍，护栏 X13）。
      const isSupplement = payout.kind === PayoutKind.SUPPLEMENT;
      const amounts = isSupplement
        ? await this.computeSupplementAmounts(payout, period)
        : await this.computeAmounts(payout.tenantId, period);

      // ⚠️ **金额变了 = 事实变了** —— 该让商家重新申请（走正常审批），
      //    而不是运营替他决定打多少（5h-1 的 P5 是同一个道理）。
      if (amounts.netAmount !== payout.netAmount) {
        throw new ConflictException(
          `该期（${periodLabel}）的金额已变化` +
            `（原锁定 ${payout.netAmount} 分，现在重算是 ${amounts.netAmount} 分），` +
            '不能直接重试。请让商家重新申请。',
        );
      }
      if (amounts.entryCount === 0) {
        throw new ConflictException(
          `该期（${periodLabel}）已无货款流水，不能重试出款`,
        );
      }

      const updated = await this.prisma.$transaction(async (tx) => {
        const affected = await tx.payout.updateMany({
          // ⚠️ **必须带状态条件** —— 否则两个超管同时点「重试」会双双「成功」
          where: {
            id: payoutId,
            status: PayoutStatus.FAILED,
            failedBeforePayout: true,
          },
          data: {
            status: PayoutStatus.APPROVED,
            attemptCount: 0,
            failureReason: null,
            failedAt: null,
            failedBeforePayout: false,
            processingAt: null,
            // ⚠️ **approvedAt 不刷新** —— 它的语义是「审批时间」，
            //    刷新它会让平台端显示的审批时间变成假的。
          },
        });
        if (affected.count === 0) {
          throw new ConflictException('出款单状态已变，不能重复重试');
        }

        // ⚠️ **重新纳入明细** —— 与 `approve` 同款：先删后插
        //    （`payout_entries.entryId` 是全局唯一索引，不先删就插会撞 P2002）
        await tx.payoutEntry.deleteMany({ where: { payoutId } });
        if (amounts.entryIds.length > 0) {
          await tx.payoutEntry.createMany({
            data: amounts.entryIds.map((entryId) => ({ payoutId, entryId })),
          });
        }

        // ⚠️ **操作留痕** —— 涉及钱的操作必须能追溯
        await tx.payoutOperation.create({
          data: {
            payoutId,
            action: 'RETRY',
            operatorId,
            reason: trimmed,
            fromStatus: PayoutStatus.FAILED,
            toStatus: PayoutStatus.APPROVED,
            attemptCountBefore: payout.attemptCount,
          },
        });

        return tx.payout.findFirst({ where: { id: payoutId } });
      });
      if (!updated) {
        throw new NotFoundException('出款单不存在');
      }

      // ⚠️ **入队必须在事务提交之后**（与 `approve` 同款）
      await this.enqueueRetry(updated.id);

      return this.toPlatformView(updated);
    });
  }
```

⚠️ **`enqueueRetry` 是个小 helper**（放在 `PayoutService` 里），负责入队与失败兜底：

```ts
  /**
   * 人工重试后的入队（阶段 5l）。
   *
   * ⚠️ **jobId 的轮次来自「历史人工重试次数 + 1」** ——
   *    **不能用 `attemptCount`**（它刚被重置成 0 了），
   *    也**绝不能复用 jobId**：BullMQ 里 failed job 的 hash 还在，
   *    用同一个 jobId 重新入队会被**静默忽略**（不报错、不入队 → 重试从未发生）。
   */
  private async enqueueRetry(payoutId: string): Promise<void> {
    const done = await this.prisma.payoutOperation.count({
      where: { payoutId, action: 'RETRY' },
    });
    try {
      await this.queues.addWithOptions(
        PAYOUT_QUEUE,
        'execute',
        { payoutId },
        `payout-${payoutId}-retry-${done + 1}`,
        { attempts: 1, removeOnComplete: true },
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.prisma.payout.updateMany({
        where: { id: payoutId, status: PayoutStatus.APPROVED },
        // ⚠️ **界面口径** —— 原始异常只进日志
        data: { failureReason: '打款任务提交失败，系统将自动重试' },
      });
      this.logger.error(
        `出款人工重试后入队失败：${payoutId} —— ${reason}（将由兜底扫描重新入队）`,
      );
    }
  }
```

- [ ] **Step 6: 实现 `unstick`**

在 `payout.service.ts` 里加（放在 `retry` 之后）：

```ts
  /**
   * 平台端解除卡单（阶段 5l）。
   *
   * ⚠️ **卡在 `PROCESSING` 的单钱可能已经打出去**（5h-2 的 R3：绝不自动重试）——
   *    所以「重新打款」这个方向**必须由运营在核对渠道后手动决定**，
   *    且界面要警示 + 必填原因。
   *
   * @param to `FAILED` = 认定没打出去（结束这件事）；`APPROVED` = 重新打款
   */
  async unstick(
    payoutId: string,
    input: { to: 'FAILED' | 'APPROVED'; reason: string },
  ): Promise<PlatformPayoutView> {
    const trimmed = input?.reason?.trim() ?? '';
    if (!trimmed) {
      throw new BadRequestException('操作原因不能为空');
    }
    const context = getTenantContext();
    const operatorId = context.userId;
    if (!operatorId) {
      throw new BadRequestException('缺少用户上下文');
    }

    return tenantContext.run(platformScope(), async () => {
      const payout = await this.prisma.payout.findFirst({
        where: { id: payoutId },
      });
      if (!payout) {
        throw new NotFoundException('出款单不存在');
      }
      if (payout.status !== PayoutStatus.PROCESSING) {
        throw new ConflictException(
          `出款单状态已变（当前是 ${payout.status}），只有卡在「打款中」的出款单能解卡`,
        );
      }

      // ⚠️ **必须确认它真的卡住了** —— 否则运营一点就把**正在进行的打款**打断了。
      //    阈值与 `scanStuck` 的 `stuckThresholdMs` 一致（10 分钟）。
      const thresholdMs = 10 * 60 * 1000;
      if (
        !payout.processingAt ||
        Date.now() - payout.processingAt.getTime() < thresholdMs
      ) {
        throw new ConflictException(
          '该出款单可能正在打款中（未超过卡住阈值），请稍后再试',
        );
      }

      const toStatus =
        input.to === 'APPROVED' ? PayoutStatus.APPROVED : PayoutStatus.FAILED;

      // ⚠️ **用数据库时钟** —— 与 `markFailed` 同款（worker 传的也是
      //    `await this.prisma.databaseNow()`）。不要用 `new Date()`：
      //    应用时钟与数据库时钟有偏差，判定边界会漂。
      const failedAt = await this.prisma.databaseNow();

      const updated = await this.prisma.$transaction(async (tx) => {
        const affected = await tx.payout.updateMany({
          // ⚠️ **必须带状态条件**（并发护栏，与 `approve` 同款）
          where: { id: payoutId, status: PayoutStatus.PROCESSING },
          data: {
            status: toStatus,
            // ⚠️ **processingAt 必须清** —— 不清的话兜底扫描会把它
            //    当成卡住的单反复捞出来
            processingAt: null,
            ...(toStatus === PayoutStatus.FAILED
              ? {
                  failedAt,
                  failureReason:
                    '出款单被平台人工标记为失败（钱未打出去），可重新申请或重试',
                  // ⚠️ **认定「没打出去」→ 转 FAILED 后可重试**
                  failedBeforePayout: true,
                  // ⚠️ **attemptCount 保持不动** —— 保留「这张单卡住时
                  //    试了几次」这个事实，排查时要看
                }
              : {
                  // ⚠️ **重新打款**：明细**绝不能释放**（释放了商家就能
                  //    对同期重新申请 → 同一笔流水打两次）
                  attemptCount: 0,
                  // ⚠️ **approvedAt 不刷新**（语义是「审批时间」）
                }),
          },
        });
        if (affected.count === 0) {
          throw new ConflictException('出款单状态已变，不能重复解卡');
        }

        // ⚠️ **转 FAILED 时要释放明细** —— 与 `markFailed` 同款：
        //    单子结束了，商家可以对该期重新申请
        if (toStatus === PayoutStatus.FAILED) {
          await tx.payoutEntry.deleteMany({ where: { payoutId } });
        }

        await tx.payoutOperation.create({
          data: {
            payoutId,
            action:
              toStatus === PayoutStatus.FAILED
                ? 'UNSTUCK_TO_FAILED'
                : 'UNSTUCK_TO_APPROVED',
            operatorId,
            reason: trimmed,
            fromStatus: PayoutStatus.PROCESSING,
            toStatus,
            attemptCountBefore: payout.attemptCount,
          },
        });

        return tx.payout.findFirst({ where: { id: payoutId } });
      });
      if (!updated) {
        throw new NotFoundException('出款单不存在');
      }

      // ⚠️ **重新打款要入队**（转 FAILED 不用）
      if (toStatus === PayoutStatus.APPROVED) {
        await this.enqueueRetry(updated.id);
      }

      return this.toPlatformView(updated);
    });
  }
```

- [ ] **Step 7: 加两个端点**

在 `api/src/modules/billing/platform-payout.controller.ts` 里：

① import 段加：

```ts
import { PayoutManualActionDto } from './dto/payout-manual-action.dto';
```

② 在 `reject` 之后加：

```ts
  @Post('payouts/:id/retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '人工重试（仅限「确定没打钱」的失败单）',
    description:
      '把一张失败的出款单重新放回打款队列。只允许钱确定没打出去的失败单' +
      '（收款账户不可用 / 打款前的校验没过）；钱可能已经打出去的单必须先核对渠道。',
  })
  async retry(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: PayoutManualActionDto,
  ) {
    return this.payouts.retry(id, dto.reason);
  }

  @Post('payouts/:id/unstick')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '解除卡单（卡在「打款中」的单）',
    description:
      '把一张卡在 PROCESSING 的出款单转成失败（认定没打出去，结束这件事）' +
      '或转回已审批（重新打款 —— ⚠️ 可能重复打款，必须先核对渠道）。',
  })
  async unstick(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: PayoutManualActionDto,
  ) {
    // ⚠️ **`to` 必填** —— 「转失败」与「重新打款」的后果完全不同，
    //    不能有默认值（默认「转失败」的话，运营漏传就会静默走错方向）
    if (!dto.to) {
      throw new BadRequestException('必须指定目标状态（FAILED 或 APPROVED）');
    }
    return this.payouts.unstick(id, { to: dto.to, reason: dto.reason });
  }
```

⚠️ **`BadRequestException` 要加进 `@nestjs/common` 的 import**。

- [ ] **Step 8: 跑测试**

```bash
cd api && npx jest src/modules/billing/payout.service.spec.ts
```

Expected: PASS —— Step 3 的 4 条新用例 + 原有全部绿。

⚠️ **原有用例不能被改挂** —— `retry` / `unstick` 是**新方法**，不动原有逻辑。

- [ ] **Step 9: 编译**

```bash
cd api && npx tsc --noEmit && npm run build
```

Expected: 无错。

---

### Task 4: 失败原因的口径收口

**Files:**
- Modify: `api/src/modules/billing/payout.service.ts`（`toView` / `toPlatformView`）
- Modify: `platform-admin/src/lib/payout.ts`（`PlatformPayoutDetail` 加 `failureDetail`）
- Modify: `platform-admin/src/app/(dashboard)/payouts/[id]/page.tsx`（加「失败详情」行）
- Test: `api/src/modules/billing/payout.service.spec.ts`

- [ ] **Step 1: 写失败的测试 —— 口径分流**

在 `payout.service.spec.ts` 里加：

```ts
describe('失败原因的口径（阶段 5l）', () => {
  it('⚠️ 商家端视图：确定没打 → 业务口径（不含渠道原文）', async () => {
    const prisma = fakePrisma({
      payout: payout({
        status: PayoutStatus.FAILED,
        failedBeforePayout: true,
        failureReason: '出款单的收款账号快照 尚未加密（版本 0）',
      }),
    });
    const service = makeService(prisma, fakeQueues());

    // ⚠️ **商家端视图要在租户作用域下测** —— `detailForTenant` 不跑
    //    platformScope（它靠当前租户上下文）
    const view = await asTenant(() => service.detailForTenant('payout-a'));

    expect(view.failureReason).toContain('本次未打款');
    expect(view.failureReason).not.toContain('尚未加密');
  });

  it('⚠️ 商家端视图：可能已打 → 通用措辞（不含渠道原文）', async () => {
    const prisma = fakePrisma({
      payout: payout({
        status: PayoutStatus.FAILED,
        failedBeforePayout: false,
        failureReason: 'connect ECONNREFUSED 10.0.0.5:6379',
      }),
    });
    const service = makeService(prisma, fakeQueues());

    // ⚠️ **商家端视图要在租户作用域下测** —— `detailForTenant` 不跑
    //    platformScope（它靠当前租户上下文）
    const view = await asTenant(() => service.detailForTenant('payout-a'));

    expect(view.failureReason).toContain('请联系平台确认出款情况');
    expect(view.failureReason).not.toContain('ECONNREFUSED');
    expect(view.failureReason).not.toContain('10.0.0.5');
  });

  it('⚠️ 平台端视图：额外给 failureDetail（渠道原文）', async () => {
    const prisma = fakePrisma({
      payout: payout({
        status: PayoutStatus.FAILED,
        failedBeforePayout: false,
        failureReason: 'connect ECONNREFUSED 10.0.0.5:6379',
      }),
    });
    const service = makeService(prisma, fakeQueues());

    const view = await asPlatform(() => service.detailForPlatform('payout-a'));

    expect(view.failureDetail).toContain('ECONNREFUSED');
  });
});
```

⚠️ **方法签名已核实**：
`detailForTenant(payoutId): Promise<PayoutDetailView>`（`payout.service.ts:702`，
**在租户作用域下跑**）与
`detailForPlatform(payoutId): Promise<PlatformPayoutView & { entries }>`（`:739`，
**自己跑 platformScope**）。
⚠️ **两个 scope helper 现有 spec 里已有**：`asTenant(...)` 与 `asPlatform(...)`（`:515` / `:533`）。

- [ ] **Step 2: 跑测试，确认失败**

```bash
cd api && npx jest src/modules/billing/payout.service.spec.ts
```

Expected: FAIL —— `failureReason` 还是原文、平台端视图没有 `failureDetail`。

- [ ] **Step 3: 改 `toView` —— 商家端与平台端共用，给业务口径**

在 `payout.service.ts` 的 `toView` 里，把：

```ts
      failureReason: payout.failureReason,
```

改成：

```ts
      // ⚠️ **业务口径，不是原文**（阶段 5l）——
      //    原文可能是渠道的异常（带主机名、请求 id）或内部的解密信息，
      //    商家看到的是**内部术语**。
      //    ⚠️ **默认安全**：共用视图给业务口径 → 新增端点若用 `toView`，
      //    默认就是脱敏的；只有平台端视图额外暴露原文（`failureDetail`）。
      failureReason: this.merchantFailureReason(payout),
```

并在 `toView` 之前加一个 helper：

```ts
  /**
   * 商家端看到的失败原因（**业务口径**，阶段 5l）。
   *
   * ⚠️ **按「钱打没打出去」分流** —— 这顺带解决了 5k 的遗留 5
   *    （「`FAILED` 承载了两种语义」）：
   * - **确定没打**（`failedBeforePayout = true`）→ 商家能**做点什么**
   *   （更新收款账户后重新申请）；
   * - **可能已打**（`false`）→ 商家只能**去核对**（可能钱已经到账了）。
   *
   * ⚠️ **第二类为什么不能说「是否已到账」** —— 那会让商家以为「可能没到」，
   *    而实际是「可能已经到了，请去查」。
   */
  private merchantFailureReason(payout: Payout): string | null {
    if (!payout.failureReason) return null;
    if (payout.failedBeforePayout) {
      return '收款账号信息异常，本次未打款，请更新收款账户后重新申请';
    }
    return '出款未完成，请联系平台确认出款情况';
  }
```

- [ ] **Step 4: 改 `toPlatformView` —— 额外给原文**

把 `toPlatformView` 的返回改成：

```ts
    return {
      ...this.toView(payout),
      tenantId: payout.tenantId,
      // ⚠️ **查不到商家名就回落到 id 本身**：商家被删了也要让超管看到这一行。
      tenantName: tenant?.name ?? payout.tenantId,
      subdomain: tenant?.subdomain ?? '—',
      // ⚠️ **渠道侧的原文**（只有平台端有）—— 超管排查要靠它。
      //    ⚠️ **三条护栏**：只在 FAILED 时返回、长度截断、去换行。
      failureDetail: this.platformFailureDetail(payout),
    };
```

并加：

```ts
  /**
   * 平台端看到的失败详情（**渠道侧的原文**，阶段 5l）。
   *
   * ⚠️ **它看不到解密根因** —— 那是 5k 的遗留 4（根因只进日志，
   *    从不进 `failureReason`）。界面上要写清这一点。
   *
   * ⚠️ **三条护栏**：只在 `FAILED` 时返回、长度截断、去掉换行
   *    （原文可能带 `\n` → 直接渲染会破坏界面布局）。
   */
  private platformFailureDetail(payout: Payout): string | null {
    if (payout.status !== PayoutStatus.FAILED) return null;
    const raw = payout.failureReason;
    if (!raw) return null;
    const text = raw.replace(/\r?\n/g, ' ').trim();
    if (!text) return null;
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  }
```

⚠️ **`PlatformPayoutView` 接口要加 `failureDetail: string | null`**（在
`payout.service.ts` 的接口定义里）。

⚠️ **`toPlatformViews`（批量版）也要加** —— 它是 `toPlatformView` 的批量版，
漏了列表页就没有 `failureDetail`。

- [ ] **Step 5: 跑测试，确认通过**

```bash
cd api && npx jest src/modules/billing/payout.service.spec.ts
```

Expected: PASS。

⚠️ **原有断言可能挂** —— 有用例断言 `failureReason` 是原文的话，
要改成断言业务口径（并加一条「不含原文」的断言）。

- [ ] **Step 6: 前端加 `failureDetail` 字段与「失败详情」行**

① `platform-admin/src/lib/payout.ts` 的 `PlatformPayoutDetail` 里加：

```ts
  /**
   * 失败详情（**渠道侧的原文**，只有平台端有）。
   *
   * ⚠️ **商家端没有这个字段** —— 商家看到的是业务口径的 `failureReason`。
   * ⚠️ **它看不到解密根因** —— 那是 5k 的遗留 4（根因只进日志）。
   */
  failureDetail: string | null;
```

② `platform-admin/src/app/(dashboard)/payouts/[id]/page.tsx` 里，在「失败原因」那一段
**之后**加：

```tsx
            {/* ⚠️ **失败详情 = 渠道侧的原文**（只有平台端有）——
                超管排查要靠它（「Unsupported state or unable to
                authenticate data」比「收款账号信息异常」有用得多）。
                ⚠️ **看不到解密根因** —— 那是只进日志的（5k 的遗留 4）。 */}
            {payout.failureDetail && (
              <div className="flex justify-between py-2 text-sm text-muted-foreground">
                <span>失败详情</span>
                <span className="max-w-[60%] break-words text-right">
                  {payout.failureDetail}
                </span>
              </div>
            )}
```

- [ ] **Step 7: 编译两端**

```bash
cd platform-admin && npx tsc --noEmit && npm run build
cd ../merchant-admin && npx tsc --noEmit && npm run build
```

Expected: 无错。

---

### Task 5: 平台端的处置按钮

**Files:**
- Modify: `platform-admin/src/app/(dashboard)/payouts/payout-actions.tsx`
- Modify: `platform-admin/src/app/(dashboard)/payouts/[id]/page.tsx`
- Create: `platform-admin/src/app/api/billing/payouts/[id]/retry/route.ts`
- Create: `platform-admin/src/app/api/billing/payouts/[id]/unstick/route.ts`
- Test: `platform-admin/test/components/payout-actions.test.tsx`

⚠️ **平台端的写操作走同源的 `/api/**` 中转**，不是直连后端（后端没开 CORS，
且 accessToken 不该进客户端代码）。所以本 Task 要**加两个中转路由**。

- [ ] **Step 1: 写失败的测试 —— 按钮的出现条件**

在 `platform-admin/test/components/payout-actions.test.tsx` 里加：

```tsx
describe('平台端出款的人工处置（阶段 5l）', () => {
  it('⚠️ FAILED 且确定没打 → 显示「重试」按钮', () => {
    render(
      <PayoutActions
        payoutId="payout-1"
        status="FAILED"
        requestedAmount={95000}
        failedBeforePayout
      />,
    );

    expect(screen.getByRole('button', { name: /重试/ })).toBeTruthy();
  });

  it('⚠️ FAILED 但可能已打 → **不显示**「重试」按钮', () => {
    // ⚠️ **这条是护栏** —— 钱可能已经打出去，重试 = 重复打款
    render(
      <PayoutActions
        payoutId="payout-1"
        status="FAILED"
        requestedAmount={95000}
      />,
    );

    expect(screen.queryByRole('button', { name: /重试/ })).toBeNull();
  });

  it('⚠️ 卡在 PROCESSING → 显示两个解卡按钮，且「重新打款」带警示', () => {
    render(
      <PayoutActions
        payoutId="payout-1"
        status="PROCESSING"
        requestedAmount={95000}
      />,
    );

    expect(screen.getByRole('button', { name: /标记为失败/ })).toBeTruthy();
    const redo = screen.getByRole('button', { name: /重新打款/ });
    expect(redo).toBeTruthy();
    // ⚠️ **警示必须出现在按钮附近** —— 运营点之前要看到这句话
    expect(screen.getByText(/可能已打款/)).toBeTruthy();
  });
});
```

⚠️ **`PayoutActions` 现在是「审批/拒绝」用的组件**（`status !== 'REQUESTED'` 就什么都不渲染）。
本 Task 要让它**多支持三种人工处置**。⚠️ **不要破坏它原有的审批功能** ——
现有 16 条测试必须仍然全绿。

⚠️ **导入已核实**（现有 spec 的文件头）：
`import { act, render, screen, waitFor } from '@testing-library/react';`
⚠️ **文件第一行必须是 `// @vitest-environment jsdom`** —— platform-admin 的
vitest 全局环境是 `node`，逐文件的注释优先于全局配置。
⚠️ **`window.confirm` / `window.prompt` 要 spy** —— 现有 spec 里有
「`vi.spyOn(window, 'confirm')` 必须还原」的注释（`vi.restoreAllMocks()` 在
`beforeEach` 里），新增的用例点按钮时会撞上这两个弹窗。

- [ ] **Step 2: 跑测试，确认失败**

```bash
cd platform-admin && npx vitest run test/components/payout-actions.test.tsx
```

Expected: FAIL —— 组件还不支持这三个 props。

- [ ] **Step 3: 实现三个按钮**

在 `platform-admin/src/app/(dashboard)/payouts/payout-actions.tsx` 里：

① **props 是内联类型**（现有文件就是内联的，不是单独 interface）→ 改成：

```tsx
export function PayoutActions({
  payoutId,
  status,
  requestedAmount,
  failedBeforePayout,
}: {
  payoutId: string;
  status: PayoutStatus;
  /** 申请时的预估金额（审批时会重算 → 两者可能不同） */
  requestedAmount: number;
  /**
   * 这次失败是否发生在打款之前（钱确定没打出去）。
   *
   * ⚠️ **只有它为 true 才给「重试」按钮** —— 钱可能已经打出去的单
   *    重试 = **重复打款**。
   */
  failedBeforePayout?: boolean;
}) {
```

② 三个操作的处理函数（**照现有 `run(action)` 的写法**：先 `confirm` 问一次，
再 `prompt` 收原因，最后 `fetch('/api/...')` ——⚠️ **不是 `apiFetchAuthed`**，
写操作走同源中转）：

```tsx
  async function runManual(
    action: 'retry' | 'unstick-failed' | 'unstick-redo',
  ) {
    // ⚠️ **闸门读的是 ref 不是 state**（与现有 `run` 同款）——
    //    连点两次会一起通过检查发出两次请求。
    if (busyRef.current) return;

    const confirms: Record<typeof action, string> = {
      retry:
        '确定重试这张出款单？\n钱确定没有打出去，重试后会重新打款。',
      'unstick-failed':
        '确定把这张单标记为失败？\n' +
        '请先核对渠道是否已打款 —— 标记失败后商家可以对该期重新申请。',
      'unstick-redo':
        '⚠️ 这张单可能已经打款！\n' +
        '重新打款会重复打款。请先核对渠道是否已到账。确认继续？',
    };
    if (!confirm(confirms[action])) {
      return;
    }

    // ⚠️ **原因必填** —— 涉及钱的操作不能没有理由（会记进操作留痕）
    const answer = prompt('请填写操作原因（会记进操作留痕）');
    const trimmed = (answer ?? '').trim();
    if (!trimmed) {
      setFailure('必须填写操作原因');
      return;
    }

    busyRef.current = true;
    setBusy(true);
    setFailure(null);

    try {
      const url =
        action === 'retry'
          ? `/api/billing/payouts/${payoutId}/retry`
          : `/api/billing/payouts/${payoutId}/unstick`;
      const body =
        action === 'retry'
          ? { reason: trimmed }
          : {
              to: action === 'unstick-failed' ? 'FAILED' : 'APPROVED',
              reason: trimmed,
            };
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const problem = await readFailure(response, FAILURE_TEXT);
      if (problem) throw new Error(problem);

      // ⚠️ **成功后必须 router.refresh()**（与现有 `run` 同款）
      router.refresh();
    } catch (cause) {
      setFailure(
        `${FAILURE_TEXT}：${cause instanceof Error ? cause.message : '未知错误'}`,
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
```

⚠️ **复用现有的 `readFailure` 与 `FAILURE_TEXT`**（文件里已有），
不要另写一份。

③ 渲染部分：把现有的

```tsx
  if (status !== 'REQUESTED') {
    return (
      <p className="text-sm text-muted-foreground">
        该出款单当前是「{describePayoutStatus(status)}」，没有可执行的审批操作。
      </p>
    );
  }
```

改成**按状态分别渲染**（把 `FAILED` 与 `PROCESSING` 两个分支放在它前面）：

```tsx
  if (status === 'FAILED') {
    return (
      <div className="flex flex-col gap-2">
        {failedBeforePayout ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => runManual('retry')}
          >
            {busy ? '处理中…' : '重试'}
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">
            该单可能已打款（渠道调过了，只是没成功回包），不能直接重试。
            请先核对渠道是否已到账。
          </p>
        )}
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
      </div>
    );
  }

  if (status === 'PROCESSING') {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm text-destructive">
          ⚠️ 这张单可能已经打款（卡在「打款中」超过 10 分钟）。
          重新打款会重复打款，请先核对渠道。
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => runManual('unstick-failed')}
          >
            {busy ? '处理中…' : '标记为失败'}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => runManual('unstick-redo')}
          >
            {busy ? '处理中…' : '重新打款'}
          </Button>
        </div>
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
      </div>
    );
  }

  if (status !== 'REQUESTED') {
    return (
      <p className="text-sm text-muted-foreground">
        该出款单当前是「{describePayoutStatus(status)}」，没有可执行的审批操作。
      </p>
    );
  }
```

⚠️ **原文件里 `status !== 'REQUESTED'` 的那段「没有可执行的审批操作」要保留**
（它管的是 `REQUESTED` 之外的、`FAILED` / `PROCESSING` 之外的分支）。

- [ ] **Step 4: 加两个中转路由**

⚠️ **平台端的写操作都走同源中转**（`platform-admin/src/app/api/billing/...`），
不直连后端。照 `.../payouts/[id]/reject/route.ts` 的写法。

新建 `platform-admin/src/app/api/billing/payouts/[id]/retry/route.ts`：

```ts
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 人工重试出款的中转：POST /api/billing/payouts/:id/retry。
 *
 * ⚠️ **请求体按白名单重建**：客户端传来的 body 是不受信任的输入，
 *    只取 `reason`，其余字段一律丢掉。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ message: '请求体不是合法 JSON' }, { status: 400 });
  }

  const body = raw as { reason?: unknown };
  // ⚠️ **原因必填** —— 涉及钱的操作不能没有理由（会记进操作留痕）
  if (typeof body.reason !== 'string' || body.reason.trim() === '') {
    return NextResponse.json(
      { message: '必须填写操作原因' },
      { status: 400 },
    );
  }
  if (body.reason.length > 500) {
    return NextResponse.json(
      { message: '操作原因不能超过 500 字' },
      { status: 400 },
    );
  }

  try {
    const result = await apiFetch(`/platform/payouts/${id}/retry`, {
      method: 'POST',
      body: { reason: body.reason.trim() },
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
```

新建 `platform-admin/src/app/api/billing/payouts/[id]/unstick/route.ts`：

```ts
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 解除卡单的中转：POST /api/billing/payouts/:id/unstick。
 *
 * ⚠️ **请求体按白名单重建**：只取 `to` 与 `reason`。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ message: '请求体不是合法 JSON' }, { status: 400 });
  }

  const body = raw as { to?: unknown; reason?: unknown };
  // ⚠️ **「重新打款」的 `to` 绝不能有默认值** —— 默认成 `FAILED` 的话，
  //    运营漏传就会**静默走错方向**（把「重打」变成「标记失败」）。
  if (body.to !== 'FAILED' && body.to !== 'APPROVED') {
    return NextResponse.json(
      { message: '必须指定目标状态（FAILED 或 APPROVED）' },
      { status: 400 },
    );
  }
  if (typeof body.reason !== 'string' || body.reason.trim() === '') {
    return NextResponse.json(
      { message: '必须填写操作原因' },
      { status: 400 },
    );
  }
  if (body.reason.length > 500) {
    return NextResponse.json(
      { message: '操作原因不能超过 500 字' },
      { status: 400 },
    );
  }

  try {
    const result = await apiFetch(`/platform/payouts/${id}/unstick`, {
      method: 'POST',
      body: { to: body.to, reason: body.reason.trim() },
      token: session.accessToken,
    });
    return NextResponse.json(result);
  } catch (cause) {
    return toErrorResponse(cause);
  }
}
```

- [ ] **Step 4b: 详情接口带上「操作记录」，前端展示**

⚠️ **留痕表建了、写了，但界面上看不到 → 运营不知道自己做過什么**。

① 后端 `api/src/modules/billing/payout.service.ts` 的 `detailForPlatform`
（`:750` 附近，它已经在 `toPlatformView` 的结果上加了 `entries`）→ 再加上：

```ts
      // ⚠️ **操作记录只在详情接口查** —— 放进 `toPlatformView` 会让
      //    **列表页的每一行都多查一次**（N+1）。
      const operations = await this.prisma.payoutOperation.findMany({
        where: { payoutId: id },
        orderBy: { operatedAt: 'desc' },
      });
```

并把 `operations` 加进返回对象（每项给出 `action / operatorId / operatedAt /
reason / fromStatus / toStatus`）。

⚠️ **`PlatformPayoutDetail` 要加 `operations` 的类型声明**（在
`api/src/modules/billing/payout.service.ts` 的接口里 + `platform-admin/src/lib/payout.ts`）。

② 前端 `platform-admin/src/app/(dashboard)/payouts/[id]/page.tsx` 里，
在「失败详情」那一段之后加：

```tsx
            {/* ⚠️ **操作记录** —— 涉及钱的操作必须能追溯「谁在什么时候
                把这张单怎么了」。留痕写进库里还不够，要看得见。 */}
            {payout.operations.length > 0 && (
              <div className="flex flex-col gap-1 border-t pt-2 text-sm">
                <span className="text-muted-foreground">操作记录</span>
                {payout.operations.map((op) => (
                  <p key={op.id} className="text-muted-foreground">
                    {formatDateTime(op.operatedAt)} ·{' '}
                    {describePayoutOperation(op.action)} · {op.reason}
                  </p>
                ))}
              </div>
            )}
```

③ `platform-admin/src/lib/payout.ts` 里加一个文案函数：

```ts
/**
 * 人工操作类型 → 中文文案（阶段 5l）。
 *
 * ⚠️ **未知类型回落到「人工操作」** —— 不显示裸枚举。
 */
export function describePayoutOperation(action: string): string {
  const labels: Record<string, string> = {
    RETRY: '重试出款',
    UNSTUCK_TO_FAILED: '解除卡单（标记为失败）',
    UNSTUCK_TO_APPROVED: '解除卡单（重新打款）',
  };
  return labels[action] ?? '人工操作';
}
```

⚠️ **`formatDateTime` 从 `@/lib/billing` import**（复用，不要另写一份）。

- [ ] **Step 5: 详情页把新 props 传下去**

在 `platform-admin/src/app/(dashboard)/payouts/[id]/page.tsx` 的 `<PayoutActions ... />` 上加：

```tsx
            failedBeforePayout={payout.failedBeforePayout}
```

⚠️ **`PlatformPayoutDetail` 也要加 `failedBeforePayout: boolean`**（在
`platform-admin/src/lib/payout.ts`）。

- [ ] **Step 6: 跑测试**

```bash
cd platform-admin && npx vitest run test/components/payout-actions.test.tsx
```

Expected: PASS —— 原有 16 条 + 新增 3 条全绿。

- [ ] **Step 7: 编译**

```bash
cd platform-admin && npx tsc --noEmit && npm run build
```

Expected: 无错。

---

### Task 6: 三处列表的分页

**Files:**
- Modify: `merchant-admin/src/app/(dashboard)/settlements/page.tsx`
- Modify: `platform-admin/src/app/(dashboard)/payouts/page.tsx`
- Modify: `api/src/modules/billing/settlement.service.ts`（新增明细分页方法）
- Modify: `api/src/modules/billing/platform-settlement.controller.ts`（新增端点）
- Modify: `platform-admin/src/app/(dashboard)/settlements/[id]/page.tsx`（明细翻页）

- [ ] **Step 1: 出款列表改成读 `searchParams`（两端各一份）**

⚠️ **纯服务端翻页**（用 `<Link>`），**不引入客户端组件** —— 出款列表页现在是
Server Component，`<Link href="?page=2">` 就能翻，零客户端 JS。

① `merchant-admin/src/app/(dashboard)/settlements/page.tsx`：

```tsx
export default async function PayoutsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; pageSize?: string }>;
}) {
  // ⚠️ **页码与每页条数从 URL 读** —— 纯服务端翻页，不需要客户端组件
  const params = await searchParams;
  const page = Math.max(1, Number(params.page ?? '1') || 1);
  const pageSize = Math.min(
    100,
    Math.max(1, Number(params.pageSize ?? '100') || 100),
  );
  // …fetch 时带上 ?page=&pageSize=
}
```

⚠️ **`pageSize` 的默认必须是 100** —— 现有页面显式请求 100，改成 20 会被
当成「数据丢了」（设计 §五·5.2）。

⚠️ **每页条数三档（20 / 50 / 100）用 `<Link>` 实现**（三个链接，不做下拉框）：

```tsx
        {/* ⚠️ **每页条数三档** —— 默认 100（与改造前一致） */}
        <div className="flex gap-2 text-sm">
          {[20, 50, 100].map((size) => (
            <Link
              key={size}
              href={`?pageSize=${size}`}
              className={
                size === pageSize ? 'underline font-medium' : 'underline-offset-4 hover:underline'
              }
            >
              {size}
            </Link>
          ))}
        </div>
```

② 翻页控件：

```tsx
        {/* ⚠️ **翻页** —— 纯服务端：`<Link>` 改 URL，Server Component 重渲染 */}
        {totalPages > 1 && (
          <div className="flex items-center gap-4 text-sm">
            <Link
              href={`?page=${Math.max(1, page - 1)}&pageSize=${pageSize}`}
              className={page <= 1 ? 'pointer-events-none opacity-40' : 'underline-offset-4 hover:underline'}
            >
              上一页
            </Link>
            <span>
              第 {page} / {totalPages} 页，共 {data.total} 张
            </span>
            <Link
              href={`?page=${Math.min(totalPages, page + 1)}&pageSize=${pageSize}`}
              className={page >= totalPages ? 'pointer-events-none opacity-40' : 'underline-offset-4 hover:underline'}
            >
              下一页
            </Link>
          </div>
        )}
```

⚠️ **`totalPages = Math.max(1, Math.ceil(total / pageSize))`**。

⚠️ **平台端出款列表有按周期筛选** → 筛选变化时页码要重置为 1
（把 `period` 也带进 `<Link>` 的 query）。

⚠️ **平台端列表上那句「超过 100 张时请按周期筛选」要撤掉**（有翻页就不必靠筛选）。

- [ ] **Step 2: 结算单明细的分页端点**

在 `api/src/modules/billing/settlement.service.ts` 里加一个方法：

```ts
  /**
   * 结算单明细的分页查询（阶段 5l）。
   *
   * ⚠️ **与详情接口分开** —— 详情接口的 `entries` 是**无上限全量返回**，
   *    改它会破坏现有消费者（平台端页面 + 相关 e2e），且**语义变了**
   *    （从「全部」变成「一页」）。
   *
   * ⚠️ **只返回条目本身** —— `missingEntryCount`（缺笔数）与
   *    `canRecalculate`（有没有出款单引用）是**整单级**判定，
   *    留在详情接口（放一页明细里会让人误以为是「这一页的缺笔数」）。
   */
  async listEntries(
    statementId: string,
    query: { page?: number; pageSize?: number },
  ): Promise<{
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
  }> {
    const { page, pageSize } = clampPagination(query.page, query.pageSize);

    // ⚠️⚠️ **必须「全量查 → 排序 → 内存切片」，不能 `skip`/`take`** ——
    //    排序键 `occurredAt` 在 `commission_entries` 上，而关联行
    //    `settlement_statement_entries` 上没有它 → 数据库层排不了。
    //    若先 `skip/take` 再排序，拿到的是「关联表顺序里的前 N 条」，
    //    **不是**「按发生时间的前 N 条」→ 翻页时会漏行/重复。
    //
    //    ⚠️ 详情接口本来就是全量返回（`detail` 的 `entries` 没有上限），
    //    所以这里不会比它更差 —— 省下的是**前端的渲染量**。
    const links = await this.prisma.settlementStatementEntry.findMany({
      where: { statementId },
    });
    const total = links.length;
    const entryIds = links.map((link) => link.entryId);
    const entries =
      entryIds.length > 0
        ? await this.prisma.commissionEntry.findMany({
            where: { id: { in: entryIds } },
          })
        : [];
    const byId = new Map(entries.map((e) => [e.id, e]));
    const all = links.flatMap((link) => {
      const entry = byId.get(link.entryId);
      // ⚠️ **查不到就跳过而不是崩**（与详情接口同款）
      if (!entry) return [];
      return [
        {
          entryId: entry.id,
          orderNo: entry.orderNo,
          type: entry.type,
          amount: entry.amount,
          rateBps: entry.rateBps,
          baseAmount: entry.baseAmount,
          occurredAt: entry.occurredAt.toISOString(),
        },
      ];
    });
    // ⚠️ **按发生时间排序** —— 与详情接口逐字一致（关联行的顺序是任意的）
    all.sort((a, b) =>
      a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0,
    );
    const items = all.slice((page - 1) * pageSize, page * pageSize);
    return { items, total, page, pageSize };
  }
```

⚠️ **`clampPagination` 要 import**（`../../common/http/pagination`）。
✅ **字段名已核实**（`schema.prisma` 的 `CommissionEntry`）：
`id / orderNo / type / amount / rateBps / baseAmount / occurredAt` ——
与详情接口的 `detailEntries` **逐字一致**（`:939` 起）。

- [ ] **Step 3: 加端点**

在 `api/src/modules/billing/platform-settlement.controller.ts` 里加：

```ts
  @Get('settlements/:id/entries')
  @ApiOperation({ summary: '结算单明细（分页）' })
  async entries(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.settlements.listEntries(id, {
      page: toIntOr(page, undefined),
      pageSize: toIntOr(pageSize, undefined),
    });
  }
```

⚠️ **`toIntOr` 从 `../../common/http/pagination` import**。

- [ ] **Step 4: 结算单详情页的明细翻页**

在 `platform-admin/src/app/(dashboard)/settlements/[id]/page.tsx` 里，把明细表改成
「先渲染当前页 + 底部翻页」。

⚠️ **详情页现在用的是 `payout.entries` / `statement.entries` 全量** ——
改成调新的分页端点拿当前页。

⚠️ **页码也要从 `searchParams` 读**（与 Task 6·Step 1 同款）。

- [ ] **Step 5: 跑测试 + 编译**

```bash
cd api && npx tsc --noEmit && npm run build
cd ../platform-admin && npx tsc --noEmit && npm run build
cd ../merchant-admin && npx tsc --noEmit && npm run build
```

Expected: 无错。

---

### Task 7: e2e / 失败注入 / 手测 / 验收记录

**Files:**
- Create: `api/test/payout-ops.e2e-spec.ts`
- Create: `docs/superpowers/plans/2026-10-30-plan-05l-payout-ops-acceptance.md`
- Modify: `docs/superpowers/plans/2026-10-30-plan-05j-fund-security-ledger-closure-acceptance.md`（本阶段未改它 —— 若无更正就不用动）

- [ ] **Step 1: 写 e2e**

新建 `api/test/payout-ops.e2e-spec.ts`，覆盖：

| 用例 | 断言 |
|------|------|
| 重试 | `FAILED` + `failedBeforePayout = true` → 状态回 `APPROVED`、**明细被重新纳入**（`payout_entries` 里该 `payoutId` 有行）、`attemptCount` 归零、`payout_operations` 有一行 `RETRY` |
| 重试 | `failedBeforePayout = false` → **409**，状态不变 |
| 重试 | 该期有别的活跃单 → **409**，消息含那张单的 `payoutNo` |
| 重试 | 期间金额变了 → **409** |
| 解卡 | `PROCESSING` → `FAILED`：明细**被释放**、留痕一行 `UNSTUCK_TO_FAILED` |
| 解卡 | `PROCESSING` → `APPROVED`：明细**仍被占着**、`attemptCount` 归零、留痕一行 `UNSTUCK_TO_APPROVED` |
| 解卡 | `processingAt` 还在阈值内 → **409** |
| 口径 | 商家端 `failureReason` **不含**渠道原文；平台端 `failureDetail` **含**原文 |
| 并发 | 两个超管同时点重试 → 一个成功一个 409 |

⚠️ **造数**：直接用 Prisma 插 `payouts` 行（带 `failedBeforePayout` 与快照字段），
参照 `api/test/payout-encryption.e2e-spec.ts` 的 `asPlatform` / `createMerchant` 用法。
⚠️ **每个用例的造数都要在 `finally` 里清掉**（真库）。

- [ ] **Step 2: 跑 e2e**

```bash
cd api && npm run test:e2e -- payout-ops
```

Expected: PASS。

- [ ] **Step 3: 失败注入**

⚠️ **失败注入必须独占跑**（不与全量测试并发）。

| 编号 | 注入 | 期望 |
|------|------|------|
| **H1** | 去掉 `retry` 里 `failedBeforePayout = true` 的检查 | 「`failedBeforePayout = false` → 409」那条挂 |
| **H2** | 去掉重试前的活跃单检查 | 「该期有别的活跃单 → 409」那条挂（撞 P2002 → 500） |
| **H3** | 解卡转 `APPROVED` 时也 `deleteMany` 明细 | 「明细仍被占着」那条挂 |
| **H4** | `toView` 的 `failureReason` 改回原文 | 「商家端不含渠道原文」那条挂 |
| **H5** | `markFailed` 的 worker 调用点全传 `false` | 「打款前的失败 → 标记确定没打」那条挂 |
| **H6** | 去掉重试时「重新纳入明细」 | 「明细被重新纳入」那条挂 |
| **H7** | 去掉解卡时「`processingAt` 未超阈值」的检查 | 「未超阈值 → 409」那条挂 |

每条：改 → 跑**那一个** e2e 文件 → 确认挂 → **还原** → `git diff --stat` 确认干净。

- [ ] **Step 4: 跑全量**

```bash
cd api && npm test && npm run test:e2e
cd ../merchant-admin && npx vitest run
cd ../platform-admin && npx vitest run
```

Expected: 全绿。

- [ ] **Step 5: 浏览器手测（7 步）**

⚠️ **需要重建镜像**（容器跑的是构建产物，不挂源码卷）：

```bash
cd /Users/tom/orca/workspaces/电商项目/电商项目
docker compose -f infra/docker-compose.yml build api merchant-admin platform-admin
docker compose -f infra/docker-compose.yml up -d api merchant-admin platform-admin
```

| 步 | 内容 | 期望 |
|----|------|------|
| 1 | 平台端出款列表 → 能翻页 | 页码与总数正确，第 2 页不是第 1 页的重复 |
| 2 | 商家端出款列表 → 能翻页 | 同上 |
| 3 | 平台端某张 `FAILED` 单 → 「失败原因」与「失败详情」两行 | 详情是渠道原文 |
| 4 | 商家端同一张单 → 只看到业务口径 | **看不到**原文 |
| 5 | 平台端 `FAILED` + `failedBeforePayout = true` 的单 | 有「重试」按钮 |
| 6 | 平台端 `FAILED` + `failedBeforePayout = false` 的单 | **没有**「重试」按钮，有「可能已打款」的说明 |
| 7 | 平台端一张卡住的 `PROCESSING` 单 | 能解卡，两个方向都有警示与必填原因 |

⚠️ **手测用 ego lite**，先 `pgrep -f "ego lite"` 检查复用，**不得抢前台**，
结束后清理标签页。

- [ ] **Step 6: 写验收记录**

新建 `docs/superpowers/plans/2026-10-30-plan-05l-payout-ops-acceptance.md`，至少包含：

- 交付范围（设计 §八 的 7 件事）
- 自动化测试结果（贴命令与数字）
- 失败注入 H1~H7 的逐条结果
- 手测 7 步的结果
- 遗留与风险（照抄设计 §七·7.1 与 §七·7.3）

---

## 附录 A：文件清单速查

| 文件 | 动作 | Task |
|------|------|------|
| `api/prisma/schema.prisma` | 改 | 1 |
| `api/prisma/migrations/20261030130000_add_payout_ops/migration.sql` | **新建** | 1 |
| `api/src/common/tenant/tenant-models.ts` | 改（注释） | 1 |
| `api/src/modules/billing/payout-execution.service.ts` | 改 | 2 |
| `api/src/modules/payment/payout.worker.ts` | 改 | 2 |
| `api/src/modules/billing/payout.service.ts` | 改 | 3、4 |
| `api/src/modules/billing/dto/payout-manual-action.dto.ts` | **新建** | 3 |
| `api/src/modules/billing/platform-payout.controller.ts` | 改 | 3 |
| `api/src/modules/billing/settlement.service.ts` | 改 | 6 |
| `api/src/modules/billing/platform-settlement.controller.ts` | 改 | 6 |
| `platform-admin/src/lib/payout.ts` | 改 | 4、5 |
| `platform-admin/src/app/(dashboard)/payouts/[id]/page.tsx` | 改 | 4、5 |
| `platform-admin/src/app/(dashboard)/payouts/payout-actions.tsx` | 改 | 5 |
| `platform-admin/src/app/api/billing/payouts/[id]/retry/route.ts` | **新建** | 5 |
| `platform-admin/src/app/api/billing/payouts/[id]/unstick/route.ts` | **新建** | 5 |
| `platform-admin/src/app/(dashboard)/payouts/page.tsx` | 改 | 6 |
| `platform-admin/src/app/(dashboard)/settlements/[id]/page.tsx` | 改 | 6 |
| `merchant-admin/src/app/(dashboard)/settlements/page.tsx` | 改 | 6 |
| `api/test/payout-ops.e2e-spec.ts` | **新建** | 7 |
| `docs/superpowers/plans/2026-10-30-plan-05l-payout-ops-acceptance.md` | **新建** | 7 |
| `api/src/modules/billing/payout-execution.service.spec.ts` | 改 | 2 |
| `api/src/modules/payment/payout-worker.spec.ts` | 改 | 2 |
| `api/src/modules/billing/payout.service.spec.ts` | 改 | 3、4 |
| `platform-admin/test/components/payout-actions.test.tsx` | 改 | 5 |
