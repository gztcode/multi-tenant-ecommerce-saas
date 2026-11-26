# 阶段 5k「资金链路收尾」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 堵住阶段 5j 引入的「解密失败 → 出款单无限重试」失效链，让商家端能看见收款账户，并把失败原因的口径统一（内部原文只进日志）。

**Architecture:** 后端三处改动 —— `PayoutExecutionService.claimForExecution` 把解密异常**捕获**成 `accountError`（不再抛错回滚事务），`PayoutWorker` 在 `checkGates` 之前判 `accountError` → 落 `FAILED`（业务口径），入队失败的 `failureReason` 去掉原始异常消息；再加一个启动时的**单行**账目密钥自检。前端只动商家端两个文件（`lib/payout.ts` 与三个页面），后端**零改动**就能把三个快照字段送到商家端。

**Tech Stack:** NestJS 11 + Prisma 6 + BullMQ + Jest（单测）+ Jest/Supertest（e2e）+ Next.js 15 + React 19 + Vitest。

**设计依据：** `docs/superpowers/specs/2026-10-30-plan-05k-fund-closure-design.md`（阶段 5k 设计，已过独立审查）。

---

## 0. 实施须知

### 0.1 本机环境

| 组件 | 地址 | 说明 |
|------|------|------|
| Postgres（测试库） | `localhost:15432` | `DATABASE_URL_TEST` 在 `api/.env` 里 |
| Redis | `localhost:16380` | e2e 用 `bull-e2e` 前缀，与开发环境隔离 |
| API | `localhost:3000` | |
| merchant-admin | `localhost:3002` | |
| platform-admin | `localhost:3003` | |

### 0.2 命令

```bash
# 单测（rootDir 是 api/src）
cd api && npx jest src/modules/billing/payout-execution.service.spec.ts
cd api && npx jest src/modules/payment/payout-worker.spec.ts
cd api && npx jest src/modules/billing/payout.service.spec.ts
cd api && npx jest src/modules/billing/payout-encryption-self-check.service.spec.ts

# 全量单测
cd api && npm test

# e2e（会先清空测试库 + seed）
cd api && npm run test:e2e -- payout-encryption

# 类型检查 / 编译
cd api && npm run build
cd merchant-admin && npx tsc --noEmit && npm run build
cd platform-admin && npx tsc --noEmit && npm run build
```

⚠️ **失败注入必须独占跑**（不与全量测试并发）—— 注入期间源码是坏的，并发跑别的用例会出假失败。

⚠️ **e2e 跑在真库上**（`DATABASE_URL_TEST`）—— 任何改动测试库数据的用例都必须在 `finally` 里还原。

### 0.3 提交纪律

⚠️ **实施代理不提交**（agent-team 模式）—— 代理只改代码 + 跑定向测试，**由协调者统一提交**。

---

### Task 1: `claimForExecution` 捕获解密异常

**要解决的问题：** 解密抛错 → 事务回滚 → 单子停在 `APPROVED`（`attemptCount=0`）→ 兜底扫描把它当成「审批后入队失败」重新入队 → **每 5 分钟无限循环**（设计 §二·2.1，有实测数据）。

**Files:**
- Modify: `api/src/modules/billing/payout-execution.service.ts`
- Test: `api/src/modules/billing/payout-execution.service.spec.ts`

- [ ] **Step 1: 改写单测 —— 「版本 0 抛错」改成「不抛错，`accountError` 带着根因」**

在 `api/src/modules/billing/payout-execution.service.spec.ts` 里，把这段：

```ts
    it('⚠️ 快照还没加密（版本 0）→ 抛错，绝不按明文兜底', async () => {
      // ⚠️ **「忘了迁移」若被静默当成「就是明文」，等于把加密悄悄关掉了** ——
      //    所以版本号不对必须响亮地失败。
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

      await expect(
        service.claimForExecution('payout-a', new Date()),
      ).rejects.toThrow(/尚未加密/);
    });
```

替换成：

```ts
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
```

- [ ] **Step 2: 跑单测，确认失败**

Run: `cd api && npx jest src/modules/billing/payout-execution.service.spec.ts`

Expected: FAIL —— `accountError` 不在 `ExecutionClaim` 上（TypeScript 编译错）或 `claim.accountError` 为 `undefined`。

- [ ] **Step 3: `ExecutionClaim` 加 `accountError` 字段**

在 `api/src/modules/billing/payout-execution.service.ts` 里，把 `ExecutionClaim` 接口改成：

```ts
/** 「我抢到了这张单」的凭据（worker 拿去调渠道） */
export interface ExecutionClaim {
  /** 递增后的尝试次数（第一次 = 1） */
  attemptCount: number;
  /** 审批锁定的应结金额（整数分）—— worker **用它**，不重算 */
  netAmount: number;
  /** 出款单号（渠道对账单上显示的） */
  payoutNo: string;
  /**
   * **解密失败**时的内部根因（给日志看）。
   *
   * ⚠️ **非 null = 解密失败**（根因在这里）。
   * ⚠️ **null 且 `account` 也为 null = 快照本就没有账号**
   *    （历史单压根没抄账户）—— 由 `checkGates` 报「收款账号信息异常」。
   * ⚠️ **null 且 `account` 非 null = 解密成功，账户可用**。
   */
  accountError: string | null;
  /** 收款账户快照（**不是**实时查的） */
  account: {
    accountName: string;
    bankName: string;
    accountNo: string;
  } | null;
}
```

- [ ] **Step 4: `claimForExecution` 把解密从「抛错」改成「捕获」**

在同文件 `claimForExecution` 里，把这一段：

```ts
        return {
          attemptCount: payout.attemptCount,
          netAmount: payout.netAmount,
          payoutNo: payout.payoutNo,
          account: payout.snapshotAccountNoCipher
            ? {
                accountName: payout.snapshotAccountName ?? '',
                bankName: payout.snapshotBankName ?? '',
                // ⚠️ **这里是全仓唯一给渠道明文账号的地方**。
                //    快照的版本号不对（没迁移）→ 直接抛错，
                //    不能拿明文兜底（那等于把加密悄悄关掉）。
                accountNo: this.cipher.decryptVersioned(
                  payout.snapshotAccountNoCipher,
                  payout.snapshotEncryptionVersion,
                  '出款单的收款账号快照',
                ),
              }
            : null,
        };
```

替换成：

```ts
        // ⚠️ **解密失败不抛错** —— 抛错会让整个事务回滚，单子停在
        //    `APPROVED` 且 `attemptCount` 一起被回滚 → 兜底扫描把它当成
        //    「审批后入队失败」重新入队 → **每 5 分钟无限循环**
        //    （设计 §二·2.1，有实测数据）。
        //
        // ⚠️ **底层照样响亮地失败**：`decryptVersioned` 抛带中文原因的错，
        //    这里只是把**处置**从「抛给 BullMQ」改成「捕获 → 记日志 → 落 FAILED」。
        let account: ExecutionClaim['account'] = null;
        let accountError: string | null = null;

        if (payout.snapshotAccountNoCipher) {
          try {
            account = {
              accountName: payout.snapshotAccountName ?? '',
              bankName: payout.snapshotBankName ?? '',
              // ⚠️ **这里是全仓唯一给渠道明文账号的地方**。
              accountNo: this.cipher.decryptVersioned(
                payout.snapshotAccountNoCipher,
                payout.snapshotEncryptionVersion,
                '出款单的收款账号快照',
              ),
            };
          } catch (error) {
            // ⚠️ **捕获而不抛出**：让事务照常提交（单子进 PROCESSING），
            //    由 worker 落 FAILED。
            //
            // ⚠️ **绝不按明文兜底**：`account` 保持 null ——
            //    「忘了迁移」若被静默当成「就是明文」，等于把加密悄悄关掉。
            accountError =
              error instanceof Error ? error.message : String(error);
          }
        }

        return {
          attemptCount: payout.attemptCount,
          netAmount: payout.netAmount,
          payoutNo: payout.payoutNo,
          accountError,
          account,
        };
```

- [ ] **Step 5: 跑单测，确认通过**

Run: `cd api && npx jest src/modules/billing/payout-execution.service.spec.ts`

