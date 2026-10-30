# 阶段 5k「资金链路收尾」设计

> **前置**：阶段 5j（资金安全与账务闭环）已完成并合并（PR #19）。
> 本阶段只做**收尾**，不引入新的业务概念。

---

## 一、背景与目标

### 1.1 这一阶段要解决什么

阶段 5j 把收款账户改成了密文存储。密文引入了明文路径从来不需要处理的一类问题：
**「读不出来」**。5j 把这类失败处理成了「抛错」——响亮、明确，但**没有出口**。

结果是 5j 自己引入了一条新的失效链（本文档 §二 有实测数据）：

> 解密失败 → 事务回滚 → 出款单停在 `APPROVED` → 兜底扫描把它当成
> 「审批后入队失败」重新入队 → 再解密失败 → **每 5 分钟无限循环**。

商家侧的观感是：出款单永远停在「已审批」，钱永远不到账，界面��任何失败原因。

本阶段做四件事：

| # | 事项 | 层 | 动机 |
|---|------|-----|------|
| A | 解密失败 → 出款单落 `FAILED` | 后端 | 堵住 5j 引入的无限重试 |
| B | 商家端显示收款账户（申请页 + 详情页） | 前端 | 商家能看见「钱打给谁」 |
| C | 失败原因的口径统一（内部原文只进日志）+ 平台端显示「备注」 | 后端 + 平台端 | 同一个字段不该有两套标准 |
| D | 启动时的账目密钥自检 | 后端 | 密钥配错在启动时暴露，而不是第一张单失败时 |

### 1.2 为什么现在做

5j 的验收记录留了 12 条遗留，第 1 条是「商家端看不到收款账户」。本阶段把它和
「解密失败的处置」放在一起，是因为两者**共用同一条数据**（出款单快照里的收款账户），
且 5j 已经把「掩码串」建成了唯一的核对线索——但只在一端露出来了。

### 1.3 明确不做的

| 不做 | 理由 |
|------|------|
| **跨期调账机制**（R7） | 5j 已明确排除；前提是「跨期退款在账上归属哪一期」这个产品决策 |
| **L54 逐笔结佣** | 依赖跨期调账先落地 |
| **批量恢复已 `FAILED` 的出款单** | 需要新增状态转换（`FAILED → APPROVED`），且「批量」本身是新功能。本阶段只记录后果（§七） |
| **外部告警通道**（接 Prometheus / Sentry 等） | 本仓没有监控基础设施接入点，YAGNI |
| **两端出款列表页显示账户** | 一商家一账户，每行重复同一串掩码是纯冗余（§三·3.4） |
| **新的出款单状态** | 解密失败可以安全地复用已有的 `FAILED`（§二·2.2） |

---

## 二、解密失败的处置

### 2.1 失效链（实测数据）

`claimForExecution`（`api/src/modules/billing/payout-execution.service.ts:86-143`）
把「抢单」和「读回快照」放在同一个事务里，**解密也在这个事务内**：

```
tx.payout.updateMany({ where: { id, status: APPROVED },
                        data: { status: PROCESSING, attemptCount: +1 } })
tx.payout.findFirst({ ... snapshotAccountNoCipher, snapshotEncryptionVersion ... })
this.cipher.decryptVersioned(...)      ← 在事务回调内
```

解密抛错 → 事务回滚 → **单子根本没进 `PROCESSING`**。

⚠️ **实测数据**（5k 实施期在 `api/test/payout-encryption.e2e-spec.ts` 的
「未迁移的行」用例上加临时探针实测）：

```
解密抛错后 → status= APPROVED  attemptCount= 0  processingAt= null
```

> ⚠️ **这推翻了 5j 验收记录遗留第 10 条的描述**。那条写的是
> 「出款单停在 `PROCESSING`（既没 PAID 也没 FAILED）」——**不准确**。
> 实际停在 `APPROVED`。5k 的验收记录要更正它。

于是接上了兜底扫描（`scanStuck`，同文件 `:335-401`）：

| scanStuck 的两个分支 | 条件 | 解密失败的单是否命中 |
|---|---|---|
| ① `PROCESSING` 卡死 | `status=PROCESSING` + `processingAt` 超时 + `stuckLoggedAt` 为空 | ❌ 不命中（压根没进 PROCESSING） |
| ② `APPROVED` 卡死 | `status=APPROVED` + `approvedAt` 超时 + **`attemptCount=0`** | ✅ **全中** |

分支 ② 会把它重新入队（`payout-{id}-rescue-0`）→ worker 抢单 → 解密再失败 →
事务回滚 → 又是 `APPROVED` + `attemptCount=0` → **下一个扫描周期再来一遍**。

四个后果：

1. **商家永远看到「已审批」**，钱永远不到账，界面没有任何失败原因
   （`failureReason` 是 `null`）
2. **重试预算永远不消耗** —— `attemptCount` 的 `increment` 与状态变更在同一个
   事务里，一起被回滚 → 永远是 `0` → `scheduleRetry` 的 3 次上限形同虚设
3. **明细占用永久不释放** —— `payout_entries.entryId` 上的唯一索引仍被占着，
   商家对同期重新申请会撞索引 → 500
4. 每 5 分钟一次无意义的解密失败噪音

### 2.2 为什么落 `FAILED` 是安全的

⚠️ **关键论证**：解密发生在**调渠道之前**。解密失败 → 渠道**从未被调用** →
**确定没打钱**。

这与 `PROCESSING` 卡死是**相反**的情形。设计 §九·R3 规定「`PROCESSING` 卡死
绝不自动重试」，理由是「请求可能已经发出去了，钱可能已经打到商家账上」。
本场景不存在这个不确定性，所以**不能套用同一套处置**——套用会导致单子永远卡着。

### 2.3 改法

三处改动，都在已有文件里，**不新增文件、不新增状态、不改 `scanStuck`**。

**① `api/src/modules/billing/payout-execution.service.ts`**

`ExecutionClaim`（`:37-50`）加一个字段：