Expected: PASS —— 全部用例绿（含新增的两条）。

- [ ] **Step 6: 跑全量单测，确认没有回归**

Run: `cd api && npm test`

Expected: PASS —— 没有别的用例依赖「解密失败会抛错」这个旧行为。

⚠️ **`payout-cipher.service.spec.ts` 的 12 条单测一个字都不用改** —— 底层 `decryptVersioned` 的行为没变。

---

### Task 2: worker 的 `accountError` 分支 + 闸的业务口径

**要解决的问题：** 解密失败的单要落 `FAILED`（**确定没打钱** —— 解密在调渠道之前），而不是卡在 `APPROVED` 无限重试。

**Files:**
- Modify: `api/src/modules/payment/payout.worker.ts`
- Test: `api/src/modules/payment/payout-worker.spec.ts`

- [ ] **Step 1: 新增单测 —— `accountError` 非 null → 落 `FAILED` 且理由是业务口径**

在 `api/src/modules/payment/payout-worker.spec.ts` 里，在 `describe('PayoutWorker', ...)` 内加：

```ts
  it('⚠️ 解密失败（accountError）→ 落 FAILED，不调渠道，理由是业务口径', async () => {
    const execution = fakeExecution({
      ...claim,
      account: null,
      accountError:
        '出款单的收款账号快照 尚未加密（版本 0），请先执行 `npm run migrate:payout-encryption` 再重试。',
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

    // ⚠️ **钱绝不能打出去** —— 解密失败发生在调渠道之前
    expect(provider.execute).not.toHaveBeenCalled();
    expect(execution.markPaid).not.toHaveBeenCalled();
    expect(execution.markFailed).toHaveBeenCalled();

    const call = execution.markFailed.mock.calls[0] as unknown as [
      string,
      { reason: string },
    ];
    const reason = call[1].reason;
    // ⚠️ **界面文案必须是业务口径** —— 商家看到「密钥不匹配」会以为
    //    自己的银行账号被篡改了
    expect(reason).not.toContain('尚未加密');
    expect(reason).not.toContain('密钥不匹配');
    expect(reason).not.toContain('migrate:payout-encryption');
    // ⚠️ **文案要自证「没打钱」** —— 商家端对所有 FAILED 都会接一句
    //    「请联系平台确认出款情况」，不说清楚商家会以为钱可能已经打出去
    expect(reason).toContain('本次未打款');
  });
```

- [ ] **Step 2: 跑单测，确认失败**

Run: `cd api && npx jest src/modules/payment/payout-worker.spec.ts`

Expected: FAIL —— worker 还没判 `accountError`，会走到 `checkGates` 并给出「收款账户快照缺失」。

- [ ] **Step 3: worker 在 `checkGates` 之前判 `accountError`**

在 `api/src/modules/payment/payout.worker.ts` 的 `runExecute` 里，把：

```ts
    // ---- STEP 1.5：两道「打之前」的闸 ----
    // ⚠️ **都不调渠道**：不满足条件就不该打钱。
    const gateFailure = this.checkGates(claim);
```

替换成：

```ts
    // ---- STEP 1.5：打款前的闸 ----
    //
    // ⚠️ **解密失败必须在 `checkGates` 之前判** —— 否则 `account` 为 null
    //    会让 `checkGates` 报「收款账户快照缺失」，把真实原因盖掉。
    //
    // ⚠️ **落 FAILED 是安全的**：解密发生在**调渠道之前** → 渠道从未被调用
    //    → **确定没打钱**。这与「卡在 PROCESSING」（钱可能已打出去）语义相反，
    //    不能套用同一套处置（设计 §二·2.2）。
    if (claim.accountError) {
      // ⚠️ **根因只进日志** —— `decryptVersioned` 的消息里有「密钥不匹配」
      //    「密文已被篡改」「版本 0」这类内部术语，商家看到会恐慌
      //    （界面口径见设计 §二·2.4）。
      this.logger.error(
        `出款 ${payoutId} 的收款账号快照不可用：${claim.accountError}`,
      );
      await this.execution.markFailed(payoutId, {
        // ⚠️ **文案要自证「没打钱」**
        reason: '收款账号信息异常，本次未打款，请更新收款账户后重新申请',
        failedAt: await this.prisma.databaseNow(),
      });
      return;
    }

    // ⚠️ **都不调渠道**：不满足条件就不该打钱。
    const gateFailure = this.checkGates(claim);
```

- [ ] **Step 4: 跑单测，确认通过**

Run: `cd api && npx jest src/modules/payment/payout-worker.spec.ts`

Expected: PASS —— Step 1 的新用例绿。

- [ ] **Step 5: 改写单测 —— 「账户快照缺失」的理由也必须是业务口径**

在同一个 spec 文件里，把这条用例：

```ts
  it('⚠️ 账户快照缺失 → 落 FAILED，不调渠道', async () => {
```

改成（并把断言补严）：

```ts
  it('⚠️ 账户快照缺失 → 落 FAILED，不调渠道，理由是业务口径', async () => {
    // ⚠️ **这条路径与「解密失败」对商家是同一件事**（账户不可用 → 没打钱
    //    → 更新账户后重新申请），差异只在根因（日志里）。
    //    所以 `failureReason` **完全相同**是有意的。
    const execution = fakeExecution({ ...claim, account: null });
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

    expect(provider.execute).not.toHaveBeenCalled();
    expect(execution.markFailed).toHaveBeenCalled();

    const call = execution.markFailed.mock.calls[0] as unknown as [
      string,
      { reason: string },
    ];
    // ⚠️ **不能是「收款账户快照缺失」** —— 商家会问「什么叫快照缺失」
    expect(call[1].reason).not.toContain('快照缺失');
    expect(call[1].reason).toContain('本次未打款');
  });
```

- [ ] **Step 6: 改 `checkGates` 的两条闸为业务口径**

在 `api/src/modules/payment/payout.worker.ts` 里，把 `checkGates` 改成：

```ts
  /**
   * 打款之前的两道闸。
   *
   * ⚠️ **理由一律用业务口径** —— 界面上的文案给商家看，
   *    内部术语（「快照缺失」「出款金额非法：-1 分」）商家看不懂，
   *    还会以为自己理解错了。
   *
   * @returns 失败原因（`null` = 闸都过了，可以打款）
   */
  private checkGates(claim: {
    netAmount: number;
    account: { accountNo: string } | null;
  }): string | null {
    if (claim.netAmount <= 0) {
      // ⚠️ **不暴露内部金额数字** —— 只说「异常」
      return '出款金额异常，本次未打款，请联系平台核对';
    }
    if (!claim.account) {
      return '收款账号信息异常，本次未打款，请更新收款账户后重新申请';
    }
    return null;
  }
```

- [ ] **Step 7: 跑单测，确认通过**

Run: `cd api && npx jest src/modules/payment/payout-worker.spec.ts`

Expected: PASS —— 全部绿。

- [ ] **Step 8: 跑全量单测**

Run: `cd api && npm test`

Expected: PASS。

---

### Task 3: 入队失败的口径统一 + 平台端「备注」行

**要解决的问题：** 入队失败时 `failureReason` 写的是 `入队失败，等待自动救援：${原始异常消息}` —— 原始消息可能是 Redis 的连接细节（主机名、端口）。它目前**没有界面消费者**（两端都只在 `FAILED` 时渲染失败原因，而入队失败停在 `APPROVED`），但一旦给 `APPROVED` 加渲染就会当场外泄 —— 所以要在**加渲染的同一个改动里**收掉（设计 §四）。

**Files:**
- Modify: `api/src/modules/billing/payout.service.ts:597-606`
- Modify: `platform-admin/src/app/(dashboard)/payouts/[id]/page.tsx`
- Test: `api/src/modules/billing/payout.service.spec.ts`

- [ ] **Step 1: 改写单测 —— `failureReason` 不含原始错误消息**

在 `api/src/modules/billing/payout.service.spec.ts` 里，把这条用例：

```ts
  it('⚠️ 入队失败不抛错：记 failureReason，审批照样成功', async () => {
```

的**断言部分**（末尾几行）改成：

```ts
    expect(view.id).toBe('payout-a');
    // ⚠️ **记了失败原因** → 运营看得见；兜底扫描会重新入队
    expect(prisma.payout.updateMany).toHaveBeenCalledTimes(1);
    const data = argsOf(prisma.payout.updateMany).data as {
      failureReason: string;
    };
    expect(data.failureReason).toContain('入队失败');
```

改为：

```ts
    expect(view.id).toBe('payout-a');
    // ⚠️ **记了失败原因** → 运营看得见；兜底扫描会重新入队
    expect(prisma.payout.updateMany).toHaveBeenCalledTimes(1);
    const data = argsOf(prisma.payout.updateMany).data as {
      failureReason: string;
    };
    expect(data.failureReason).toContain('打款任务提交失败');
    // ⚠️⚠️ **绝不能带原始异常消息** —— 那是 Redis 的连接细节
    //    （主机名、端口、连接错误）。内部原文只进日志。
    expect(data.failureReason).not.toContain('Redis 连不上');
    expect(data.failureReason).not.toContain('Redis');
```

- [ ] **Step 2: 跑单测，确认失败**

Run: `cd api && npx jest src/modules/billing/payout.service.spec.ts -t '入队失败'`

Expected: FAIL —— `failureReason` 还是 `入队失败，等待自动救援：Redis 连不上`。

- [ ] **Step 3: 改后端文案**

在 `api/src/modules/billing/payout.service.ts` 的 `approve` 方法里，把：

```ts
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await this.prisma.payout.updateMany({
          where: { id: updated.id, status: PayoutStatus.APPROVED },
          data: { failureReason: `入队失败，等待自动救援：${reason}` },
        });
        this.logger.error(
          `出款审批后入队失败：${updated.id} —— ${reason}（将由兜底扫描重新入队）`,
        );
      }
```

改成：

```ts
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await this.prisma.payout.updateMany({
          where: { id: updated.id, status: PayoutStatus.APPROVED },
          // ⚠️ **界面口径，不带原始异常消息** —— `reason` 可能是 Redis 的
          //    连接细节（主机名、端口、连接错误）。内部原文只进日志。
          //
          // ⚠️ **文案要说清「会自动重试」** —— 超管看到这句就知道
          //    兜底扫描会救它，不用手工干预。
          data: { failureReason: '打款任务提交失败，系统将自动重试' },
        });
        this.logger.error(
          `出款审批后入队失败：${updated.id} —— ${reason}（将由兜底扫描重新入队）`,
        );
      }
```

- [ ] **Step 4: 跑单测，确认通过**

Run: `cd api && npx jest src/modules/billing/payout.service.spec.ts`

Expected: PASS。

- [ ] **Step 5: 平台端加「备注」行**

在 `platform-admin/src/app/(dashboard)/payouts/[id]/page.tsx` 里，在失败原因那一段（`{payout.status === 'FAILED' && (...)}`）**之后**、「类型」那一行**之前**插入：

```tsx
            {/* ⚠️ **只在 APPROVED 时显示备注**：入队失败的单停在 APPROVED，
                而失败原因只在 FAILED 时渲染 → 这行是「这张单刚入队失败过、
                正在等兜底扫描救援」的**唯一信号**。

                ⚠️ **平台端加、商家端不加** —— 商家看到「已审批 + 系统将自动重试」
                只会困惑（「重试什么？是不是要我做什么？」），超管看到它就知道
                `scanStuck` 会救它。 */}
            {payout.status === 'APPROVED' && payout.failureReason && (
              <div className="flex justify-between py-2 text-sm text-muted-foreground">
                <span>备注</span>
                <span>{payout.failureReason}</span>
              </div>
            )}
```

- [ ] **Step 6: 编译平台端**

Run: `cd platform-admin && npx tsc --noEmit && npm run build`

Expected: 编译通过。

- [ ] **Step 7: 跑全量单测**

Run: `cd api && npm test`

Expected: PASS。

---

### Task 4: 启动时的账目密钥自检

**要解决的问题：** `api/.env` 的 `PAYOUT_ACCOUNT_ENCRYPTION_KEY` 与 `infra/docker-compose.yml` 的固定值必须逐字一致。不一致时容器解不开所有已加密的数据 → **每一张出款单都会 `FAILED`**，运营只能从日志里反推才知道是密钥错了。

⚠️ **只取一行，不扫全表**（5j 否决过全表扫描自检）。

**Files:**
- Create: `api/src/modules/billing/payout-encryption-self-check.service.ts`
- Create: `api/src/modules/billing/payout-encryption-self-check.service.spec.ts`
- Modify: `api/src/modules/billing/billing.module.ts`
- Modify: `api/src/main.ts`

- [ ] **Step 1: 新建单测文件**

创建 `api/src/modules/billing/payout-encryption-self-check.service.spec.ts`：

```ts
import { PayoutCipherService } from './payout-cipher.service';
import { PayoutEncryptionSelfCheck } from './payout-encryption-self-check.service';

/**
 * 账目加密自检的单元测试。
 *
 * ⚠️ **假 Prisma 是「配置驱动」的**（与 `payout-execution.service.spec.ts` 同款）：
 *    真实行为（租户作用域怎么附加）靠 e2e 验。
 */

/** 一只最小可用的假 Prisma */
function fakePrisma(options: {
  account?: unknown;
  payout?: unknown;
} = {}) {
  return {
    merchantPayoutAccount: {
      findFirst: jest.fn(() =>
        Promise.resolve(
          options.account === undefined ? null : options.account,
        ),
      ),
    },
    payout: {
      findFirst: jest.fn(() =>
        Promise.resolve(options.payout === undefined ? null : options.payout),
      ),
    },
  };
}

/**
 * ⚠️ **单元测试进程里没有 .env** —— `PayoutCipherService` 在构造时就要密钥，
 *    拿不到就直接抛错。所以这里显式设一个**测试用**密钥。
 */
const TEST_ENCRYPTION_KEY = 'test-payout-encryption-key-at-least-32-chars';

beforeAll(() => {
  process.env.PAYOUT_ACCOUNT_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
});

describe('PayoutEncryptionSelfCheck', () => {
  it('库里没有可校验的行 → 不抛错（新库不该因此起不来）', async () => {
    const service = new PayoutEncryptionSelfCheck(
      fakePrisma() as unknown as never,
      new PayoutCipherService(),
    );

    await expect(service.check()).resolves.toBeUndefined();
  });

  it('密文解得开 → 不抛错', async () => {
    const cipher = new PayoutCipherService();
    const service = new PayoutEncryptionSelfCheck(
      fakePrisma({
        account: {
          id: 'acc-1',
          accountNoCipher: cipher.encrypt('6222000000000000'),
        },
      }) as unknown as never,
      cipher,
    );

    await expect(service.check()).resolves.toBeUndefined();
  });

  it('⚠️ 密文是空串 → 抛错（空串是迁移留下的占位，不是「跳过」）', async () => {
    const service = new PayoutEncryptionSelfCheck(
      fakePrisma({
        account: { id: 'acc-1', accountNoCipher: '' },
      }) as unknown as never,
      new PayoutCipherService(),
    );

    await expect(service.check()).rejects.toThrow(/空串/);
  });

  it('⚠️ 密文解不开 → 抛错，且消息指明「哪张表」与「检查哪个环境变量」', async () => {
    const service = new PayoutEncryptionSelfCheck(
      fakePrisma({
        account: { id: 'acc-1', accountNoCipher: '这不是合法的密文' },
      }) as unknown as never,
      new PayoutCipherService(),
    );

    // ⚠️ **只断言「抛错」是没有牙齿的** —— 必须断言消息里说了什么，
    //    否则实施者把错误吞掉也算过
    await expect(service.check()).rejects.toThrow(
      /账目加密自检失败/,
    );
    await expect(service.check()).rejects.toThrow(
      /PAYOUT_ACCOUNT_ENCRYPTION_KEY/,
    );
    await expect(service.check()).rejects.toThrow(/商家收款账户/);
  });
});
```

- [ ] **Step 2: 跑单测，确认失败**

Run: `cd api && npx jest src/modules/billing/payout-encryption-self-check.service.spec.ts`