```ts
export interface ExecutionClaim {
  attemptCount: number;
  netAmount: number;
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
  account: { accountName: string; bankName: string; accountNo: string } | null;
}
```

`claimForExecution` 里把解密从「抛错」改成「捕获」：

```ts
let account: ExecutionClaim['account'] = null;
let accountError: string | null = null;

if (payout.snapshotAccountNoCipher) {
  try {
    account = {
      accountName: payout.snapshotAccountName ?? '',
      bankName: payout.snapshotBankName ?? '',
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
    //    「忘了迁移」若被当成「就是明文」，等于把加密悄悄关掉。
    accountError = error instanceof Error ? error.message : String(error);
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

> ⚠️ **底层仍然响亮地失败**：`PayoutCipherService.decryptVersioned`
> （`api/src/modules/billing/payout-cipher.service.ts:66-80`）**一个字都不改**，
> 它照样抛带中文原因的错。改的只是**上层的处置**：从「抛给 BullMQ」
> 变成「捕获 → 记日志 → 落 `FAILED`」。**底层不妥协，上层决定处置。**
>
> ⚠️ 因此 `payout-cipher.service.spec.ts` 的 12 条单测**全部不用改**。

**② `api/src/modules/payment/payout.worker.ts`**

在 `runExecute`（`:104-173`）里，`checkGates` **之前**判 `accountError`：

```ts
// ⚠️ **必须在 checkGates 之前判** —— 否则 `account` 为 null 会让
//    checkGates 报「收款账户快照缺失」，把真实原因盖掉。
if (claim.accountError) {
  // ⚠️ **根因只进日志**（界面口径见 §二·2.4）。
  this.logger.error(
    `出款 ${payoutId} 的收款账号快照不可用：${claim.accountError}`,
  );
  await this.execution.markFailed(payoutId, {
    // ⚠️ **文案要自证「没打钱」** —— 解密失败发生在调渠道之前，
    //    渠道从未被调用。商家端对所有 `FAILED` 都会接一句
    //    「请联系平台确认出款情况」，若这里不说明白，
    //    商家会以为钱可能已经打出去，白打一个电话核对。
    reason: '收款账号信息异常，本次未打款，请更新收款账户后重新申请',
    failedAt: await this.prisma.databaseNow(),
  });
  return;
}
```

> ⚠️ **`markFailed` 的条件是 `status: PROCESSING`**（`payout-execution.service.ts:212`）。
>    解密失败时单子刚被抢成 `PROCESSING` → 条件命中 → 落 `FAILED` 生效。
>    同时 `markFailed` 会 `payoutEntry.deleteMany`（`:226`）→ **明细占用被释放**
>    → 商家对同期重新申请不会撞唯一索引
>    （`findActivePayout` 的排除列表含 `FAILED`，`payout.service.ts:1125-1129`；
>    部分唯一索引的 `WHERE` 也含 `FAILED`，两端口径一致）。

**②b `checkGates` 里的「快照缺失」也要改成业务口径**

`payout.worker.ts:188` 现在写的是 `'收款账户快照缺失'`。这是**另一条路径**：
快照密文本来就是空的（历史单压根没抄账户）→ `account` 为 null、`accountError` 也为 null
→ 走 `checkGates` → 落 `FAILED`，`failureReason` 是「收款账户快照缺失」。

⚠️ **「快照缺失」对商家同样是无意义的内部术语**（商家会问「什么叫快照缺失」）。
它与解密失败**同属「确定没打钱」**，所以口径要一样：

```ts
if (!claim.account) {
  return '收款账号信息异常，本次未打款，请更新收款账户后重新申请';
}
```

⚠️ **两条路径的 `failureReason` 完全相同**是有意的 —— 它们对商家是同一件事
（账户不可用 → 没打钱 → 更新账户后重新申请），差异只在根因（日志里）。

> ⚠️ **另一条路径**：`netAmount <= 0` 的闸（`payout.worker.ts:184`）写的是
> `出款金额非法：${claim.netAmount} 分`。金额非法**确实没打钱**，但它暴露了
> 内部金额数字 → 同样改成业务口径「出款金额异常，本次未打款，请联系平台核对」。
> ⚠️ 这一条**不在 5k 的核心路径上**（金额非法是历史遗留的脏数据），但既然
> 口径统一，就一并改。

**③ `scanStuck` 不用改**

单子不再是 `APPROVED`，分支 ② 捞不到它 → **无限循环自然断开**。
这是本方案最大的优点：不加状态、不加字段、不加分支、不动既有兜底逻辑。

### 2.4 失败原因的分层

⚠️ **同一个 `failureReason` 字段，界面与日志两套口径**：

| 载体 | 内容 | 谁能看 |
|------|------|--------|
| `failureReason`（界面） | `收款账号信息异常，本次未打款，请更新收款账户后重新申请` | 商家 + 平台 |
| worker 日志 | `尚未加密（版本 0），请先执行 npm run migrate:payout-encryption` | 运营（翻日志） |

⚠️ **界面的文案要自证「没打钱」**：解密失败发生在调渠道之前 → 渠道从未被调用 →
**确定没打**。商家端对所有 `FAILED` 都会接一句「请联系平台确认出款情况」，
若 `failureReason` 不说明白，商家会以为钱可能已经打出去 → 白打一个电话核对。

**为什么商家端不显示根因**：`decryptVersioned` 的消息里有「密钥不匹配」
「密文已被篡改」「版本 0」这类内部术语。商家看到「密钥不匹配」会以为自己的
银行账号被篡改了，可能引发不必要的恐慌或申诉。

#### 商家端的失败模板要改一处

`merchant-admin/src/app/(dashboard)/settlements/[id]/page.tsx:120-124`：

```tsx
{payout.status === 'FAILED' && (
  <p className="text-sm text-destructive">
    出款失败：{payout.failureReason ?? '未知原因'}。请联系平台确认是否已到账。
  </p>
)}
```

⚠️ **「请联系平台确认是否已到账」这句对两类失败都成立吗？**

| 失败类型 | 钱打出去没 | 这句话 |
|---|---|---|
| 渠道试满 3 次 | **可能已经打出去**（渠道超时 / 网络中断） | ✅ 成立，必须核对 |
| 解密失败 | **确定没打** | ❌ 不成立 |

→ 改成 **「请联系平台确认出款情况」**（对两类都成立，且不引入条件判断）。

⚠️ **不要按失败原因分支**（前端判断文案字符串）：后续改措辞就失效，
而且「哪些文案表明没打钱」这个知识会散落到前端。

> ⚠️ **代价（如实记录）**：平台端界面因此**看不到根因**，运营要翻日志才能区分
> 「是没迁移」「是密钥错了」「是应用版本不匹配」——这三者的处置方式完全不同
> （跑迁移脚本 / 改环境变量 / 升级应用）。
> 这是「简单优先」换来的：口径统一、商家不看到内部术语。

**文案细节**：口径里**不带**「请联系平台」——商家端界面后面已经接了
「请联系平台确认是否已到账」，平台端则是超管自己看「请联系平台」很别扭。
平台端最终显示的是「收款账号信息异常，无法完成打款（已尝试 1 次）」。

### 2.5 崩溃窗口（如实记录）

事务提交（单子进 `PROCESSING`）到 `markFailed` 之间若进程崩溃 → 单子卡在
`PROCESSING` → `scanStuck` 分支 ① **告警但不自动重试**（R3 的规矩：钱可能已打出去）。

窗口 = 一次数据库往返。**极小，但不假装它不存在。**

⚠️ **且没有自助处置入口**：当前**没有任何接口**能把 `PROCESSING` 手工改成
`FAILED`（`PayoutStatus` 的转换只发生在 worker 与 `approve`/`reject`/`cancel` 里，
平台端的 `PayoutActions` 只有审批与拒绝）→ 这一类单**只能人工直接改库**。
§七·7.1 第 3 条要把这点写清楚。

⚠️ **注意这一类单与解密失败的单不同**：解密失败的单**确定没打钱**（渠道没被调用），
所以人工改库是安全的；而 R3 保护的是「渠道可能已经打出去」的情形 —— 那类单
人工改库前**必须**先核对渠道对账。**两者不能混为一谈。**

---

## 三、商家端的收款账户可见性

### 3.1 后端早就发了

`PayoutView`（`api/src/modules/billing/payout.service.ts:85-94`）已经带这三个字段，
**商家端与平台端共用 `toView`**（`:1222-1258`），`toPlatformView`（`:1261-1273`）
是在它基础上加字段：

| 字段 | 内容 |
|------|------|
| `snapshotAccountName` | 户名（快照） |
| `snapshotBankName` | 开户行（快照） |
| `maskedSnapshotAccountNo` | 账号掩码串（快照） |

商家端只是**没在类型里声明、也没渲染**。→ **后端零改动**，前端要动两个文件：

| 文件 | 改动 |
|------|------|
| `merchant-admin/src/lib/payout.ts` | ① `PayoutItem` 加三个字段声明 ② **拷贝一份 `describePayoutAccount`** |
| `merchant-admin/src/app/(dashboard)/settlements/[id]/page.tsx` | 渲染「收款账户（申请时）」那一行 |

⚠️ **`describePayoutAccount` 商家端没有，要拷贝一份**（平台端那份在
`platform-admin/src/lib/payout.ts:168`）。⚠️ **两个 `lib/payout.ts` 是各自分离的
文件**（不同 Next.js 应用，不共享代码）→ 只能拷贝，不能 import。

⚠️ **`PayoutItem` 加字段后 TypeScript 立刻开始校验**：`apiFetchAuthed<PayoutDetail>`
的泛型变了 → 少一个字段就编译报错。这是好事（编译期兜底），但要知道会红。

⚠️ **护栏 X14 不受影响**：这三个字段是**掩码串 + 户名 + 开户行**，
不是完整账号。完整账号（`accountNo`）压根不在 `PayoutView` 里，
只存在于 `ExecutionClaim`（进程内，不进 API 响应）。

### 3.2 申请页

`merchant-admin/src/app/(dashboard)/settlements/apply/page.tsx` 现在只 fetch
了 `availablePeriods`。要加一次 `GET /merchant/payout-account`（**接口已存在**，
`merchant-admin/src/app/(dashboard)/settlements/account/page.tsx` 在用）。

显示文案：

- **有账户** → 「本次出款将打到：招商银行 ****1234（张三）」
- **没有账户** → 「尚未设置收款账户」+ 链到 `/settlements/account`
  （`apply` 接口本身会拒：`'请先在「出款」页设置收款账户'`，`payout.service.ts:235`）

⚠️ **字段名别取错** —— 申请页用的是**当前账户**的字段，与详情页的不是同一组：

| 页面 | 数据源 | 掩码字段 |
|------|--------|---------|
| 申请页 | `GET /merchant/payout-account` → `PayoutAccountView` | `maskedAccountNo` |
| 详情页 | `GET /merchant/payouts/:id` → `PayoutView` | `maskedSnapshotAccountNo` |

⚠️ **两者的掩码串可能不同**：申请页是**当前**账户的，详情页是**申请那一刻**的快照。
商家改过账户就会不一样。

⚠️ **账户接口失败不阻断申请**：它只是展示信息，申请接口有服务端校验。
显示「收款账户加载失败」即可，不要让整个申请页挂掉。

⚠️ **顺带修正一处指引不一致**：`apply` 的错误消息说「请先在**「出款」页**设置
收款账户」，但账户设置页在 `/settlements/account`，商家在出款列表页找不到入口。
改成「请先在「收款账户」页设置」之类指向准确的措辞。

### 3.3 详情页

`merchant-admin/src/app/(dashboard)/settlements/[id]/page.tsx` 加一行「收款账户」，
口径与平台端（`platform-admin/src/app/(dashboard)/payouts/[id]/page.tsx:131-136`）
一致：`{bankName} {maskedAccountNo}（{accountName}）`。

⚠️ **详情页显示的是「申请时的快照」，申请页显示的是「当前账户」**——
两者可能不同（商家申请后改了账户）。这是**正确的**：钱打给的是快照那份。
文案上详情页要写「收款账户（申请时）」以免商家困惑。

⚠️ **三项全空时不渲染这一行**——历史出款单的快照掩码可能是空串
（`maskedAccountNo` 列的默认值是 `''`）。平台端的 `describePayoutAccount`
已经处理了这种情况（`platform-admin/src/lib/payout.ts`），
商家端照做同款逻辑。

### 3.4 为什么不加列表页

**一商家一账户**（5h-1 的约束，`tenantId` 唯一）—— 但这条**只约束「当前账户」**，
**不约束快照**：商家改过收款账户后，不同期的出款单快照可以不同。

⚠️ **所以「列表页每行重复同一串掩码」这个理由不完全成立**。真正的理由是：
列表页的重点是**状态与金额**，一行塞太多信息反而难读；账户核对是**看某一张单**
时才做的事，放在详情页更合适。

---

## 四、失败原因的口径统一

### 4.1 现存的外泄点

`api/src/modules/billing/payout.service.ts:598-602`（5h-2 引入）：

```ts
const reason = error instanceof Error ? error.message : String(error);
await this.prisma.payout.updateMany({
  where: { id: updated.id, status: PayoutStatus.APPROVED },
  data: { failureReason: `入队失败，等待自动救援：${reason}` },
});
this.logger.error(`出款审批后入队失败：${updated.id} —— ${reason}（...）`);
```

`reason` 是原始异常消息——**可能是 Redis 连接细节**（主机名、端口、连接错误）。

### 4.2 ⚠️ 更正一个事实：当前**没有任何界面**显示它

**两端都在 `status === 'FAILED'` 时才渲染失败原因**：

- 商家端 `merchant-admin/src/app/(dashboard)/settlements/[id]/page.tsx:120`
- 平台端 `platform-admin/src/app/(dashboard)/payouts/[id]/page.tsx:160`

而入队失败时单子停在 **`APPROVED`**（不是 `FAILED`）→ **两端都看不到这段文字**。

> ⚠️ 这修正了本设计早先版本的说法（「商家在界面上看得到」）——**那是错的**。
> 现状是：这段内部原文躺在数据库的 `failureReason` 列里，
> 既没有界面消费者，也**暂时不会外泄**。
>
> ⚠️ **但它是个定时炸弹**：只要将来有人给 `APPROVED` 状态加一个
> 「显示备注」的渲染（比如 §四·4.3 要加的那行），内部原文就会**当场出现在
> 商家或超管眼前**。所以口径要在**加渲染的同一个改动里**收掉。

### 4.3 改法

**后端**（与 §二·2.4 同款：内部原文进日志，界面用业务口径）：

```ts
data: { failureReason: '打款任务提交失败，系统将自动重试' },
```

⚠️ **`markPaid` 会清掉 `failureReason`**（`payout-execution.service.ts:169`）→
打款成功后这句就不在了 ✅

**平台端加一行备注**（`APPROVED` 且有 `failureReason` 时显示）：

```tsx
{/* ⚠️ **只在 APPROVED 时显示**：入队失败的单停在 APPROVED，
    而失败原因只在 FAILED 时渲染 → 这行是「这张单刚入队失败过、
    正在等兜底扫描救援」的唯一信号。 */}
{payout.status === 'APPROVED' && payout.failureReason && (
  <div className="flex justify-between py-2 text-sm text-muted-foreground">
    <span>备注</span>
    <span>{payout.failureReason}</span>
  </div>
)}
```

⚠️ **平台端加这行、商家端不加**：商家看到「已审批 + 系统将自动重试」只会困惑
（「重试什么？是不是要我做什么？」），而超管看到它就知道「这张单刚入队失败过，
`scanStuck` 会救它」——**这是救援前的唯一信号**。

⚠️ **商家端不加还有个理由**：商家看到「已审批」就够了，他不需要知道平台的
内部调度出了什么问题。

---

## 五、启动时的账目密钥自检

### 5.1 要解决什么

`api/.env` 的 `PAYOUT_ACCOUNT_ENCRYPTION_KEY` 与 `infra/docker-compose.yml`
的固定值**必须逐字一致**（5j 遗留第 5 条）。不一致时：

- 本地跑迁移脚本用的密钥 ≠ 容器里应用用的密钥
- → 容器解不开所有已加密的数据
- → **每一张出款单都会 `FAILED`**（§二）
- → 商家看到一串「收款账号信息异常」，运营要从日志里反推才知道是密钥错了

⚠️ 5j 明确否决过「启动时全表扫描自检」（理由：每次启动把所有行拉出来解密一遍，
太贵）。本节是**只取一行**，不是全表。

### 5.2 改法

**新文件**：`api/src/modules/billing/payout-encryption-self-check.service.ts`

```ts
@Injectable()
export class PayoutEncryptionSelfCheck {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly cipher: PayoutCipherService,
  ) {}

  /**
   * 启动自检：拿库里**一行**已加密的数据试解一次。
   *
   * ⚠️ **只取一行，不扫全表**（5j 否决过全表扫描）。
   * ⚠️ **只校验 `encryptionVersion = 1` 的行** —— 版本 0 的行还没迁移，
   *    本来就解不开，不能因为它就让容器起不来。
   */
  async check(): Promise<void> {
    await tenantContext.run(platformScope(), async () => {
      // ⚠️ **两张表都要查，查完不早退** ——
      //    早退（查到账户行就 `return`）会漏掉「账户行用密钥 A、
      //    出款快照用密钥 B」的情形 —— 那种情况下账户行能解开、
      //    快照解不开 → 自检通过 → 容器照常起来 → 每一张出款单都落
      //    `FAILED`，运营只能翻日志反推（5j 的失败注入 F11 实测过
      //    「迁移脚本用错密钥加密了部分行」）。
      //
      // ⚠️ **条件只用版本号** —— 版本号是「这行加密过没有」的权威依据
      //    （5j 设计 §2 的原则：不能靠「能不能解密」去猜）。
      const account = await this.prisma.merchantPayoutAccount.findFirst({
        where: { encryptionVersion: 1 },
        select: { id: true, accountNoCipher: true },
      });
      if (account) {
        this.tryDecrypt(account.accountNoCipher, '商家收款账户');
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
        this.tryDecrypt(payout.snapshotAccountNoCipher!, '出款单收款账号快照');
      }
      // ⚠️ **两处都没有可校验的行 → 静默通过**：
      //    新库、或还没跑迁移的库（全是版本 0）都不该因此起不来。
    });
  }

  /** 解一行；解不开就抛错让进程退出 */
  private tryDecrypt(ciphertext: string, what: string): void {
    // ⚠️ **空串是脏数据，不是「跳过」** ——
    //    `accountNoCipher` 是 NOT NULL 列，空串只可能是迁移脚本留下的占位。
    //    跳过它就等于放过「正是自检要防的那种坏数据」。
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
        `账目加密自检失败：${what} 解不开（${error instanceof Error ? error.message : String(error)}）。` +
          '请检查 PAYOUT_ACCOUNT_ENCRYPTION_KEY 是否与加密时用的密钥一致' +
          '（本地 .env 与 infra/docker-compose.yml 必须逐字相同）。',
      );
    }
  }
}
```

**落点**：`api/src/main.ts` 的 `bootstrap` 里，**`app.listen(port)` 之前**：

```ts
// ⚠️ **账目密钥自检必须在监听端口之前**：
//    带着解不开的密文启动，运营看到的全是失败的出款单，
//    没人知道根因是密钥配错了。
await app.get(PayoutEncryptionSelfCheck).check();
await app.listen(port);
```

⚠️ 这个落点与既有的 `assertSecureConfig()` / `assertPayoutEncryptionKey()`
（`main.ts:14/18`）风格一致：**配置问题一律在建应用/监听端口前把关**。

⚠️ **`billing.module.ts` 要把 `PayoutEncryptionSelfCheck` 加进 `exports`** ——
否则 `app.get()` 在 `main.ts` 里拿不到它。

⚠️ **e2e 不会触发这个自检**：e2e 用 `Test.createTestingModule` + `app.init()`，
**不走 `main.ts` 的 `bootstrap`**。所以 e2e 里是**直接调 `check()`** 来测它
（§六·6.2）——测的是服务本身的行为，不是「启动会不会炸」。

⚠️ **错误消息分两层，不要混**：

| 情况 | 谁负责 | 消息 |
|------|--------|------|
| 密钥**缺失 / 长度不足 32** | `assertPayoutEncryptionKey()`（`main.ts:18`）与 `PayoutCipherService` 构造函数（`payout-cipher.service.ts:27-31`） | `PAYOUT_ACCOUNT_ENCRYPTION_KEY 未配置或长度不足 32 个字符` |
| 密钥**存在但值不对** | **自检**（本节） | `账目加密自检失败：… 请检查 PAYOUT_ACCOUNT_ENCRYPTION_KEY 是否与加密时用的密钥一致` |

⚠️ **构造期抛错早于自检**：`PayoutCipherService` 在 `NestFactory.create` 期间就被
构造 → 密钥缺失时是**构造期抛错**，自检那段精心设计的文案**根本不会显示**。
这是对的分工：自检只负责「密钥存在但解不开」这一档。

⚠️ **与周期扫描的次序无碍**：`PayoutScanScheduler.onModuleInit`
（`payout-scan.scheduler.ts:56-63`）在 `NestFactory.create` 时就注册了，
所以扫描 job 的注册**早于**自检。自检失败 → 进程退出 → job 随进程一起消失，
无副作用。

### 5.3 自检的判定规则

⚠️ **两张表的列名不一样，别混**：

| 表 | 版本列 | 密文列 | 可空性 |
|----|--------|--------|--------|
| `merchant_payout_accounts` | `encryptionVersion` | `accountNoCipher` | NOT NULL |
| `payouts` | `snapshotEncryptionVersion` | `snapshotAccountNoCipher` | **可空**（`String?`） |

| 情况 | 结论 |
|------|------|
| 两张表都**没有**版本号为 `1` 的行 | **跳过**（无可校验对象）—— 新库、或还没迁移的库都不能因此起不来 |
| 某张表有这样的行，且**解得开** | 那张表通过（**另一张表继续查**） |
| 某张表有这样的行，但**密文是空串** | **抛错退出**（空串 = 迁移留下的占位 = 脏数据） |
| 某张表有这样的行，且**解不开** | **抛错退出**（fail-fast） |

⚠️ **两张表都要查，不能早退** —— 查到账户行就 `return` 会漏掉
「账户行用密钥 A、出款快照用密钥 B」的情形（5j 的失败注入 F11 实测过
「迁移脚本用错密钥加密了部分行」）：那种情况下账户行能解开、快照解不开 →
自检通过 → 容器照常起来 → **每一张出款单都落 `FAILED`**，运营还是只能翻日志反推。
**这正是自检要防的那个场景。**（这一条是实施后的独立审查补上的 ——
初稿的伪码里有个 `return`，与同段注释「两张表都要查」自相矛盾。）

⚠️ **可空列的查询条件用 `not: null`，不用 `not: ''`**（理由见 §五·5.2 的代码注释）。

⚠️ **查询必须在平台作用域下**（`tenantContext.run(platformScope(), ...)`）：
这两张表在租户白名单里，平台作用域**不附加** tenantId 条件 → 能查到任意租户的行。
`AsyncLocalStorage` 的上下文不跟着进程走，自检跑在 `main.ts` 里没有租户上下文。

⚠️ **没有租户上下文时会抛 `TenantScopeError`，不是「查不到行」** ——
`resolveScope`（`api/src/common/tenant/tenant-prisma.service.ts:96-100`）在
`!context` 时直接抛错。**这一点影响失败注入 G4 的断言写法**（§六·6.3）。

⚠️ **fail-fast 的取舍**：抛错让容器起不来，是**故意**的。带着解不开的密文跑着，
运营看到的全是 `FAILED` 单，且没人知道根因在启动时就该发现。
⚠️ **误伤的可能**：若库里有一行脏数据（比如迁移脚本用错密钥加密过——
5j 的失败注入 F11 实测过这种情况），容器会一直起不来，需要人工修数据。
**这是正确的**：数据坏了就不该带着跑。

### 5.4 测试

| 层 | 用例 |
|----|------|
| 单测 | 库里无可校验行 → 不抛错；可解 → 不抛错；**密文是空串** → 抛错（视为脏数据，不跳过）；解不开 → 抛错且消息指明「哪张表」与「检查 `PAYOUT_ACCOUNT_ENCRYPTION_KEY`」 |
| 单测 | ⚠️ **账户行能解但快照行解不开 → 也要抛错**（两张表都要查，不能早退） |
| e2e | 把某行账户的密文改成乱码 → 调 `check()` → 断言抛错 → **还原**（真库，不能残留）。⚠️ **必须独占跑**：它改真库的数据 |
| e2e | ⚠️ **只改坏出款快照（账户行不动）** → `check()` 也要抛错 → 还原。这是「两张表都要查」的牙齿 |

⚠️ **改哪一行是不确定的** —— 自检的 `findFirst` **没有 `orderBy`**，
Postgres 返回哪一行随查询计划变。所以 e2e 要「把**所有**候选行都改坏」，
而不是只改自己造的那一行；`finally` 里逐行还原。

⚠️ **「库里没有可校验的行」这条 e2e 的前提要显式造出来** ——
同批跑的其他 e2e 文件会留下版本 1 的行（实测整轮跑批后有 11 行账户 + 6 行快照），
不显式造出前提的话那条断言是**恒真**的。

---

## 六、测试与失败注入

### 6.1 单测

| 位置 | 用例 |
|------|------|
| `payout-execution.service.spec.ts:191` | **改写**：「快照还没加密（版本 0）→ 抛错」改为「→ 不抛错，返回 `accountError` 含「尚未加密」+ `account` 为 `null`」 |
| `payout-execution.service.spec.ts`（新增） | `accountError` 为 `null` 时 `account` 正常返回（不回归） |
| `payout-worker.spec.ts`（新增） | 见 `accountError` → 调 `markFailed` 且 `reason` 是**业务口径**（断言不含「尚未加密」「密钥不匹配」，且**含「本次未打款」**） |
| `payout-worker.spec.ts`（新增） | `account` 为 `null` 且 `accountError` 为 `null`（历史单没抄账户）→ 走 `checkGates` → `failureReason` 也是业务口径（**不是**「收款账户快照缺失」） |
| `payout.service.spec.ts`（新增/改写） | 入队失败 → `failureReason` 是业务口径（断言不含原始错误消息） |
| `payout-encryption-self-check.service.spec.ts`（新建） | §五·5.4 四种情况 |

⚠️ **`payout-worker.spec.ts` 用连字符**（源文件 `payout.worker.ts` 用点号，
但 spec 用连字符 —— 别新建一个 `payout.worker.spec.ts`，那会留下两份）。

### 6.2 e2e

| 用例 | 断言 |
|------|------|
| **改写** `payout-encryption.e2e-spec.ts:606` | 「未迁移的行 → 打款路径抛错」改为「→ 不抛错，`accountError` 含「尚未加密」与 `migrate:payout-encryption`，`account` 为 `null`（**不按明文兜底**）」。⚠️ **原意图必须保留**：不能按明文兜底、错误消息必须指向迁移命令 |
| ⚠️ **同一用例里还有第二处断言要改** | `:677-687` 那段 `catch` 块（断言 `message` 含「尚未加密」「migrate:payout-encryption」且不含「密钥不匹配」）→ 改成读 `claim.accountError`，**保留「不含密钥不匹配」这条** |
| **新增** | 解密失败 → 单子落 `FAILED` + **明细占用被释放**（`payout_entries` 无残留）+ **渠道没收到请求** |
| **新增** | 解密失败的 `FAILED` 单**不再被 `scanStuck` 捞到**（`scanStuck` 返回空）——**证明无限循环断了** |
| **新增** | 启动自检：把某行账户的密文改成乱码 → `check()` 抛错 → 还原 |
| **新增** | 商家端 `GET /merchant/payouts/:id` 返回 `maskedSnapshotAccountNo` 等三个字段（后端本来就有，这一条**钉住它不被改掉**） |

⚠️ **「渠道没收到请求」要放在「解密失败 → 落 `FAILED`」那条**（走完整 worker 流程）——
改写后的那条是**直接调 `claimForExecution`**（不走队列），压根不会调渠道 →
那条断言是**恒真的**，没有牙齿。

⚠️ **启动自检那条会改真库的唯一一行账户**（实测账户表只有 1 行）→
**必须独占跑**，不能与其它 e2e 并发。

### 6.3 失败注入

⚠️ **失败注入必须独占**（不与全量测试并发）。

| 编号 | 注入 | 期望 |
|------|------|------|
| **G1** | 把 `claimForExecution` 的 `catch` 去掉（恢复成抛错） | 单子停在 `APPROVED`；`scanStuck` 会捞到它 → 挂 |
| **G2** | 把 worker 的 `accountError` 分支去掉（继续走 `checkGates`） | `failureReason` 变成「收款账户快照缺失」→ 业务口径断言挂 |
| **G3** | 把 `markFailed` 的 `payoutEntry.deleteMany` 去掉 | 明细占用残留 → 挂 |
| **G4** | 自检里去掉平台作用域（改用默认作用域） | **断言必须区分错误类型**，见下 |
| **G5** | 自检里把「跳过」的条件去掉（无可校验行也报错） | 新库起不来 → 挂 |

> ⚠️ **G4 的断言必须区分错误类型**：默认作用域（无租户上下文）下
> `findFirst` **抛 `TenantScopeError`**，不是「查不到行」
> （`tenant-prisma.service.ts:96-100` 的 `resolveScope` 在 `!context` 时直接抛）。
>
> ⚠️ **只断言「抛错」是没有牙齿的**：自检失效与作用域失效抛的都是错，
> 分不清是谁抛的；而如果实施者为了「让容器能起来」把作用域错误吞掉，
> 自检就彻底失效了 —— 而这正是 G4 要检测的。
>
> → **断言要比对错误消息**：必须是自检自己的错（含「账目加密自检失败」）
> 或来自 `tryDecrypt`，**不能**是 `TenantScopeError`。

### 6.4 浏览器手测

| 步 | 内容 |
|----|------|
| 1 | 商家端「申请出款」页 → 能看到「本次出款将打到：招商银行 ****1234（张三）」 |
| 2 | 商家端出款单详情页 → 能看到「收款账户（申请时）」那一行 |
| 3 | 平台端出款单详情页 → 收款账户行**仍在**（回归） |
| 4 | 商家端出款单详情页，状态为 `FAILED` → 失败原因是业务口径，**不含**「密钥不匹配」，且**含**「本次未打款」；那句提示是「请联系平台确认**出款情况**」（不是「是否已到账」） |
| 5 | 平台端出款单详情页，单子停在 `APPROVED` 且有 `failureReason` → 能看到「备注」那一行 |

---

## 七、风险与遗留

### 7.1 本阶段引入的

| # | 事项 | 说明 |
|---|------|------|
| 1 | **密钥配错 → 批量出款单 `FAILED`，且不会自动恢复** | 5j 的写路径闸只查**版本号**、不查密钥 → 密钥错时申请与审批都能过，一路到打款才炸。状态机没有 `FAILED → ?` 的转换 → 修好密钥后**商家必须全部重新申请**。这是「根因只进日志」+「不做批量恢复」两个选择的叠加后果 |
| 2 | **启动自检可能让容器起不来** | 库里有脏数据（用错密钥加密过的行）时自检失败 → 容器一直起不来 → 需要人工修数据。**这是故意的**（坏数据不该带着跑） |
| 3 | **崩溃窗口，且没有自助处置入口** | 事务提交到 `markFailed` 之间进程崩溃 → 单子卡 `PROCESSING` → 只告警不自动重试 → **当前没有任何接口能把它手工改成 `FAILED`**（`PayoutStatus` 的转换只在 worker 与 `approve`/`reject`/`cancel` 里）→ 只能人工直接改库（§二·2.5） |
| 4 | **`accountError` 的根因只进日志** | 平台端界面看不到「是没迁移 / 是密钥错了 / 是版本不匹配」，运营要翻日志 |
| 5 | **`FAILED` 承载了两种语义** | 「渠道试满 3 次」（钱**可能**已打出去，必须人工核对）与「解密失败」（**确定没打**，可让商家重新申请）。商家端用一句通用措辞（「请联系平台确认出款情况」）覆盖两者 → 商家可能为一个确定没打钱的单打了电话。不新增状态是刻意选择（§一·1.3），代价在此 |
| 6 | **渠道失败原因会原样透到商家屏幕** | 渠道抛出的异常原文（可能是带主机名、请求 id 的网关报错）经 `markFailed` 落进 `failureReason`，商家端在 `FAILED` 时原样渲染。⚠️ **这是 5h-2 就有的行为，不是 5k 引入的**，且 §二·2.4 的口径规定**只覆盖解密路径**。**刻意不修**：渠道错误对商家没什么意义，但超管要靠它排查 —— 把它收掉等于把超管的排查线索也收掉。要收的话得先决定「超管看渠道原文、商家不看」怎么实现（那是分端口径，不是字段口径） |

### 7.2 5j 的遗留，本阶段未处理的

| # | 事项 | 状态 |
|---|------|------|
| 1 | 商家端与平台端的「纳入笔数」来源不同 | 有意保留 |
| 2 | 缺笔的双路径重复实现 | 有用例盯住一致性，重复本身保留 |
| 3 | 迁移脚本的备份表永久留在库里 | 需人工清理 |
| 4 | 5h-1 遗留的两条概率性 e2e flaky | 与本阶段无关 |

### 7.3 对 5j 验收记录的更正

⚠️ **5j 验收记录 §五 第 10 条**写的是「出款单停在 `PROCESSING`」——**不准确**。
实测是停在 `APPROVED`（§二·2.1）。5k **直接修改** 5j 验收记录的那一行，
并附实测数据（错误描述会误导后来人）。

---

## 八、实施分解

| Task | 内容 | 层 |
|------|------|------|
| 1 | `claimForExecution` 捕获解密异常 + `ExecutionClaim` 加 `accountError` | 后端 |
| 2 | worker 的 `accountError` 分支 → `markFailed`（业务口径）+ `checkGates` 两条闸的口径统一 | 后端 |
| 3 | 入队失败的口径统一 + 平台端「备注」行 | 后端 + 平台端 |
| 4 | 启动自检（service + `main.ts` 落点 + `billing.module.ts` 的 exports） | 后端 |
| 5 | 商家端：`lib/payout.ts`（三字段 + `describePayoutAccount`）+ 申请页 + 详情页 + 失败模板措辞 | 前端 |
| 6 | 单测 / e2e / 失败注入 / 手测 / 验收记录 + 更正 5j 验收记录 | 全 |

---

## 九、独立审查的修正记录

本文档初稿写完后，派了一个**独立审查代理**做对抗式审查（要求它读实际代码验证
每个假设，而不是只读文档）。**它提出的 12 条技术问题全部核实成立**，
已逐条改入本文档：

| # | 审查发现 | 处置 |
|---|---------|------|
| 1 | `payouts.snapshotAccountNoCipher` 是**可空**列，`{ not: '' }` 在 PostgreSQL 里对 NULL 求值为 NULL → 行为依赖 Prisma 版本 | 改用 `{ not: null }`（§五·5.2） |
| 2 | 账户行的 `accountNoCipher` 空串是**迁移留下的占位**，会被 `{ not: '' }` 静默跳过 → 正是自检要防的坏数据 | 查询只用版本号；空串**视为脏数据 → 自检失败**（§五·5.2） |
| 3 | 无租户上下文时 `findFirst` 是**抛 `TenantScopeError`**，不是「查不到行」 | 写进 §五·5.3，并要求 **G4 的断言区分错误类型**（§六·6.3） |
| 4 | 「快照密文为空」那条路径走 `checkGates`，文案仍是内部口径「收款账户快照缺失」 | 一并改成业务口径（§二·2.3·②b） |
| 5 | 密钥**缺失**（构造期抛错）与密钥**不对**（自检抛错）是两层，消息不同 | 写进 §五·5.2 的「错误消息分两层」表 |
| 6 | 商家端 `lib/payout.ts` 里**没有** `describePayoutAccount` → 「纯前端改动」低估了工作量 | 改为「后端零改动；前端要动 `lib/payout.ts`（三字段 + 拷贝一份工具函数）」（§三·3.1） |
| 7 | spec 文件名是 **`payout-worker.spec.ts`**（连字符），设计里写的点号会新建错名文件 | 已改（§六·6.1） |
| 8 | `accountError` 的注释「null = 账户可用」措辞错误 | 已改（§二·2.3·①） |
| 9 | 卡在 `PROCESSING` 的单**没有任何接口能手工改成 `FAILED`** | 写进 §二·2.5 与 §七·7.1 第 3 条 |
| 10 | 改写的那个 e2e 用例里**还有第二处 catch 断言**要一起改 | 已写进 §六·6.2 |
| 11 | 「渠道没收到请求」在不走队列的用例里是**恒真断言** | 移到走完整 worker 流程的那条（§六·6.2） |
| 12 | 申请页与详情页的掩码**字段名不同**（`maskedAccountNo` vs `maskedSnapshotAccountNo`） | 已在 §三·3.2 用表格标注 |

⚠️ **审查提出的「为解密失败新增状态」建议未被采纳**：它要动 `PayoutStatus` 枚举、
Prisma migration、两端文案、全部 `notIn` 排除列表，与 §一·1.3 已定的
「不新增出款单状态」冲突。但它指出的**语义问题是真的**（`FAILED` 承载了
「可能已打」与「确定没打」两种含义）→ 改用**文案自证 + 商家端通用措辞**解决（§二·2.4），
代价记在 §七·7.1 第 5 条。

### 9.1 ⚠️ 审查同时揪出了本文档初稿的**一处事实性错误**

初稿 §四 写「这段文字**商家在界面上看得到**」——**错的**。
实测两端都只在 `status === 'FAILED'` 时渲染失败原因，而入队失败停在 `APPROVED`
→ **两端都看不到**。已在 §四·4.2 更正，并顺带补上了平台端的「备注」行
（`APPROVED` + 有 `failureReason` 时显示）—— 那是「这张单正等着被救援」的唯一信号。

---

## 十、实施后的独立审查

实现做完后，又派了一个**独立审查代理**做对抗式审查（要求它读实际代码验证每个假设，
并允许它跑失败注入）。它提出的问题里 **1 条是真缺陷**，已修；其余 3 条已记入遗留。

| # | 审查发现 | 处置 |
|---|---------|------|
| 1 | ⚠️ **启动自检只查账户表、查不到就不查出款快照表** —— 与 §五·5.2 注释「两张表都要查」不符。实测构造「账户行正常 + 全部快照密文被改坏」，自检**照样通过** | ✅ **已修**：删掉早退，两张表各查一行、各自校验；补单测（账户能解 + 快照解不开 → 抛错）与 e2e（只改坏快照 → 抛错）。⚠️ **初稿的伪码本身就有那个 `return`** —— 是**设计与实现一起错**，注释与伪码自相矛盾。伪码与 §五·5.3 的判定表已一并更正 |
| 2 | e2e「库里没有可校验的行」那条用例的**前提在真实跑批里是假的** —— 同批跑的其他文件会留下 11 行版本 1 的账户 → 断言恒真 | ✅ **已修**：显式把两张表的候选行都按回版本 0（`finally` 逐行还原），并把「候选行数为 0」写成断言 |
| 3 | 平台端新增的「备注」行**没有任何自动化测试** | ✅ **已修**：补 4 条（`APPROVED` + 有 `failureReason` → 显示；无 → 不显示；`FAILED` → 显示「失败原因」而不是「备注」；「备注」行不得露出 Redis 之类的内部细节） |
| 4 | **渠道失败路径仍把渠道原文透到商家屏幕** | ⚠️ **不修，记为遗留** —— 这是 **5h-2 就有的行为**，不是 5k 引入的；且渠道错误对商家确实没什么意义，但超管要靠它排查。§二·2.4 的口径规定**只覆盖解密路径**。见 §七·7.1 第 6 条 |

### 10.1 审查同时核实过、结论是「没问题的」关键点

（记在这里，让后来人知道这些地方已经被审过）

- 解密失败被捕获后**事务真的会提交**（`attemptCount` 的自增与 `status → PROCESSING` 都留下）；
- `accountError != null` **恒蕴含** `account == null` —— 不存在「有错误但有账户」的第四态；
- **「明文当密文」不可能被当成合法值返回**（`decryptField` 失败一律抛错）；
- worker 的 `accountError` 分支在 `checkGates` **之前**、在 `provider.execute` **之前**；
- `scanStuck` 的两个分支**都捞不到**落 `FAILED` 的单 → 无限循环真的断了；
- e2e 的「`scanStuck` 捞不到」那条断言**不是恒真** —— 审查代理构造了改写前的确切状态
  （`APPROVED` + `attemptCount = 0` + `approvedAt` 一小时前），实测 `scanStuck` **确实会捞到它**；
- 部分唯一索引的 WHERE 与 `findActivePayout` 的 `notIn` **逐字一致**，都含 `FAILED`；
- 启动自检在 `app.listen()` **之前**，用错密钥实测**端口没打开**、进程退出；
- 商家端**没有泄露完整账号**（护栏 X14 成立）；
- **没有超出设计范围的改动**（无 schema 变更、无新状态、无 `FAILED → APPROVED` 转换）。