Expected: FAIL —— `Cannot find module './payout-encryption-self-check.service'`。

- [ ] **Step 3: 实现自检服务**

创建 `api/src/modules/billing/payout-encryption-self-check.service.ts`：

```ts
import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import {
  platformScope,
  tenantContext,
} from '../../common/tenant/tenant-context';
import { PayoutCipherService } from './payout-cipher.service';

/**
 * 启动时的账目加密自检（阶段 5k）。
 *
 * ⚠️ **只取一行，不扫全表** —— 阶段 5j 明确否决过「启动时全表扫描自检」
 *    （每次启动把所有行拉出来解密一遍，太贵）。
 *
 * ⚠️ **失败即退出** —— 带着解不开的密文跑着，运营看到的全是失败的出款单，
 *    没人知道根因在启动时就该发现。数据坏了就不该带着跑。
 */
@Injectable()
export class PayoutEncryptionSelfCheck {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly cipher: PayoutCipherService,
  ) {}

  /**
   * 启动自检：拿库里**一行**已加密的数据试解一次。
   *
   * ⚠️ **只校验 `encryptionVersion = 1` 的行** —— 版本 0 的行还没迁移，
   *    本来就解不开，不能因为它就让容器起不来。
   */
  async check(): Promise<void> {
    await tenantContext.run(platformScope(), async () => {
      // ⚠️ **两张表都要查**：只查账户行会漏掉「账户行被删、快照还在」的情形。
      //
      // ⚠️ **条件只用版本号** —— 版本号是「这行加密过没有」的权威依据
      //    （5j 设计 §2 的原则：不能靠「能不能解密」去猜）。
      const account = await this.prisma.merchantPayoutAccount.findFirst({
        where: { encryptionVersion: 1 },
        select: { id: true, accountNoCipher: true },
      });
      if (account) {
        this.tryDecrypt(account.accountNoCipher, '商家收款账户');
        return;
      }

      // ⚠️ **可空列必须用 `not: null`，不能用 `not: ''`** ——
      //    `snapshotAccountNoCipher` 是 `String?`（schema.prisma:1298），
      //    而 PostgreSQL 里 `col <> ''` 对 NULL 求值为 NULL（非 true）
      //    → `{ not: '' }` 会把 NULL 行一起排除，行为依赖 Prisma 版本，
      //    不该依赖。`not: null` 的语义是明确的。
      const payout = await this.prisma.payout.findFirst({
        where: {
          snapshotEncryptionVersion: 1,
          snapshotAccountNoCipher: { not: null },
        },
        select: { id: true, snapshotAccountNoCipher: true },
      });
      if (payout) {
        this.tryDecrypt(
          payout.snapshotAccountNoCipher as string,
          '出款单收款账号快照',
        );
      }
      // ⚠️ **两处都没有可校验的行 → 静默通过**：
      //    新库、或还没跑迁移的库（全是版本 0）都不该因此起不来。
    });
  }

  /**
   * 解一行；解不开就抛错让进程退出。
   *
   * ⚠️ **空串是脏数据，不是「跳过」** ——
   *    `accountNoCipher` 是 NOT NULL 列，空串只可能是迁移脚本留下的占位。
   *    跳过它就等于放过「正是自检要防的那种坏数据」。
   */
  private tryDecrypt(ciphertext: string, what: string): void {
    if (!ciphertext) {
      throw new Error(
        `账目加密自检失败：${what} 的密文是空串（迁移留下的占位或脏数据）。` +
          '请检查该数据是否已被 npm run migrate:payout-encryption 正确处理。',
      );
    }
    try {
      this.cipher.decryptVersioned(ciphertext, 1, what);
    } catch (error) {
      throw new Error(
        `账目加密自检失败：${what} 解不开（${
          error instanceof Error ? error.message : String(error)
        }）。` +
          '请检查 PAYOUT_ACCOUNT_ENCRYPTION_KEY 是否与加密时用的密钥一致' +
          '（本地 .env 与 infra/docker-compose.yml 必须逐字相同）。',
      );
    }
  }
}
```

- [ ] **Step 4: 跑单测，确认通过**

Run: `cd api && npx jest src/modules/billing/payout-encryption-self-check.service.spec.ts`

Expected: PASS —— 全部绿。

- [ ] **Step 5: `billing.module.ts` 注册并导出**

在 `api/src/modules/billing/billing.module.ts` 里：

① import 段加：

```ts
import { PayoutEncryptionSelfCheck } from './payout-encryption-self-check.service';
```

② `providers` 数组里，在 `PayoutExecutionService,` 之后加：

```ts
    // 账目加密自检（阶段 5k）
    PayoutEncryptionSelfCheck,
```

③ `exports` 数组里加：

```ts
    // ⚠️ **导出 `PayoutEncryptionSelfCheck`** —— `main.ts` 要用
    //    `app.get()` 拿到它，在 `app.listen()` 之前跑自检。
    PayoutEncryptionSelfCheck,
```

- [ ] **Step 6: `main.ts` 加调用**

在 `api/src/main.ts` 里：

① import 段加：

```ts
import { PayoutEncryptionSelfCheck } from './modules/billing/payout-encryption-self-check.service';
```

② 把：

```ts
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
```

改成：

```ts
  const port = Number(process.env.PORT ?? 3000);

  // ⚠️ **账目密钥自检必须在监听端口之前**：
  //    带着解不开的密文启动，运营看到的全是失败的出款单，
  //    没人知道根因是密钥配错了。
  await app.get(PayoutEncryptionSelfCheck).check();

  await app.listen(port);
```

- [ ] **Step 7: 编译并跑全量单测**

Run: `cd api && npm run build && npm test`

Expected: 编译通过、单测全绿。

⚠️ **e2e 不会触发这个自检** —— e2e 用 `Test.createTestingModule` + `app.init()`，**不走 `main.ts` 的 `bootstrap`**。自检的 e2e 在 Task 6 里直接调 `check()`。

---

### Task 5: 商家端的收款账户可见性 + 失败模板措辞

**要解决的问题：** 商家看不到「钱打给谁」（5j 遗留第 1 条）；商家端的失败提示「请联系平台确认是否已到账」对「确定没打钱」的失败不成立。

**Files:**
- Modify: `merchant-admin/src/lib/payout.ts`
- Modify: `merchant-admin/src/app/(dashboard)/settlements/[id]/page.tsx`
- Modify: `merchant-admin/src/app/(dashboard)/settlements/apply/page.tsx`
- Modify: `api/src/modules/billing/payout.service.ts:235`（指引措辞）

⚠️ **后端零改动** —— `PayoutView` 早就带这三个字段，商家端与平台端共用 `toView`。前端只是没在类型里声明、也没渲染。

- [ ] **Step 1: `merchant-admin/src/lib/payout.ts` —— `PayoutItem` 加三个字段**

在 `PayoutItem` 接口里，`failedAt: string | null;` 之后加：

```ts
  /**
   * 收款账户快照（户名）。null = 老数据没有快照
   *
   * ⚠️ **账号本身是密文，界面只给掩码**（见 `maskedSnapshotAccountNo`）。
   */
  snapshotAccountName: string | null;
  /** 收款账户快照（开户行）。null = 老数据没有快照 */
  snapshotBankName: string | null;
  /**
   * 收款账户快照（**账号脱敏**）。null = 老数据没有快照
   *
   * ⚠️ **库里存的是密文，响应里只给预存的掩码串** ——
   *    即便解开也绝不能原样进响应（护栏 X14）。
   *    掩码串是商家核对「钱打给谁」的**唯一**依据。
   */
  maskedSnapshotAccountNo: string | null;
```

- [ ] **Step 2: `merchant-admin/src/lib/payout.ts` —— 拷贝一份 `describePayoutAccount`**

在文件末尾（`AvailablePeriod` 接口之后）加：

```ts
/**
 * 收款账户的展示串：`开户行 掩码账号（户名）`。
 *
 * ⚠️ **账号是密文，界面只给掩码**（阶段 5j）：库里存的是密文，
 *    响应里只有预存的掩码串（`maskedSnapshotAccountNo`）——
 *    **完整账号绝不在响应里，前端也不去解密**。
 *
 * ⚠️ **三个字段都可能为 null**（老数据没有快照）：这时返回 `null`，
 *    让调用方**整行不显示** —— 不能渲染出字面量 "null"，
 *    也不该用「—」占位（那一行本来就没有信息）。
 *
 * ⚠️ **只拼已有的部分**：户名可能缺、可能只有掩码串。
 *    用「—」占位缺失的部分会让商家以为「开户行不知道」，
 *    而实际情况是「这张单没有快照」。
 *
 * ⚠️ **与 `platform-admin/src/lib/payout.ts` 的同名函数内容必须一致** ——
 *    两份 `lib/payout.ts` 是各自分离的文件（不同 Next.js 应用，不共享代码），
 *    只能拷贝，不能 import。
 */
export function describePayoutAccount(payout: {
  snapshotBankName?: string | null;
  maskedSnapshotAccountNo?: string | null;
  snapshotAccountName?: string | null;
}): string | null {
  const parts: string[] = [];

  if (payout.snapshotBankName) parts.push(payout.snapshotBankName);
  if (payout.maskedSnapshotAccountNo) {
    parts.push(payout.maskedSnapshotAccountNo);
  }
  if (payout.snapshotAccountName) {
    parts.push(`（${payout.snapshotAccountName}）`);
  }

  // ⚠️ **三个字段全空 → 返回 null**（这张单没有收款账户快照）。
  return parts.length === 0 ? null : parts.join(' ');
}
```

- [ ] **Step 3: 商家端详情页 —— 加「收款账户（申请时）」那一行**

在 `merchant-admin/src/app/(dashboard)/settlements/[id]/page.tsx` 里：

① import 段把：

```tsx
import {
  describePayoutEntryType,
  describePayoutStatus,
  describePayoutTimeline,
  formatCents,
} from '@/lib/payout';
```

改成：

```tsx
import {
  describePayoutAccount,
  describePayoutEntryType,
  describePayoutStatus,
  describePayoutTimeline,
  formatCents,
} from '@/lib/payout';
```

② 在 `if (!payout) { return null; }` 之后加：

```tsx
  // ⚠️ **先算一次再渲染**：条件与内容用同一个值，
  //    免得两处各调一次函数（万一将来它不是纯函数就会不一致）。
  const accountText = describePayoutAccount(payout);
```

③ 在「申请时预估」那一段的**后面**加：

```tsx
        {/* ⚠️ **收款账户（申请时）要显示**：商家必须能看出「钱打给谁」。
            阶段 5j 之后库里只有密文，**掩码串是唯一能核对的东西** ——
            界面上不显示它，商家就只能打电话问。

            ⚠️ **显示的是申请那一刻的快照**，不是当前账户 ——
            商家申请后改过账户的话两者会不同，而**钱打给的是快照那份**。
            所以文案要写明「申请时」。

            ⚠️ **只显示掩码串，绝不显示完整账号** —— 完整账号压根不在响应里，
            前端也不去解密。 */}
        {accountText && (
          <p className="text-sm">
            收款账户（申请时）：{accountText}
          </p>
        )}
```

- [ ] **Step 4: 商家端详情页 —— 失败模板改措辞**

在同一个文件里，把：

```tsx
        {/* ⚠️ **失败的单可能真的已经打出去了**（渠道超时 / 网络中断）——
            必须让商家自己去核对是否已到账，否则商家会直接再申请一笔。 */}
        {payout.status === 'FAILED' && (
          <p className="text-sm text-destructive">
            出款失败：{payout.failureReason ?? '未知原因'}。请联系平台确认是否已到账。
          </p>
        )}
```

改成：

```tsx
        {/* ⚠️ **失败有两种，商家都需要联系平台**：
            ① 渠道试满 3 次 —— 钱**可能已经打出去**（渠道超时 / 网络中断）
            ② 账户不可用（解密失败 / 快照缺失）—— **确定没打**
            一句「请联系平台确认出款情况」对两类都成立，
            且不引入条件判断（前端不该按失败原因文案分支 ——
            后续改措辞就失效，「哪些文案表明没打钱」的知识也会散落到前端）。 */}
        {payout.status === 'FAILED' && (
          <p className="text-sm text-destructive">
            出款失败：{payout.failureReason ?? '未知原因'}。请联系平台确认出款情况。
          </p>
        )}
```

- [ ] **Step 5: 申请页 —— 显示「本次出款将打到…」**

把 `merchant-admin/src/app/(dashboard)/settlements/apply/page.tsx` 整个文件替换成：

```tsx
import Link from 'next/link';
import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import type { AvailablePeriod, PayoutAccount } from '@/lib/payout';
import { PayoutApplyForm } from './apply-form';

/**
 * 商家侧的「申请出款」页（Server Component）。
 *
 * ⚠️ **金额全部由后端算**：这里只把后端给的「可申请周期 + 应结金额」
 *    传给表单，商家选周期 → 提交。商家**不能**自己填金额。
 *
 * ⚠️ **收款账户要显示出来**：商家提交之前必须能看出「钱会打到哪」。
 *    阶段 5j 之后库里只有密文，**掩码串是唯一能核对的东西**。
 */
export default async function PayoutApplyPage() {
  let periods: AvailablePeriod[] = [];
  let error: string | null = null;
  let account: PayoutAccount | null = null;
  let accountError: string | null = null;

  try {
    periods = await apiFetchAuthed<AvailablePeriod[]>(
      '/merchant/payouts/available-periods',
    );
  } catch (cause) {
    error =
      cause instanceof ApiError
        ? `加载可申请周期失败：${cause.message}`
        : cause instanceof Error
          ? cause.message
          : '可申请周期加载失败';
  }

  // ⚠️ **账户加载失败不阻断申请** —— 它只是展示信息，
  //    申请接口有服务端校验（没有账户会被拒）。
  try {
    account = await apiFetchAuthed<PayoutAccount | null>(
      '/merchant/payout-account',
    );
  } catch (cause) {
    accountError =
      cause instanceof ApiError
        ? `加载收款账户失败：${cause.message}`
        : cause instanceof Error
          ? cause.message
          : '收款账户加载失败';
  }

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-bold">申请出款</h2>
      <p className="text-sm text-muted-foreground">
        选一个自然月提交申请。金额由平台按「货款 − 平台佣金」算好，
        审批时还会再算一次并锁定。
      </p>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {/* ⚠️ **收款账户要显示**：商家提交之前必须能看出「钱会打到哪」。
          ⚠️ **没账户时要给入口** —— 光说「尚未设置」商家不知道去哪设。
          ⚠️ **显示的是「当前账户」**，与详情页的「申请时快照」不是同一份
          （商家改过账户就会不同）—— 这是对的：申请页讲的是「这次会打给谁」。 */}
      <div className="rounded-md border p-3 text-sm">
        {account ? (
          <p>
            本次出款将打到：{account.bankName} {account.maskedAccountNo}
            （{account.accountName}）
          </p>
        ) : accountError ? (
          <p className="text-muted-foreground">
            收款账户加载失败：{accountError}
          </p>
        ) : (
          <p>
            尚未设置收款账户，
            <Link
              href="/settlements/account"
              className="underline underline-offset-4"
            >
              去设置收款账户
            </Link>
          </p>
        )}
      </div>

      <PayoutApplyForm periods={periods} />
    </div>
  );
}
```

- [ ] **Step 6: 修正后端的指引措辞**

`api/src/modules/billing/payout.service.ts:235` 现在写的是：

```ts
      throw new BadRequestException('请先在「出款」页设置收款账户');
```

改成：

```ts
      // ⚠️ **指引要指向准确的位置** —— 账户设置页在 `/settlements/account`，
      //    「出款」页是申请出款的地方，商家在出款列表页找不到入口。
      throw new BadRequestException('请先在「收款账户」页设置收款账户');
```

✅ **已核实**：全仓（`api/src` 与 `api/test`）**没有任何用例断言这句旧文案** —— 只有 `payout.service.ts:235` 这一处。改它不会挂任何测试。

- [ ] **Step 7: 编译商家端**

Run: `cd merchant-admin && npx tsc --noEmit && npm run build`

Expected: 编译通过。

⚠️ **`PayoutItem` 加字段后 TypeScript 立刻开始校验** —— `apiFetchAuthed<PayoutDetail>` 的泛型变了，少一个字段就编译报错。这是好事（编译期兜底）。

- [ ] **Step 8: 跑全量单测**

Run: `cd api && npm test`

Expected: PASS。

---

### Task 6: e2e

**Files:**
- Modify: `api/test/payout-encryption.e2e-spec.ts`
- Create: `api/test/payout-encryption-self-check.e2e-spec.ts`

- [ ] **Step 1: 改写 e2e 用例 6 —— 「未迁移的行」不再抛错**

在 `api/test/payout-encryption.e2e-spec.ts` 里，把用例 6（`:606` 起，标题是 `未迁移的行（版本号 0）→ 打款路径抛错，不按明文兜底`）的**标题与核心断言**改成：

```ts
  it('未迁移的行（版本号 0）→ 抢单不抛错，accountError 带着根因，不按明文兜底', async () => {
```

并把从 `// ---- 直接调抢单这一步 ----` 到 `expect(fake.receivedRequest(applied.id)).toBeUndefined();` 这一段替换成：

```ts
      // ---- 直接调抢单这一步 —— 它就是解密发生的地方 ----
      //
      // ⚠️ **为什么不走队列**：改写前这里期望「抛错」，抛错会让 job 变成
      //    BullMQ 的 failed job。这条用例要守的是
      //    「**解密失败绝不按明文兜底**」—— 直接调这一步最直白。
      const execution = app.get(PayoutExecutionService);
      const claim = await execution.claimForExecution(
        applied.id,
        new Date(),
      );

      // ⚠️⚠️ **根因必须指向「没加密」** ——
      //    实现若按明文兜底（拿明文当密文去解），
      //    这里会是「密文解密失败（密钥不匹配，或密文已被篡改）」——
      //    消息长得像，但根因不同：按明文兜底等于把加密悄悄关掉，
      //    迁移脚本也永远不会提醒运维去补迁移。
      //    → 所以除了「尚未加密」，还要看到「迁移」这两个字。
      expect(claim).not.toBeNull();
      expect(claim!.accountError).toContain('尚未加密');
      // ⚠️ **必须点名迁移命令** —— 运维看到「尚未加密」还不够，
      //    他得知道**敲哪条命令**才能修好。
      expect(claim!.accountError).toContain('migrate:payout-encryption');
      expect(claim!.accountError).not.toContain('密钥不匹配');
      // ⚠️ **绝不按明文兜底**
      expect(claim!.account).toBeNull();

      // ⚠️ **钱绝不能打出去** —— 解密失败就不能调渠道。
      //    这里直接调的是抢单这一步，压根没走到渠道，
      //    但把「渠道没收到过请求」钉死更保险。
      const fake = app.get(FakePayoutProvider);
      expect(fake.receivedRequest(applied.id)).toBeUndefined();
```

⚠️ **原来那段 catch 块（`:677-687`）的断言要一起改** —— 它读的是抛出的异常消息，现在没有异常了。上面的替换已经把整段（含 catch 块）覆盖掉。

⚠️ **只有一次 `claimForExecution` 调用** —— 原来调了两次（一次 `rejects.toThrow`、一次 try/catch 读消息），那是**靠抛错回滚**才让两次都进得去。改写后第一次调用就把单抢成了 `PROCESSING`（事务提交了），第二次调用的条件更新影响 0 行 → 返回 `null`。**必须只调一次。**

⚠️ **用例 6 结尾那段（`:715-743`「还原后这张单能正常打款」）也要改两处**：

① 注释从：

```ts
    // ---- 还原后这张单能正常打款（证明抛错确实是版本号触发的）----
    //
    // ⚠️ **刚才的 `claimForExecution` 抛错前已经把单改成 `PROCESSING` 了**
    //    （抢单是事务里的第一步更新），所以这里要先把它拨回 `APPROVED`，
    //    否则 worker 抢不到单（护栏 X1 的条件更新）。
```

改成：

```ts
    // ---- 还原后这张单能正常打款（证明失败确实是版本号触发的）----
    //
    // ⚠️ **刚才的 `claimForExecution` 已经把单抢成 `PROCESSING` 了**
    //    （抢单是事务里的第一步更新，且这次事务**提交了**），所以这里要
    //    先把它拨回 `APPROVED`，否则 worker 抢不到单（护栏 X1 的条件更新）。
```

② 拨回 `APPROVED` 的那行**要把 `attemptCount` 一起拨回 0**（改写后它被加过 1 了）：

```ts
    await asPlatform(() =>
      prisma.payout.updateMany({
        where: { id: applied.id },
        data: {
          status: PayoutStatus.APPROVED,
          processingAt: null,
          // ⚠️ **attemptCount 一起拨回 0** —— 改写后抢单成功过一次
          //    （attemptCount = 1），这次打款应当是一次全新的执行
          attemptCount: 0,
        },
      }),
    );
```

⚠️ **用例编号别撞** —— 本文件**已经有「用例 7：写路径闸」**（`:750`）。新增的用例编号要用 **用例 8**。

- [ ] **Step 2: 新增 e2e 用例 —— 解密失败 → 落 FAILED + 明细释放 + 兜底扫描捞不到**

⚠️ **放在文件末尾**（既有的「用例 7：写路径闸」在 `:750`，新用例编号用 **用例 8**，月份用 **`2026-04`**（本文件还没用过这个月））。

在 `api/test/payout-encryption.e2e-spec.ts` 的**最后一个 `it` 之后**、文件的 `});` 之前加：

```ts
  // ============================================================
  // 用例 8：解密失败 → 落 FAILED（确定没打钱）+ 明细释放 + 无限循环断了
  // ============================================================

  it('解密失败 → 出款单落 FAILED，明细占用被释放，兜底扫描再也捞不到它', async () => {
    const adminToken = await loginPlatformAdmin();
    const period = month('2026-04');
    const { merchant } = await setupMerchantWithPeriod(adminToken, period, {
      receiptAmount: 10000,
      commissionAmount: 1000,
    });

    const applied = await apply(merchant.token, period.label);

    // ---- 手工把它拨成 APPROVED —— 绕过 approve 的入队路径 ----
    //
    // ⚠️ **为什么不用 `approve`**：审批会**重新抄一份账户行里的密文**
    //    （覆盖快照），改在审批前的快照会被覆盖掉；改在审批后的话，
    //    worker 可能已经抢到单打完了。手工置 `APPROVED` 既不覆盖快照，
    //    也**不入队** → 没有竞态。
    await asPlatform(() =>
      prisma.payout.updateMany({
        where: { id: applied.id },
        data: {
          status: PayoutStatus.APPROVED,
          approvedAt: new Date(),
          approvedBy: 'test-admin',
        },
      }),
    );

    // ---- 把快照的版本号改回 0 —— 模拟「这张单是在迁移前出的」 ----
    const originalVersion = (await asPlatform(() =>
      prisma.payout.findFirst({
        where: { id: applied.id },
        select: { snapshotEncryptionVersion: true },
      }),
    ))!.snapshotEncryptionVersion;

    try {
      await asPlatform(() =>
        prisma.payout.updateMany({
          where: { id: applied.id },
          data: { snapshotEncryptionVersion: 0 },
        }),
      );

      // ---- 直接调 worker 的 execute —— 走完整的「抢单 → 判闸 → 落终态」 ----
      //
      // ⚠️ **不靠队列**：BullMQ 的消费有延迟与竞态，直接调 `process()`
      //    才是确定性的（这一步验的是 worker 的**逻辑**）。
      const worker = app.get(PayoutWorker);
      await worker.process({
        name: 'execute',
        data: { payoutId: applied.id },
      } as never);

      // ---- 断言 ①：单子落 FAILED，理由是业务口径 ----
      const after = (await asPlatform(() =>
        prisma.payout.findFirst({
          where: { id: applied.id },
          select: { status: true, failureReason: true },
        }),
      ))!;
      expect(after.status).toBe(PayoutStatus.FAILED);
      expect(after.failureReason).toContain('本次未打款');
      // ⚠️ **界面文案不能带内部术语**
      expect(after.failureReason).not.toContain('尚未加密');
      expect(after.failureReason).not.toContain('密钥不匹配');

      // ---- 断言 ②：渠道从未被调用（确定没打钱） ----
      const fake = app.get(FakePayoutProvider);
      expect(fake.receivedRequest(applied.id)).toBeUndefined();

      // ---- 断言 ③：明细占用被释放（商家对同期重新申请不撞唯一索引） ----
      const entries = await asPlatform(() =>
        prisma.payoutEntry.count({ where: { payoutId: applied.id } }),
      );
      expect(entries).toBe(0);

      // ---- 断言 ④：兜底扫描再也捞不到它（无限循环断了） ----
      //
      // ⚠️ **这是整条用例的关键断言** —— 改写前单子停在 `APPROVED`
      //    且 `attemptCount = 0` → `scanStuck` 的分支 ② 全中 → 每 5 分钟
      //    重新入队一次 → **无限循环**（设计 §二·2.1）。
      //
      // ⚠️ **时间要往后推一小时** —— 否则 `approvedAt` 刚设成 `now`，
      //    还没到「卡住 10 分钟」的阈值，分支 ② 压根不会查它 →
      //    断言恒真（没有牙齿）。
      const execution = app.get(PayoutExecutionService);
      const rescues = await execution.scanStuck(
        new Date(Date.now() + 3600_000),
      );
      expect(rescues.find((r) => r.id === applied.id)).toBeUndefined();
    } finally {
      await asPlatform(() =>
        prisma.payout.updateMany({
          where: { id: applied.id },
          data: { snapshotEncryptionVersion: originalVersion },
        }),
      );
    }
  });
```

⚠️ **这个文件需要在顶部加一个 import**：

```ts
import { PayoutWorker } from '../src/modules/payment/payout.worker';
```

（`PayoutExecutionService` 已经 import 了。）

- [ ] **Step 3: 补一条 e2e 断言 —— 商家端拿得到三个快照字段**

⚠️ **先补类型、再补断言** —— `PayoutBody` 接口里没有这两个字段时，断言会编译不过。

① 在 `api/test/payout-encryption.e2e-spec.ts` 顶部的 `PayoutBody` 接口里，把：

```ts
  maskedSnapshotAccountNo: string | null;
```

改成：

```ts
  maskedSnapshotAccountNo: string | null;
  snapshotAccountName: string | null;
  snapshotBankName: string | null;
```

② 在同文件的用例 4 里，把：

```ts
    const merchantDetail = await fetchMerchantDetail(
      merchant.token,
      applied.id,
    );
    expect(merchantDetail.maskedSnapshotAccountNo).toBe('************0000');
    expect(JSON.stringify(merchantDetail)).not.toContain(PLAIN_ACCOUNT_NO);
```

改成：

```ts
    const merchantDetail = await fetchMerchantDetail(
      merchant.token,
      applied.id,
    );
    expect(merchantDetail.maskedSnapshotAccountNo).toBe('************0000');
    expect(JSON.stringify(merchantDetail)).not.toContain(PLAIN_ACCOUNT_NO);
    // ⚠️ **户名与开户行也要给商家** —— 阶段 5k 之前商家端压根看不到
    //    「钱打给谁」，掩码串是唯一的核对线索（设计 §三·3.1）。
    //    这条断言钉住「后端早就发了，别改回去」。
    expect(merchantDetail.snapshotAccountName).toBe('张三');
    expect(merchantDetail.snapshotBankName).toBe('招商银行');
```

同时在文件顶部的 `PayoutBody` 接口里补两个字段：

```ts
  maskedSnapshotAccountNo: string | null;
  snapshotAccountName: string | null;
  snapshotBankName: string | null;
```

- [ ] **Step 4: 新建自检的 e2e 文件**

创建 `api/test/payout-encryption-self-check.e2e-spec.ts`：

```ts
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
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
    const selfCheck = app.get(PayoutEncryptionSelfCheck);

    await expect(selfCheck.check()).resolves.toBeUndefined();
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

    try {
      // ---- 把密文改成乱码 ----
      await asPlatform(() =>
        prisma.merchantPayoutAccount.updateMany({
          where: { id: row.id },
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
      await asPlatform(() =>
        prisma.merchantPayoutAccount.updateMany({
          where: { id: row.id },
          data: { accountNoCipher: row.accountNoCipher },
        }),
      );
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

    try {
      await asPlatform(() =>
        prisma.merchantPayoutAccount.updateMany({
          where: { id: row.id },
          data: { accountNoCipher: '' },
        }),
      );

      const selfCheck = app.get(PayoutEncryptionSelfCheck);
      await expect(selfCheck.check()).rejects.toThrow(/空串/);
    } finally {
      await asPlatform(() =>
        prisma.merchantPayoutAccount.updateMany({
          where: { id: row.id },
          data: { accountNoCipher: row.accountNoCipher },
        }),
      );
    }
  });
});
```

- [ ] **Step 5: 跑 e2e**

Run: `cd api && npm run test:e2e -- payout-encryption`

Expected: PASS —— 7 个用例全绿（含新增的用例 7）。

- [ ] **Step 6: 独占跑自检的 e2e**

Run: `cd api && npm run test:e2e -- payout-encryption-self-check`

Expected: PASS —— 3 个用例全绿。

⚠️ **这条必须独占跑** —— 它改库里的密文，与别的 e2e 并发会互相干扰。

- [ ] **Step 7: 跑全量 e2e**

Run: `cd api && npm run test:e2e`

Expected: PASS —— 没有回归。

---

### Task 7: 失败注入 + 手测 + 验收记录

**Files:**
- Create: `docs/superpowers/plans/2026-10-30-plan-05k-fund-closure-acceptance.md`
- Modify: `docs/superpowers/plans/2026-10-30-plan-05j-fund-security-ledger-closure-acceptance.md:258`（更正 §五 第 10 条）

⚠️ **失败注入必须独占跑**（不与全量测试并发）—— 注入期间源码是坏的。

- [ ] **Step 1: G1 —— 去掉 `claimForExecution` 的 catch**

把 `api/src/modules/billing/payout-execution.service.ts` 里 `claimForExecution` 的 `catch` 块临时改成重新抛出：

```ts
          } catch (error) {
            accountError =
              error instanceof Error ? error.message : String(error);
            throw error; // ⚠️ 失败注入 G1：临时恢复成抛错
          }
```

Run: `cd api && npx jest src/modules/billing/payout-execution.service.spec.ts`

Expected: FAIL —— 「版本 0 → 不抛错，accountError 带着根因」这条挂（抛错而不是返回 claim）。

还原：把 `throw error;` 那行删掉。

- [ ] **Step 2: G2 —— 去掉 worker 的 `accountError` 分支**

把 `api/src/modules/payment/payout.worker.ts` 里 `if (claim.accountError) { ... }` 整块临时删掉。

Run: `cd api && npx jest src/modules/payment/payout-worker.spec.ts`

Expected: FAIL —— 「解密失败 → 落 FAILED，理由是业务口径」这条挂（`failureReason` 变成「收款账号信息异常…」之外的东西，或根本没落 FAILED）。

还原：把整块加回去。

- [ ] **Step 3: G3 —— 去掉 `markFailed` 的明细释放**

把 `api/src/modules/billing/payout-execution.service.ts` 的 `markFailed` 里那行临时注释掉：

```ts
        // await tx.payoutEntry.deleteMany({ where: { payoutId } });
```

Run: `cd api && npx jest src/modules/billing/payout-execution.service.spec.ts`

Expected: FAIL —— 「⚠️ 释放明细占用」那条挂。

还原：把注释去掉。

- [ ] **Step 4: G4 —— 自检去掉平台作用域**

把 `api/src/modules/billing/payout-encryption-self-check.service.ts` 里的：

```ts
    await tenantContext.run(platformScope(), async () => {
```

临时改成：

```ts
    await (async () => {
```

（并把结尾的 `});` 改成 `})();`）

Run: `cd api && npx jest src/modules/billing/payout-encryption-self-check.service.spec.ts`

Expected: **FAIL** —— 而且**失败信息必须不是自检自己的错**。

⚠️ **断言要区分错误类型**：没有租户上下文时 `resolveScope`（`api/src/common/tenant/tenant-prisma.service.ts:96-100`）**抛 `TenantScopeError`**，不是「查不到行」。只断言「抛错」没有牙齿 —— 实施者若为了「让容器能起来」把作用域错误吞掉，自检就彻底失效了。

所以这个注入的**预期是**：报错信息是 `TenantScopeError`（「模型 MerchantPayoutAccount 是租户作用域的，但当前请求没有租户上下文，拒绝访问」），而**不是**「账目加密自检失败」。恢复平台作用域后，错误才变成自检自己的错。

还原：把作用域改回去。

- [ ] **Step 5: G5 —— 自检无可校验行时也报错**

把 `api/src/modules/billing/payout-encryption-self-check.service.ts` 里「两处都没有可校验的行 → 静默通过」那段临时改成抛错：

```ts
      if (!payout) {
        throw new Error('账目加密自检失败：库里没有任何可校验的行（失败注入 G5）');
      }
```

Run: `cd api && npx jest src/modules/billing/payout-encryption-self-check.service.spec.ts`

Expected: FAIL —— 「库里没有可校验的行 → 不抛错」这条挂。

还原：把 throw 删掉。

- [ ] **Step 6: 注入全部还原后，跑全量单测 + e2e**

Run: `cd api && npm test && npm run test:e2e`

Expected: 全绿。

⚠️ **跑之前用 `git diff` 确认源码没有残留的注入痕迹**：

Run: `cd api && git diff --stat src/`

Expected: 只剩 Task 1~5 的正常改动，**没有** `失败注入`、`G1`~`G5` 之类的字样。

- [ ] **Step 7: 浏览器手测（5 步）**

⚠️ **需要先起服务**：API（3000）、merchant-admin（3002）、platform-admin（3003）。测试库与开发库要一致（`PAYOUT_ACCOUNT_ENCRYPTION_KEY` 必须与加密时用的密钥一致，否则所有出款单会 FAILED）。

| 步 | 操作 | 期望 |
|----|------|------|
| 1 | 商家端 →「申请出款」页 | 能看到「本次出款将打到：招商银行 \*\*\*\*\*\*\*\*0000（张三）」 |
| 2 | 商家端 → 出款单详情页 | 能看到「收款账户（申请时）：…」那一行 |
| 3 | 平台端 → 出款单详情页 | 收款账户行**仍在**（回归） |
| 4 | 商家端 → 状态为 `FAILED` 的出款单详情页 | 失败原因是业务口径（不含「密钥不匹配」），**含**「本次未打款」；那句提示是「请联系平台确认**出款情况**」（不是「是否已到账」） |
| 5 | 平台端 → 停在 `APPROVED` 且有 `failureReason` 的出款单详情页 | 能看到「备注」那一行 |

⚠️ **手测时不能抢前台** —— 用 `ego lite`，先 `pgrep -f "ego lite"` 复用已开的实例。

- [ ] **Step 8: 写验收记录**

新建 `docs/superpowers/plans/2026-10-30-plan-05k-fund-closure-acceptance.md`（⚠️ **验收记录与实施计划同在 `docs/superpowers/plans/` 下** —— 与 5g / 5h-2 / 5i / 5j 的既有约定一致）。

内容至少包含：

- 交付范围（对应设计 §八 的 6 件事）
- 单测 / e2e 的实际结果（贴命令与结论）
- 失败注入 G1~G5 的实际结果（每条：注入什么 → 哪条用例挂 → 还原）
- 手测 5 步的实际结果
- 遗留与风险（照抄设计 §七·7.1 的 5 条 + 5j 的 4 条未处理）

- [ ] **Step 9: 更正 5j 验收记录的那一行**

⚠️ **5j 验收记录 §五 第 10 条**（文件 `docs/superpowers/plans/2026-10-30-plan-05j-fund-security-ledger-closure-acceptance.md` 的 **第 258 行**）写的是：

```
| 10 | **e2e 的读路径抛错会让出款单停在 `PROCESSING`** | 解密在 worker 的 try/catch **之外** → 抛错后单子既不 `PAID` 也不 `FAILED`。写路径闸已堵住「明文快照落库」这个触发源，但「版本不认识」等其它异常仍会卡住。属于卡死告警兜底的话题，不在本阶段范围。 |
```

—— **不准确**。实测是停在 **`APPROVED`**（设计 §二·2.1，有实测数据：`status= APPROVED  attemptCount= 0  processingAt= null`）。

把这一行改成：

```
| 10 | **e2e 的读路径抛错会让出款单停在 `APPROVED`** | 解密在 `claimForExecution` 的事务内 → 抛错后**整个事务回滚**（抢单的状态变更与 `attemptCount` 的自增一起被撤销）→ 单子既不 `PAID` 也不 `FAILED`，而是回到 `APPROVED` 且 `attemptCount = 0`。⚠️ **5k 实施期实测更正**：5j 当时写的是「停在 `PROCESSING`」，那是错的。写路径闸已堵住「明文快照落库」这个触发源；5k 已把读路径的解密失败处置为落 `FAILED`（确定没打钱）。 |
```

⚠️ 同一文件 **第 93 行** 也有一次「出款单卡在 `PROCESSING` 反复重试」的表述 —— 那是**设计论证**的一部分（论证「读路径漏闸会造出明文快照」），不是对实测现象的描述，**可以保留**；但如果想彻底一致，可改成「出款单打不出钱」。

- [ ] **Step 10: 提交（由协调者执行）**

```bash
git add -A
git commit -m "feat(billing): 阶段 5k——资金链路收尾（解密失败兜底 + 商家端账户可见性）"
```

---

## 附录 A：文件清单速查

| 文件 | 动作 | Task |
|------|------|------|
| `api/src/modules/billing/payout-execution.service.ts` | 改 | 1 |
| `api/src/modules/billing/payout-execution.service.spec.ts` | 改 | 1、7(G3) |
| `api/src/modules/payment/payout.worker.ts` | 改 | 2 |
| `api/src/modules/payment/payout-worker.spec.ts` | 改 | 2 |
| `api/src/modules/billing/payout.service.ts` | 改 | 3、5 |
| `api/src/modules/billing/payout.service.spec.ts` | 改 | 3 |
| `api/src/modules/billing/payout-encryption-self-check.service.ts` | **新建** | 4 |
| `api/src/modules/billing/payout-encryption-self-check.service.spec.ts` | **新建** | 4 |
| `api/src/modules/billing/billing.module.ts` | 改 | 4 |
| `api/src/main.ts` | 改 | 4 |
| `merchant-admin/src/lib/payout.ts` | 改 | 5 |
| `merchant-admin/src/app/(dashboard)/settlements/[id]/page.tsx` | 改 | 5 |
| `merchant-admin/src/app/(dashboard)/settlements/apply/page.tsx` | 改 | 5 |
| `platform-admin/src/app/(dashboard)/payouts/[id]/page.tsx` | 改 | 3 |
| `api/test/payout-encryption.e2e-spec.ts` | 改 | 6 |
| `api/test/payout-encryption-self-check.e2e-spec.ts` | **新建** | 6 |
| `docs/superpowers/plans/2026-10-30-plan-05k-fund-closure-acceptance.md` | **新建** | 7 |
| `docs/superpowers/plans/2026-10-30-plan-05j-fund-security-ledger-closure-acceptance.md` | 改 | 7 |

## 附录 B：本阶段**不做**的事（照抄设计 §一·1.3）

| 不做 | 理由 |
|------|------|
| 跨期调账机制（R7） | 5j 已明确排除 |
| L54 逐笔结佣 | 依赖跨期调账先落地 |
| 批量恢复已 `FAILED` 的出款单 | 需要新增状态转换，且「批量」本身是新功能 |
| 外部告警通道（Prometheus / Sentry） | 本仓没有监控基础设施接入点 |
| 两端出款列表页显示账户 | 一商家一账户，重复是冗余 |
| **新的出款单状态** | 解密失败可以安全地复用已有的 `FAILED` |
