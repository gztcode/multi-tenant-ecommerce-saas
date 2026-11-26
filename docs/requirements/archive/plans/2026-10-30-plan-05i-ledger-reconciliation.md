# 阶段 5i「账目口径收口」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让平台报表、结算单、出款单、商家对账单四者共用同一事实源（`commission_entries` + `merchant_receipts`），并让商家能自助核对自己被抽了多少。

**Architecture:**
- 新建纯函数模块 `api/src/modules/billing/ledger.ts`：符号换算、按期分组、出款分桶、可申请判定。
- 平台报表（`report.service.ts`）从聚合 `orders` 改成聚合 `commission_entries`。
- 新增 `api/scripts/check-ledger.ts`（只读自检）+ `npm run check:ledger`。
- 新增按期批量聚合方法（`payout.service.ts`），出款页与商家侧对账单**共用**（顺带修 5h-2 的 L55 N+1）。
- 新增商家侧「对账单」端点与页面（路由 `/statements`）。

**Tech Stack:** NestJS 11 / Prisma 6 / PostgreSQL 16 / BullMQ / Next.js（merchant-admin）/ Vitest + Jest

**依据设计:** `docs/superpowers/specs/2026-10-30-plan-05i-ledger-reconciliation-design.md`（**动手前必读**，尤其是 §三 的口径表与 §5.2b 的判定规则）

---

## §0.1 硬约定（每个 Task 都适用）

1. **金额一律整数分**，不在后端换算成元；前端用 `formatCents`（`lib/payout.ts`）。
2. **时间一律 UTC**；周期是自然月、左闭右开，用 `resolveMonthlyPeriod` / `formatPeriodLabel`（`settlement.ts`）。
3. ⚠️ **模块依赖铁律**：`billing` **绝对不能** import `payment`（会成 `order → billing → payment → order` 的环）。
4. ⚠️ **`tenantContext.run(...)` 的回调必须是 `async` 函数** —— Prisma 6 的 PrismaPromise 是 thenable，
   同步回调会让租户上下文在查询执行时丢失 → **租户隔离静默失效**。
5. ⚠️ **商家侧的查询不手写 `tenantId`**（靠租户作用域扩展自动附加）。
   但 `settlement_statement_entries` 与 `payout_entries` **没有 tenantId、不在白名单**
   → 查它们之前**必须先校验归属**。
6. ⚠️ **中文注释、英文标识符**；注释要写「**为什么**」，不是「做了什么」。
7. ⚠️ **不新增任何表、不改任何字段**（设计 §7.2）。
8. ⚠️ **两个前端（`merchant-admin` / `platform-admin`）的 `lib/*.ts` 是各自独立的副本** ——
   本阶段只改 `merchant-admin`，**不动** `platform-admin` 的 `lib/payout.ts`。

## §0.2 文件结构

```
api/src/modules/billing/
  ledger.ts                    【新建】纯函数：符号换算 / 按期分组 / 出款分桶 / 可申请判定
  ledger.spec.ts               【新建】上面的纯函数的单测
  report.service.ts            【改】报表切到 commission_entries
  report.service.spec.ts       【改】新增符号换算的用例
  payout.service.ts            【改】新增按期批量聚合；availablePeriods 改用它
  merchant-statement.controller.ts 【新建】商家侧对账单端点
  merchant-statement.service.ts    【新建】商家侧对账单服务层
  merchant-statement.service.spec.ts【新建】服务层单测
api/scripts/
  check-ledger.ts              【新建】只读自检脚本
api/test/
  ledger-reconciliation.e2e-spec.ts 【新建】本阶段的 e2e
merchant-admin/src/
  lib/statement.ts             【新建】对账单的类型与文案
  lib/statement.test.ts        【新建】
  app/(dashboard)/statements/page.tsx     【新建】对账单列表
  app/(dashboard)/statements/[period]/page.tsx 【新建】对账单详情
  app/(dashboard)/layout.tsx   【改】加「对账单」导航
```

## §0.3 测试命令

```bash
# api 单测
cd api && npm test

# api e2e（定向）
cd api && npm run test:e2e -- test/ledger-reconciliation.e2e-spec.ts

# api 全量 e2e
cd api && npm run test:e2e

# lint
cd api && npm run lint

# merchant-admin 单测
cd merchant-admin && npx vitest run test/lib/statement.test.ts
```

---

### Task 1: 纯函数层（`ledger.ts`）

**Files:**
- Create: `api/src/modules/billing/ledger.ts`
- Create: `api/src/modules/billing/ledger.spec.ts`

⚠️ **这个文件不碰数据库、不读上下文** —— 与 `settlement.ts`（结算单的纯函数）同款理由：
**计钱的每一条分支都要能被完整断言**。

- [ ] **Step 1: 写失败的单测**

`api/src/modules/billing/ledger.spec.ts`：

```ts
import { PayoutStatus, ReceiptType, SettlementStatus } from '@prisma/client';
import {
  deriveApplicableKind,
  groupReceiptsByPeriod,
  splitPayoutAmounts,
  toReportAmounts,
} from './ledger';

describe('账目纯函数（阶段 5i）', () => {
  describe('toReportAmounts：流水口径 → 报表口径', () => {
    it('抽佣 1500、冲回 -300 → 报表口径是抽佣 1500、冲回 300', () => {
      expect(toReportAmounts(1500, -300)).toEqual({
        commissionRevenue: 1500,
        reversal: 300,
      });
    });

    it('⚠️ 冲回之和为正 → 抛错（符号写反时立刻炸）', () => {
      expect(() => toReportAmounts(1500, 300)).toThrow(/符号/);
    });

    it('⚠️ 抽佣之和为负 → 抛错', () => {
      expect(() => toReportAmounts(-1500, -300)).toThrow(/符号/);
    });

    it('空区间 → 两个数都是 0', () => {
      expect(toReportAmounts(0, 0)).toEqual({
        commissionRevenue: 0,
        reversal: 0,
      });
    });
  });

  describe('groupReceiptsByPeriod：货款流水按期分组', () => {
    it('同一月的两笔加总，跨月分开', () => {
      const grouped = groupReceiptsByPeriod([
        {
          amount: 10000,
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
        },
        {
          amount: 5000,
          occurredAt: new Date('2026-08-20T00:00:00.000Z'),
        },
        {
          amount: -3000,
          occurredAt: new Date('2026-09-01T00:00:00.000Z'),
        },
      ]);
      expect(grouped.get('2026-08')).toEqual({ amount: 15000, count: 2 });
      expect(grouped.get('2026-09')).toEqual({ amount: -3000, count: 1 });
    });

    it('空数组 → 空 Map', () => {
      expect(groupReceiptsByPeriod([]).size).toBe(0);
    });
  });

  describe('splitPayoutAmounts：出款单按状态分桶', () => {
    const payout = (
      status: PayoutStatus,
      netAmount: number,
      kind: 'NORMAL' | 'SUPPLEMENT' = 'NORMAL',
    ) => ({ status, netAmount, kind });

    it('PAID 算已出款；REQUESTED/APPROVED/PROCESSING 算在途', () => {
      expect(
        splitPayoutAmounts([
          payout(PayoutStatus.PAID, 8500),
          payout(PayoutStatus.REQUESTED, 5000),
          payout(PayoutStatus.APPROVED, 1000),
          payout(PayoutStatus.PROCESSING, 2000),
        ]),
      ).toEqual({ paid: 8500, inFlight: 8000 });
    });

    it('REJECTED / CANCELLED / FAILED 都不算（没打钱）', () => {
      expect(
        splitPayoutAmounts([
          payout(PayoutStatus.REJECTED, 8500),
          payout(PayoutStatus.CANCELLED, 8500),
          payout(PayoutStatus.FAILED, 8500),
        ]),
      ).toEqual({ paid: 0, inFlight: 0 });
    });

    it('补差单的 PAID 也算已出款', () => {
      expect(
        splitPayoutAmounts([payout(PayoutStatus.PAID, 5000, 'SUPPLEMENT')]),
      ).toEqual({ paid: 5000, inFlight: 0 });
    });

    it('空数组 → 两个数都是 0', () => {
      expect(splitPayoutAmounts([])).toEqual({ paid: 0, inFlight: 0 });
    });
  });

  describe('deriveApplicableKind：能不能申请出款', () => {
    const base = {
      periodEnded: true,
      receiptAmount: 10000,
      receiptCount: 1,
      commissionAmount: 1500,
      statementStatus: SettlementStatus.CONFIRMED,
      hasActiveNormal: false,
      hasActiveSupplement: false,
      normalPaid: false,
      supplementAmount: null as number | null,
    };

    it('结算单已确认 + 无活跃单 → 可申请正常单', () => {
      expect(deriveApplicableKind(base).kind).toBe('NORMAL');
    });

    it('⚠️ 结算单未确认 → 不可申请，理由说清是结算单没确认', () => {
      const result = deriveApplicableKind({
        ...base,
        statementStatus: SettlementStatus.DRAFT,
      });
      expect(result.kind).toBeNull();
      expect(result.reason).toMatch(/结算单/);
    });

    it('⚠️ 周期未结束 → 不可申请', () => {
      const result = deriveApplicableKind({ ...base, periodEnded: false });
      expect(result.kind).toBeNull();
      expect(result.reason).toMatch(/尚未结束/);
    });

    it('⚠️ 有活跃正常单 → 不可申请（幂等：apply 会返回那张单）', () => {
      const result = deriveApplicableKind({ ...base, hasActiveNormal: true });
      expect(result.kind).toBeNull();
      expect(result.reason).toMatch(/已有/);
    });

    it('正常单已 PAID + 有未纳入货款 + 无活跃补差单 → 可申请补差单', () => {
      const result = deriveApplicableKind({
        ...base,
        hasActiveNormal: true,
        normalPaid: true,
        supplementAmount: 5000,
      });
      expect(result.kind).toBe('SUPPLEMENT');
    });

    it('⚠️ 正常单已 PAID 但没有未纳入货款 → 不可申请', () => {
      const result = deriveApplicableKind({
        ...base,
        hasActiveNormal: true,
        normalPaid: true,
        supplementAmount: 0,
      });
      expect(result.kind).toBeNull();
    });

    it('⚠️ 有活跃补差单 → 不可申请（补差单不允许再叠）', () => {
      const result = deriveApplicableKind({
        ...base,
        hasActiveNormal: true,
        normalPaid: true,
        hasActiveSupplement: true,
        supplementAmount: 5000,
      });
      expect(result.kind).toBeNull();
    });

    it('⚠️ 佣金未知（没有结算单）→ 不可申请', () => {
      const result = deriveApplicableKind({
        ...base,
        commissionAmount: null,
        statementStatus: null,
      });
      expect(result.kind).toBeNull();
    });
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

```bash
cd api && npx jest src/modules/billing/ledger.spec.ts
```

Expected: **FAIL** —— `Cannot find module './ledger'`。

- [ ] **Step 3: 写实现**

`api/src/modules/billing/ledger.ts`：

```ts
import { PayoutStatus, SettlementStatus } from '@prisma/client';
import { formatPeriodLabel } from './settlement';

/**
 * 账目口径的纯函数（阶段 5i）。
 *
 * ⚠️ **本文件是纯函数**：不碰数据库、不读上下文。
 *    与 `settlement.ts`（结算单的纯函数）同款理由 ——
 *    **计钱的每一条分支都要能被完整断言**。
 *
 * ⚠️ **全程整数域**：金额一律整数分。
 */

/** 报表口径的抽佣收入与冲回 */
export interface ReportLedgerAmounts {
  /** 抽佣收入（毛额，正数） */
  commissionRevenue: number;
  /**
   * 退款冲回（**正数**）。
   *
   * ⚠️ **与流水口径的符号相反** —— 流水表的 `REVERSAL.amount` 恒 ≤ 0，
   *    报表口径的 `reversal` 恒 ≥ 0（`netRevenue = … + 抽佣 − 冲回`）。
   *    这处换算写反 → 净收入翻倍（阶段 5g 的坑 2）。
   */
  reversal: number;
}

/**
 * 把流水口径的抽佣与冲回，换算成报表口径。
 *
 * ⚠️ **符号不变体在这里炸出来**：流水表的冲回恒 ≤ 0，
 *    传进来一个正数说明写反了（或是枚举扩容后混进了别的类型）→
 *    立刻抛错，而不是算出一张错账。
 */
export function toReportAmounts(
  commissionSum: number,
  reversalSum: number,
): ReportLedgerAmounts {
  if (commissionSum < 0) {
    throw new Error(`流水符号异常：抽佣之和 ${commissionSum} 应当 ≥ 0`);
  }
  if (reversalSum > 0) {
    throw new Error(`流水符号异常：冲回之和 ${reversalSum} 应当 ≤ 0`);
  }
  return {
    commissionRevenue: commissionSum,
    reversal: -reversalSum,
  };
}

/** 一笔货款流水（只需要金额与归期） */
export interface ReceiptLike {
  /** 带符号整数分：货款入账为正、货款冲回为负 */
  amount: number;
  /** 归期（支付取 `paidAt`、退款取 `refundedAt`） */
  occurredAt: Date;
}

/** 一期的货款聚合 */
export interface ReceiptPeriodSum {
  /** 货款净额（整数分，带符号） */
  amount: number;
  /** 流水笔数 */
  count: number;
}

/**
 * 把货款流水按自然月分组。
 *
 * ⚠️ **用 `formatPeriodLabel` 分组**（UTC）—— 整个系统的时间都是 UTC，
 *    用本地时区会差 8 小时，跨月的那几笔会归错期。
 *
 * ⚠️ **带符号求和**：货款冲回是负数 → 同一期的净额可能是负的
 *    （这一期只有退款、没有新的货款）。
 */
export function groupReceiptsByPeriod(
  receipts: ReceiptLike[],
): Map<string, ReceiptPeriodSum> {
  const grouped = new Map<string, ReceiptPeriodSum>();
  for (const receipt of receipts) {
    const label = formatPeriodLabel(receipt.occurredAt);
    const current = grouped.get(label) ?? { amount: 0, count: 0 };
    grouped.set(label, {
      amount: current.amount + receipt.amount,
      count: current.count + 1,
    });
  }
  return grouped;
}

/** 一张出款单（只需要状态、金额与种类） */
export interface PayoutLike {
  status: PayoutStatus;
  /** 审批那一刻锁定的金额（整数分） */
  netAmount: number;
  kind: 'NORMAL' | 'SUPPLEMENT';
}

/** 出款单的金额分桶 */
export interface PayoutAmountBuckets {
  /** 已出款（`PAID`）的金额之和 */
  paid: number;
  /** 在途（`REQUESTED` / `APPROVED` / `PROCESSING`）的金额之和 */
  inFlight: number;
}

/**
 * 把出款单按「打没打出去」分桶。
 *
 * ⚠️ **`REJECTED` / `CANCELLED` / `FAILED` 都不算** —— 都没打钱：
 *    - `REJECTED` / `CANCELLED`：平台没批 / 商家撤了；
 *    - `FAILED`：打款失败，且明细已释放（5h-2 的 `markFailed` 会 `deleteMany`）
 *      → 商家可以重新申请 → 那笔钱仍属于「待出款」。
 *
 * ⚠️ **在途必须单列**：钱还没打出去，商家点进详情会看到有一张单在飞。
 *    把它并进「待出款」会让商家困惑（「待出款 ¥50」但已经有一张单在处理）。
 */
export function splitPayoutAmounts(payouts: PayoutLike[]): PayoutAmountBuckets {
  let paid = 0;
  let inFlight = 0;
  for (const payout of payouts) {
    if (payout.status === PayoutStatus.PAID) {
      paid += payout.netAmount;
    } else if (
      payout.status === PayoutStatus.REQUESTED ||
      payout.status === PayoutStatus.APPROVED ||
      payout.status === PayoutStatus.PROCESSING
    ) {
      inFlight += payout.netAmount;
    }
  }
  return { paid, inFlight };
}

/** 可申请判定的输入 */
export interface ApplicableInput {
  /** 周期是否已结束 */
  periodEnded: boolean;
  /** 货款净额 */
  receiptAmount: number;
  /** 货款流水笔数 */
  receiptCount: number;
  /** 佣金净额（**带符号**）；null = 该期没有已确认的结算单 */
  commissionAmount: number | null;
  /** 结算单状态；null = 没有结算单 */
  statementStatus: SettlementStatus | null;
  /** 有没有活跃的正常单（活跃 = notIn(REJECTED, CANCELLED, FAILED)，**含 PAID**） */
  hasActiveNormal: boolean;
  /** 有没有活跃的补差单 */
  hasActiveSupplement: boolean;
  /** 正常单是否已 PAID */
  normalPaid: boolean;
  /** 未纳入的货款额（补差金额）；null = 还没算 */
  supplementAmount: number | null;
}

/** 可申请判定的结果 */
export interface ApplicableResult {
  /** 可以申请哪种出款；null = 现在不能申请 */
  kind: 'NORMAL' | 'SUPPLEMENT' | null;
  /** 不能申请时的原因（给商家看的中文）；null = 能申请 */
  reason: string | null;
}

/**
 * 判定「商家现在点申请出款，会新建成一张单吗」。
 *
 * ⚠️ **判定的权威是 `apply` 的闸门，不是列表页的筛选条件** ——
 *    出款页的 `availablePeriods()` 只在「无活跃单时」按金额过滤，
 *    **结算单状态完全不参与列表筛选**（它在 `apply` 的 `assertStatementConfirmed`
 *    里拦）。照列表页写会与出款页给出不同结论。
 *
 * ⚠️ **「活跃」含 `PAID`** —— 正常单已出款仍占着索引位，
 *    正常单 PAID 之后 NORMAL 路径**不可达**（`apply` 会走到补差判定）。
 */
export function deriveApplicableKind(
  input: ApplicableInput,
): ApplicableResult {
  if (!input.periodEnded) {
    return { kind: null, reason: '该周期尚未结束' };
  }
  if (input.receiptCount === 0 || input.receiptAmount <= 0) {
    return { kind: null, reason: '该期没有货款入账' };
  }
  if (input.commissionAmount === null || input.statementStatus === null) {
    return { kind: null, reason: '该期的结算单尚未生成' };
  }
  if (
    input.statementStatus !== SettlementStatus.CONFIRMED &&
    input.statementStatus !== SettlementStatus.PAID
  ) {
    return { kind: null, reason: '该期的结算单尚未确认' };
  }

  // ---- 补差路径优先判断 ----
  // ⚠️ 补差要求「正常单已 PAID」—— 正常单还在飞时，
  //    `apply` 的幂等分支会直接返回那张正常单，压根走不到补差判定。
  if (input.normalPaid) {
    if (input.hasActiveSupplement) {
      return { kind: null, reason: '该期已有补差出款单在处理中' };
    }
    if (!input.supplementAmount || input.supplementAmount <= 0) {
      return { kind: null, reason: '该期货款已全部结清' };
    }
    return { kind: 'SUPPLEMENT', reason: null };
  }

  // ---- 正常路径 ----
  if (input.hasActiveNormal) {
    return { kind: null, reason: '该期已有出款申请在处理中' };
  }
  if (input.statementStatus === SettlementStatus.PAID) {
    // ⚠️ 结算单已 PAID 说明正常单已打款 → 正常路径的 `assertStatementConfirmed`
    //    会拒（NORMAL 不开 `allowPaid`）→ 只有补差路径可达。
    return { kind: null, reason: '该期已结算完成' };
  }
  return { kind: 'NORMAL', reason: null };
}
```

- [ ] **Step 4: 跑测试确认它过了**

```bash
cd api && npx jest src/modules/billing/ledger.spec.ts
```

Expected: **PASS**（16 个用例全过）。

- [ ] **Step 5: 跑 lint**

```bash
cd api && npm run lint
```

Expected: 无输出（无告警）。

- [ ] **Step 6: 提交**

```bash
git add api/src/modules/billing/ledger.ts api/src/modules/billing/ledger.spec.ts
git commit -m "feat(billing): 账目口径的纯函数——符号换算、按期分组、出款分桶与可申请判定"
```

---

### Task 2: 回填自检脚本 `check:ledger`（护栏 **S6**）

**Files:**
- Create: `api/scripts/check-ledger.ts`
- Modify: `api/package.json`（加 `check:ledger` 脚本）
- Create: `api/test/check-ledger.spec.ts`（脚本级测试）

⚠️ **这个脚本只读** —— 不写任何数据。它的作用是**在切报表口径之前**回答
「流水补齐了吗」，避免切完才发现历史收入显示 0。

⚠️ **缺口判定的坑（设计审查时抓出来的）**：回填在 `commissionAmount === 0` 时
**提前 return** → 零佣金订单**根本不会被要求有抽佣行** →
判定时**必须排除零额订单**，否则所有零佣金商家都被报成缺口 → 脚本永远 exit 1。

- [ ] **Step 1: 写脚本级测试**

`api/test/check-ledger.spec.ts`：

```ts
import { OrderStatus } from '@prisma/client';
import { checkLedger, LedgerCheckResult } from '../scripts/check-ledger';

/**
 * 自检脚本的判定规则测试。
 *
 * ⚠️ **不连数据库**：判定规则是纯函数式的（给一批订单 + 已有流水 → 报缺口），
 *    把它拆成可单测的纯函数，脚本本身只负责取数与打印。
 */
describe('账目流水自检（阶段 5i）—— 护栏 S6', () => {
  const order = (options: {
    id: string;
    paidAt: Date | null;
    refundedAt?: Date | null;
    commissionAmount: number;
    totalAmount: number;
  }) => ({
    id: options.id,
    orderNo: options.id,
    paidAt: options.paidAt,
    refundedAt: options.refundedAt ?? null,
    status: options.refundedAt ? OrderStatus.REFUNDED : OrderStatus.PAID,
    commissionAmount: options.commissionAmount,
    totalAmount: options.totalAmount,
  });

  it('S6：⚠️ 零佣金订单不算缺口（回填在零额时提前 return）', () => {
    const result: LedgerCheckResult = checkLedger({
      orders: [order({ id: 'o1', paidAt: new Date(), commissionAmount: 0, totalAmount: 10000 })],
      commissionEntryOrderIds: [],
      reversalEntryOrderIds: [],
      receiptOrderIds: [],
      reversalReceiptOrderIds: [],
    });
    expect(result.commissionMissing).toEqual([]);
    expect(result.reversalMissing).toEqual([]);
    expect(result.receiptMissing).toEqual([]);
    expect(result.hasGap).toBe(false);
  });

  it('S6：非零佣金的已支付订单缺抽佣流水 → 报缺口', () => {
    const result = checkLedger({
      orders: [order({ id: 'o1', paidAt: new Date(), commissionAmount: 500, totalAmount: 10000 })],
      commissionEntryOrderIds: [],
      reversalEntryOrderIds: [],
      receiptOrderIds: [],
      reversalReceiptOrderIds: [],
    });
    expect(result.commissionMissing).toEqual(['o1']);
    expect(result.hasGap).toBe(true);
  });

  it('有抽佣流水 → 不报缺口', () => {
    const result = checkLedger({
      orders: [order({ id: 'o1', paidAt: new Date(), commissionAmount: 500, totalAmount: 10000 })],
      commissionEntryOrderIds: ['o1'],
      reversalEntryOrderIds: [],
      receiptOrderIds: ['o1'],
      reversalReceiptOrderIds: [],
    });
    expect(result.hasGap).toBe(false);
  });

  it('⚠️ 零佣金的已退款订单不算「缺冲回」', () => {
    const result = checkLedger({
      orders: [
        order({
          id: 'o1',
          paidAt: new Date('2026-01-10'),
          refundedAt: new Date('2026-01-20'),
          commissionAmount: 0,
          totalAmount: 10000,
        }),
      ],
      commissionEntryOrderIds: [],
      reversalEntryOrderIds: [],
      receiptOrderIds: ['o1'],
      reversalReceiptOrderIds: [],
    });
    expect(result.reversalMissing).toEqual([]);
    expect(result.hasGap).toBe(false);
  });

  it('⚠️ 已退款但无退款时间 → 归到「无归期退款」，**不算缺口**', () => {
    const result = checkLedger({
      orders: [
        order({
          id: 'o1',
          paidAt: new Date('2026-01-10'),
          refundedAt: null,
          commissionAmount: 500,
          totalAmount: 10000,
        }),
      ],
      commissionEntryOrderIds: ['o1'],
      reversalEntryOrderIds: [],
      receiptOrderIds: ['o1'],
      reversalReceiptOrderIds: [],
    });
    expect(result.undatedRefundCount).toBe(1);
    expect(result.hasGap).toBe(false);
  });

  it('缺货款流水 → 报缺口', () => {
    const result = checkLedger({
      orders: [order({ id: 'o1', paidAt: new Date(), commissionAmount: 500, totalAmount: 10000 })],
      commissionEntryOrderIds: ['o1'],
      reversalEntryOrderIds: [],
      receiptOrderIds: [],
      reversalReceiptOrderIds: [],
    });
    expect(result.receiptMissing).toEqual(['o1']);
    expect(result.hasGap).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

```bash
cd api && npx jest test/check-ledger.spec.ts
```

Expected: **FAIL** —— `Cannot find module '../scripts/check-ledger'`。

- [ ] **Step 3: 写脚本**

`api/scripts/check-ledger.ts`：

```ts
/**
 * 账目流水自检（阶段 5i）。
 *
 * ## 它回答什么问题
 *
 * 「历史订单的流水补齐了吗？」—— 报表切到流水表口径**之后**，
 * 没补齐的历史订单会让**历史收入显示 0**（阶段 5i 的设计 §4.3）。
 * 这个脚本就是那道防线：**切之前先跑一次，有缺口就别切**。
 *
 * ## 它只读
 *
 * ⚠️ **绝不写任何数据** —— 它是检查工具，不是修复工具。
 *    修复是 `npm run backfill:ledger` 的事（那个幂等，可重复跑）。
 *
 * ## 退出码
 *
 * - `0`：流水完整（或只有「无归期退款」这种历史数据缺陷）
 * - `1`：有缺口 —— **不要切报表口径**
 *
 * 用法（在 `api/` 目录下）：
 * ```
 * npm run check:ledger
 * ```
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { NestFactory } from '@nestjs/core';
import { OrderStatus } from '@prisma/client';

import { AppModule } from '../src/app.module';
import { TenantPrismaService } from '../src/common/tenant/tenant-prisma.service';
import {
  platformScope,
  tenantContext,
} from '../src/common/tenant/tenant-context';

/** 自检的输入（订单 + 已有流水的订单 id 集合） */
export interface LedgerCheckInput {
  /** 已支付（含已退款）的订单 */
  orders: Array<{
    id: string;
    orderNo: string;
    paidAt: Date | null;
    refundedAt: Date | null;
    status: OrderStatus;
    commissionAmount: number;
    totalAmount: number;
  }>;
  /** 已有 `COMMISSION` 流水的订单 id */
  commissionEntryOrderIds: string[];
  /** 已有 `REVERSAL` 流水的订单 id */
  reversalEntryOrderIds: string[];
  /** 已有 `SALE` 货款流水的订单 id */
  receiptOrderIds: string[];
  /** 已有 `SALE_REVERSAL` 货款流水的订单 id */
  reversalReceiptOrderIds: string[];
}

/** 自检的结果 */
export interface LedgerCheckResult {
  /** 缺抽佣流水的订单号 */
  commissionMissing: string[];
  /** 缺冲回流水的订单号 */
  reversalMissing: string[];
  /** 缺货款流水的订单号 */
  receiptMissing: string[];
  /** 已退款但没有退款时间的订单数（**不是缺口**，是永远无法归期） */
  undatedRefundCount: number;
  /** 有没有缺口 */
  hasGap: boolean;
}

/**
 * 判定缺口（纯函数，可单测）。
 *
 * ⚠️ **零额订单必须排除** —— 回填的 `shouldBackfillCommission` 与
 *    `shouldBackfillReversal` 都在 `commissionAmount === 0` 时**提前 return**
 *    → 零佣金订单**根本不会被要求有流水行**。
 *    ⚠️ 漏掉这条 → 所有零佣金商家都被报成缺口 → **脚本永远 exit 1**。
 *
 * ⚠️ **货款额为 0 的订单同理**（`totalAmount === 0` 不写 `SALE` 行）。
 *
 * ⚠️ **「已支付」的判据是 `paidAt IS NOT NULL`** —— 与两个 `backfill()` 的口径
 *    逐字一致。⚠️ **不能按 `status = PAID` 统计**：`SHIPPED` 的订单也付过钱，
 *    按 status 统计会与回填的口径不一致 → 报出假缺口。
 */
export function checkLedger(input: LedgerCheckInput): LedgerCheckResult {
  const commissionIds = new Set(input.commissionEntryOrderIds);
  const reversalIds = new Set(input.reversalEntryOrderIds);
  const receiptIds = new Set(input.receiptOrderIds);
  const reversalReceiptIds = new Set(input.reversalReceiptOrderIds);

  const commissionMissing: string[] = [];
  const reversalMissing: string[] = [];
  const receiptMissing: string[] = [];
  let undatedRefundCount = 0;

  for (const order of input.orders) {
    // ⚠️ **没付过钱的订单没有货款，也没有抽佣** —— 直接跳过。
    if (!order.paidAt) continue;

    // ---- 货款流水 ----
    if (order.totalAmount !== 0 && !receiptIds.has(order.id)) {
      receiptMissing.push(order.orderNo);
    }

    // ---- 抽佣流水 ----
    if (order.commissionAmount !== 0 && !commissionIds.has(order.id)) {
      commissionMissing.push(order.orderNo);
    }

    // ---- 冲回流水 ----
    const refunded = order.status === OrderStatus.REFUNDED;
    if (!refunded) continue;
    if (!order.refundedAt) {
      // ⚠️ **不是缺口** —— 冲回永远无法归期（阶段 5f 的 L20），单独报数。
      undatedRefundCount += 1;
      continue;
    }
    if (order.commissionAmount !== 0 && !reversalIds.has(order.id)) {
      reversalMissing.push(order.orderNo);
    }
  }

  return {
    commissionMissing,
    reversalMissing,
    receiptMissing,
    undatedRefundCount,
    hasGap:
      commissionMissing.length > 0 ||
      reversalMissing.length > 0 ||
      receiptMissing.length > 0,
  };
}

/** 加载 `.env`（照抄回填脚本的做法） */
function loadEnv(): void {
  const envPath = resolve(__dirname, '..', '.env');
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}

async function main(): Promise<void> {
  loadEnv();

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const prisma = app.get(TenantPrismaService);

    const result = await tenantContext.run(platformScope(), async () => {
      // ⚠️ **平台作用域**：账是平台看所有商家的账，
      //    不显式声明的话会只统计一个租户的数据（报告看起来正常、数字全错）。
      const orders = await prisma.order.findMany({
        where: { paidAt: { not: null } },
        select: {
          id: true,
          orderNo: true,
          paidAt: true,
          refundedAt: true,
          status: true,
          commissionAmount: true,
          totalAmount: true,
        },
      });

      const commissionEntries = await prisma.commissionEntry.findMany({
        select: { orderId: true, type: true },
      });
      const receipts = await prisma.merchantReceipt.findMany({
        select: { orderId: true, type: true },
      });

      return checkLedger({
        orders: orders.map((o) => ({
          id: o.id,
          orderNo: o.orderNo,
          paidAt: o.paidAt,
          refundedAt: o.refundedAt,
          status: o.status,
          commissionAmount: o.commissionAmount,
          totalAmount: o.totalAmount,
        })),
        commissionEntryOrderIds: commissionEntries
          .filter((e) => e.type === 'COMMISSION')
          .map((e) => e.orderId),
        reversalEntryOrderIds: commissionEntries
          .filter((e) => e.type === 'REVERSAL')
          .map((e) => e.orderId),
        receiptOrderIds: receipts
          .filter((r) => r.type === 'SALE')
          .map((r) => r.orderId),
        reversalReceiptOrderIds: receipts
          .filter((r) => r.type === 'SALE_REVERSAL')
          .map((r) => r.orderId),
      });
    });

    console.log('账目流水自检');
    console.log('──────────────────────────────');
    console.log(`缺抽佣流水：${result.commissionMissing.length} 单`);
    console.log(`缺冲回流水：${result.reversalMissing.length} 单`);
    console.log(`缺货款流水：${result.receiptMissing.length} 单`);
    console.log(
      `已退款但无退款时间（冲回永远无法归期）：${result.undatedRefundCount} 单`,
    );
    if (result.commissionMissing.length > 0) {
      console.log(`  缺抽佣的订单：${result.commissionMissing.slice(0, 20).join('、')}`);
    }
    if (result.reversalMissing.length > 0) {
      console.log(`  缺冲回的订单：${result.reversalMissing.slice(0, 20).join('、')}`);
    }
    if (result.receiptMissing.length > 0) {
      console.log(`  缺货款的订单：${result.receiptMissing.slice(0, 20).join('、')}`);
    }
    console.log('──────────────────────────────');
    console.log(
      result.hasGap
        ? '结论：❌ 流水不完整 —— 先跑 `npm run backfill:ledger`，不要切报表口径'
        : '结论：✅ 流水完整',
    );

    // ⚠️ **退出码**：有缺口 → 1。CI 与部署脚本靠它判断「能不能切口径」。
    process.exitCode = result.hasGap ? 1 : 0;
  } finally {
    // ⚠️ **必须显式关闭应用**（照回填脚本）：连接池会吊住进程。
    await app.close();
  }

  process.exit(process.exitCode ?? 0);
}

void main();
```

- [ ] **Step 4: 跑测试确认它过了**

```bash
cd api && npx jest test/check-ledger.spec.ts
```

Expected: **PASS**（6 个用例全过）。

- [ ] **Step 5: 加 npm 脚本**

`api/package.json` 的 `scripts` 段（在 `backfill:ledger` 附近）加一行：

```json
"check:ledger": "ts-node --compiler-options '{\"module\":\"CommonJS\"}' scripts/check-ledger.ts",
```

⚠️ **必须用 `ts-node` 而不是编译产物** —— 这个脚本跟回填脚本同款，
跑的是源码，改完立刻能用。

- [ ] **Step 6: 跑脚本确认它能用**

```bash
cd api && npm run check:ledger; echo "退出码: $?"
```

Expected: 打印自检结果。⚠️ **本机开发库当前有 1 笔零佣金订单 → 不该报缺口**；
若报了缺口，去开发库看一眼是真缺还是判定写错了。

- [ ] **Step 7: 提交**

```bash
git add api/scripts/check-ledger.ts api/test/check-ledger.spec.ts api/package.json
git commit -m "feat(billing): 账目流水自检脚本——切报表口径前的检查手段"
```

---

### Task 3: 报表切到流水表（护栏 **S5**）

**Files:**
- Modify: `api/src/modules/billing/report.service.ts`（`summary()` 的两处聚合）
- Modify: `api/src/modules/billing/report.service.spec.ts`（新增用例）
- Create: `api/test/ledger-reconciliation.e2e-spec.ts`（本阶段的 e2e，本 Task 只加报表那几条）

⚠️ **这是本阶段唯一有「切了就没法悄悄回退」风险的改动** —— 代码能改回去，
但切换那段时间的报表数字是错的（收入显示 0）。
→ **Task 2 的自检脚本必须先落地**（它就是那道防线）。

⚠️ **「有流水数据时两套口径逐分相等」是这个改动的安全前提** ——
必须有 e2e 证明它（S5），否则就是「绿了但什么都没验」。

- [ ] **Step 1: 写失败的 e2e**

⚠️ **必须造有佣金的订单** —— 零佣金订单在两套口径下结果一样（都是 0），
用它测等于没测。种子里有 `commissionBps: 500`（5%）的 trial 套餐 → 让商家订阅它。

`api/test/ledger-reconciliation.e2e-spec.ts`（本 Task 先写这三个用例，后续 Task 往里加）：

```ts
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { OrderStatus, PlanCode } from '@prisma/client';
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
 * 账目口径收口（阶段 5i）的 e2e。
 *
 * ⚠️ **月份只用 2025-08 ~ 2026-09** —— 结算单 e2e 对 2024-10 / 2024-12
 *   有「这一期**全库**恰好几张单 / 没有任何流水」的断言，
 *   往那些月份造流水会带偏它。
 *
 * ⚠️ **每个用例用自己独立的商家 + 独立的月份** —— 出款单的幂等键是
 *   `(tenantId, periodStart, kind)`，同商家同月反复造数据会让用例互相污染。
 */
describe('账目口径收口 (e2e) —— 护栏 S5', () => {
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

  /** 在平台作用域里执行一段逻辑 */
  function asPlatform<T>(fn: () => Promise<T>): Promise<T> {
    return tenantContext.run(platformScope(), async () => fn());
  }

  /** 平台超管登录 */
  async function loginPlatformAdmin(): Promise<string> {
    const response = await http(app)
      .post('/api/v1/auth/login')
      .send({
        email: process.env.SEED_PLATFORM_ADMIN_EMAIL ?? 'admin@platform.test',
        password: process.env.SEED_PLATFORM_ADMIN_PASSWORD ?? 'Admin12345!',
        scope: 'PLATFORM',
      })
      .expect(200);
    return (response.body as { accessToken: string }).accessToken;
  }

  /**
   * 造一个**有佣金**的商家 + 一笔已支付的订单。
   *
   * ⚠️ **必须有佣金** —— 零佣金订单在「报表读 orders」与「报表读流水表」
   *    两种口径下结果完全一样（都是 0）→ 用它验 S5 等于没验。
   *    做法：给商家订一个 `commissionBps > 0` 的套餐（种子里的 trial 是 500 = 5%）。
   */
  async function setupPaidOrderWithCommission(options: {
    period: { from: Date; to: Date };
    totalAmount: number;
    commissionAmount: number;
  }): Promise<{ tenantId: string; orderNo: string }> {
    const merchant = await createMerchant(app, prisma);

    // ⚠️ **让商家订阅带费率的套餐** —— 否则订单的 `commissionAmount` 是 0。
    await asPlatform(() =>
      prisma.subscription.create({
        data: {
          tenantId: merchant.tenantId,
          planId: await trialPlanId(),
          status: 'ACTIVE',
          startedAt: new Date('2026-01-01T00:00:00.000Z'),
          currentPeriodStart: new Date('2026-01-01T00:00:00.000Z'),
          currentPeriodEnd: new Date('2027-01-01T00:00:00.000Z'),
          commissionBps: 500,
        },
      }),
    );

    const orderNo = `LEDGER-${unique()}`;
    await asPlatform(() =>
      prisma.order.create({
        data: {
          tenantId: merchant.tenantId,
          orderNo,
          status: OrderStatus.PAID,
          totalAmount: options.totalAmount,
          itemCount: 1,
          receiverName: '测试收货人',
          receiverPhone: '13800000000',
          province: '广东省',
          city: '深圳市',
          district: '南山区',
          detail: '测试地址',
          commissionRate: 500,
          commissionAmount: options.commissionAmount,
          paidAt: new Date(
            options.period.from.getTime() + 10 * 24 * 3600 * 1000,
          ),
        },
      }),
    );

    return { tenantId: merchant.tenantId, orderNo };
  }

  /** 种子里的 trial 套餐 id */
  async function trialPlanId(): Promise<string> {
    const plan = await asPlatform(() =>
      prisma.plan.findFirst({ where: { code: PlanCode.TRIAL } }),
    );
    if (!plan) {
      throw new Error('种子数据里没有 trial 套餐');
    }
    return plan.id;
  }

  it('S5：报表切到流水表后，抽佣收入与冲回逐分相等', async () => {
    const token = await loginPlatformAdmin();
    const period = {
      from: new Date('2025-08-01T00:00:00.000Z'),
      to: new Date('2025-09-01T00:00:00.000Z'),
    };

    // ⚠️ **先手工写一行抽佣流水**（模拟「回填已经跑过」）。
    //    真实链路是支付时写流水（`CommissionService`），这里直接插库更可控。
    const { tenantId, orderNo } = await setupPaidOrderWithCommission({
      period,
      totalAmount: 10000,
      commissionAmount: 500,
    });
    const order = await asPlatform(() =>
      prisma.order.findFirst({ where: { orderNo } }),
    );
    await asPlatform(() =>
      prisma.commissionEntry.create({
        data: {
          tenantId,
          orderId: order!.id,
          orderNo,
          type: 'COMMISSION',
          amount: 500,
          rateBps: 500,
          baseAmount: 10000,
          occurredAt: new Date(
            period.from.getTime() + 10 * 24 * 3600 * 1000,
          ),
        },
      }),
    );

    const response = await http(app)
      .get(
        `/api/v1/platform/reports/summary?from=${period.from.toISOString()}&to=${period.to.toISOString()}`,
      )
      .set('authorization', `Bearer ${token}`)
      .expect(200);

    const body = response.body as {
      commissionRevenue: number;
      reversal: number;
      netRevenue: number;
    };
    // ⚠️ **与订单上的抽佣快照逐分相等** —— 这就是「切前切后一致」的证据。
    expect(body.commissionRevenue).toBe(500);
    expect(body.reversal).toBe(0);
  });

  it('S5：冲回的口径是「正数要减」—— 流水里的负号被取反', async () => {
    const token = await loginPlatformAdmin();
    const period = {
      from: new Date('2025-09-01T00:00:00.000Z'),
      to: new Date('2025-10-01T00:00:00.000Z'),
    };

    const { tenantId, orderNo } = await setupPaidOrderWithCommission({
      period,
      totalAmount: 10000,
      commissionAmount: 500,
    });
    const order = await asPlatform(() =>
      prisma.order.findFirst({ where: { orderNo } }),
    );
    const occurredAt = new Date(
      period.from.getTime() + 10 * 24 * 3600 * 1000,
    );
    await asPlatform(() =>
      prisma.commissionEntry.createMany({
        data: [
          {
            tenantId,
            orderId: order!.id,
            orderNo,
            type: 'COMMISSION',
            amount: 500,
            rateBps: 500,
            baseAmount: 10000,
            occurredAt,
          },
          {
            tenantId,
            orderId: order!.id,
            orderNo,
            type: 'REVERSAL',
            // ⚠️ **流水里的冲回是负数**
            amount: -500,
            rateBps: 500,
            baseAmount: 10000,
            occurredAt,
          },
        ],
      }),
    );

    const response = await http(app)
      .get(
        `/api/v1/platform/reports/summary?from=${period.from.toISOString()}&to=${period.to.toISOString()}`,
      )
      .set('authorization', `Bearer ${token}`)
      .expect(200);

    const body = response.body as {
      commissionRevenue: number;
      reversal: number;
    };
    // ⚠️ **冲回显示为正数**（报表口径要减）→ 取负
    expect(body.commissionRevenue).toBe(500);
    expect(body.reversal).toBe(500);
  });

  it('S5：报表的归期按流水的 occurredAt，不按订单的 paidAt', async () => {
    const token = await loginPlatformAdmin();
    const period = {
      from: new Date('2025-10-01T00:00:00.000Z'),
      to: new Date('2025-11-01T00:00:00.000Z'),
    };

    const { tenantId, orderNo } = await setupPaidOrderWithCommission({
      period,
      totalAmount: 10000,
      commissionAmount: 500,
    });
    const order = await asPlatform(() =>
      prisma.order.findFirst({ where: { orderNo } }),
    );
    // ⚠️ **流水的归期落在另一期**（模拟「3 月支付、4 月退款」那种跨期）
    await asPlatform(() =>
      prisma.commissionEntry.create({
        data: {
          tenantId,
          orderId: order!.id,
          orderNo,
          type: 'COMMISSION',
          amount: 500,
          rateBps: 500,
          baseAmount: 10000,
          occurredAt: new Date('2025-12-15T00:00:00.000Z'),
        },
      }),
    );

    const response = await http(app)
      .get(
        `/api/v1/platform/reports/summary?from=${period.from.toISOString()}&to=${period.to.toISOString()}`,
      )
      .set('authorization', `Bearer ${token}`)
      .expect(200);

    const body = response.body as { commissionRevenue: number };
    // ⚠️ **本期不该有这笔抽佣** —— 它的归期在 12 月
    expect(body.commissionRevenue).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

```bash
cd api && npm run test:e2e -- test/ledger-reconciliation.e2e-spec.ts
```

Expected: **FAIL** —— 第一个用例的 `commissionRevenue` 期望 500、实际 0
（报表现在读 `orders`…… ⚠️ **注意**：读 `orders` 时它**也会**是 500！

> ⚠️ **等一下** —— 读 `orders` 的口径是「区间内 `paidAt` 的订单的 `commissionAmount` 之和」，
> 而本用例的订单 `paidAt` 落在 2025-08 → **旧口径也会得到 500** → **这个用例不会挂**！
>
> ⚠️ **这是本 Task 最容易踩空的地方**：切前切后一致时，**同一个断言两边都过**。
> → **必须让两个口径产生不同的结果**，才能证明真的切了。
>
> **正确做法**：造一个「订单在 8 月支付、流水在 12 月归期」的数据 ——
> 旧口径（按 `orders.paidAt`）算它进 8 月，新口径（按流水 `occurredAt`）算它不进 8 月。
> 这正是第三个用例的形状 —— **它才是能区分两个口径的那条**。
> → **把第一个用例改成那个形状**（订单 `paidAt` 在 8 月、流水 `occurredAt` 在 12 月，
>    断言本期 `commissionRevenue = 0`），第二个用例（冲回符号）保持不变。

**修正后的第一个用例**（替换上面那个）：

```ts
  it('S5：报表切到流水表后按流水的归期算（订单支付期与流水归期不同时会不同）', async () => {
    const token = await loginPlatformAdmin();
    const period = {
      from: new Date('2025-08-01T00:00:00.000Z'),
      to: new Date('2025-09-01T00:00:00.000Z'),
    };

    const { tenantId, orderNo } = await setupPaidOrderWithCommission({
      period,
      totalAmount: 10000,
      commissionAmount: 500,
    });
    const order = await asPlatform(() =>
      prisma.order.findFirst({ where: { orderNo } }),
    );
    // ⚠️⚠️ **流水的归期落在 12 月，订单的支付期在 8 月** ——
    //    旧口径（读 orders，按 `paidAt`）会把它算进 8 月，
    //    新口径（读流水，按 `occurredAt`）**不会**。
    //    → 这个断言**只有真的切了口径才会过**。
    await asPlatform(() =>
      prisma.commissionEntry.create({
        data: {
          tenantId,
          orderId: order!.id,
          orderNo,
          type: 'COMMISSION',
          amount: 500,
          rateBps: 500,
          baseAmount: 10000,
          occurredAt: new Date('2025-12-15T00:00:00.000Z'),
        },
      }),
    );

    const response = await http(app)
      .get(
        `/api/v1/platform/reports/summary?from=${period.from.toISOString()}&to=${period.to.toISOString()}`,
      )
      .set('authorization', `Bearer ${token}`)
      .expect(200);

    const body = response.body as { commissionRevenue: number };
    expect(body.commissionRevenue).toBe(0);
  });
```

- [ ] **Step 3: 改报表**

`api/src/modules/billing/report.service.ts` 的 `summary()` 里，把两处
`this.prisma.order.aggregate` 换成 `this.prisma.commissionEntry.aggregate`：

```ts
      // ⚠️ **抽佣收入 = 区间内 `COMMISSION` 流水的金额之和**（阶段 5i）。
      //
      // ⚠️ **为什么不再读 `orders`** —— 报表与结算单/出款单必须共用
      //    **同一个事实源**（`commission_entries`）：
      //    - 流水是**逐笔的审计凭证**，能表达「一笔抽佣一行」；
      //    - `orders` 只能表达「按订单聚合」，表达不了新的流水类型
      //      （`CommissionEntryType` 将来扩容时报表会静默漏掉新类型）；
      //    - 两套口径迟早漂移。
      //
      // ⚠️ **归期用流水的 `occurredAt`** —— 它写入时取的就是 `order.paidAt`，
      //    与旧口径逐字同源（跨期退款的冲回同理取 `order.refundedAt`）。
      const commissionAggregate = await this.prisma.commissionEntry.aggregate({
        where: {
          type: CommissionEntryType.COMMISSION,
          occurredAt: { gte: from, lt: to },
        },
        _sum: { amount: true },
      });

      // ⚠️ **冲回 = −Σ `REVERSAL` 行** —— 流水的冲回**恒 ≤ 0**，
      //    而报表口径的 `reversal` **恒 ≥ 0**（`netRevenue = … + 抽佣 − 冲回`）。
      //    **符号写反 → 净收入翻倍**（阶段 5g 的坑 2）。
      const reversalAggregate = await this.prisma.commissionEntry.aggregate({
        where: {
          type: CommissionEntryType.REVERSAL,
          occurredAt: { gte: from, lt: to },
        },
        _sum: { amount: true },
      });
```

并把取数那两行改成：

```ts
      const subscriptionRevenue = subscriptionAggregate._sum.amount ?? 0;
      // ⚠️ **用 `toReportAmounts` 做符号换算**（纯函数，可单测）
      const reportAmounts = toReportAmounts(
        commissionAggregate._sum.amount ?? 0,
        reversalAggregate._sum.amount ?? 0,
      );
      const commissionRevenue = reportAmounts.commissionRevenue;
      const reversal = reportAmounts.reversal;
```

文件顶部加 import：

```ts
import { CommissionEntryType, InvoiceStatus } from '@prisma/client';
import { toReportAmounts } from './ledger';
```

⚠️ **`OrderStatus` 的 import 若因此不再使用要删掉**（eslint 会报
`no-unused-vars`）—— 检查一下 `OrderStatus` 在这个文件里还有没有别的用处。

- [ ] **Step 4: 跑测试确认它过了**

```bash
cd api && npm run test:e2e -- test/ledger-reconciliation.e2e-spec.ts
```

Expected: **PASS**（3 个用例全过）。

⚠️ **如果第一个用例仍然失败且 `commissionRevenue` 是 500** → 说明口径没切成功
（多半是 `where` 写错了或没换成 `commissionEntry`）。

- [ ] **Step 5: 跑全量 e2e 与单测**

```bash
cd api && npm run test:e2e 2>&1 | tail -5
cd api && npm test 2>&1 | tail -5
cd api && npm run lint
```

Expected: e2e 与单测全绿，lint 无输出。

⚠️ **报表的 e2e 可能有断言依赖旧口径** —— 若有挂的用例，逐条看是不是
「断言了按 orders 聚合的数字」。那些断言要改成按流水表的口径算
（口径变了，数字就该变 —— 这是**有意的**）。

- [ ] **Step 6: 提交**

```bash
git add api/src/modules/billing/report.service.ts api/test/ledger-reconciliation.e2e-spec.ts
git commit -m "feat(billing): 平台报表切到抽佣流水表——与结算单和出款单共用同一事实源"
```

---

### Task 4: `ledger.service.ts`（按期批量聚合）

**Files:**
- Create: `api/src/modules/billing/ledger.service.ts`
- Create: `api/src/modules/billing/ledger.service.spec.ts`
- Modify: `api/src/modules/billing/billing.module.ts`（注册 provider + 导出）

⚠️ **命名照 `settlement.ts`（纯函数）+ `settlement.service.ts`（服务层）的既有模式**：
`ledger.ts` 是纯函数，`ledger.service.ts` 是取数与聚合。

⚠️ **为什么要单独一个 service**：它要查库（不是纯函数）→ 不能放进 `ledger.ts`。
而它要被**两处**共用（出款页与商家侧对账单）→ 放进 `payout.service.ts` 会让
那个文件变成「什么都管」，且对账单依赖「出款服务」在语义上很别扭。

⚠️ **这个方法是解决 L55 的关键** —— 它把「每期 3 次查询」变成「**固定 6 次查询**」
（不论多少期）。

- [ ] **Step 1: 写失败的单测**

`api/src/modules/billing/ledger.service.spec.ts`：

```ts
import { OrderStatus, PayoutStatus } from '@prisma/client';
import { LedgerService } from './ledger.service';

/**
 * 按期批量聚合的单测。
 *
 * ⚠️ **用 jest mock 掉 prisma** —— 这里要验的是「查了几次」与「分组对不对」，
 *    不是 SQL 本身（SQL 的正确性由 e2e 保证）。
 */
describe('LedgerService（阶段 5i）', () => {
  const period = {
    from: new Date('2026-08-01T00:00:00.000Z'),
    to: new Date('2026-09-01T00:00:00.000Z'),
  };

  function makePrisma() {
    return {
      merchantReceipt: { findMany: jest.fn().mockResolvedValue([]) },
      settlementStatement: { findMany: jest.fn().mockResolvedValue([]) },
      settlementStatementEntry: { findMany: jest.fn().mockResolvedValue([]) },
      commissionEntry: { findMany: jest.fn().mockResolvedValue([]) },
      payout: { findMany: jest.fn().mockResolvedValue([]) },
      payoutEntry: { findMany: jest.fn().mockResolvedValue([]) },
    };
  }

  it('⚠️ 无论多少期，查询次数是固定的（这是 L55 的解药）', async () => {
    const prisma = makePrisma();
    const service = new LedgerService(prisma as never);

    await service.aggregatePeriods('tenant-1', [period, period, period]);
    await service.aggregatePeriods('tenant-1', [period]);

    // ⚠️ **每一张表只查一次** —— 3 期与 1 期的查询次数必须一样。
    expect(prisma.merchantReceipt.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.settlementStatement.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.settlementStatementEntry.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.commissionEntry.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.payout.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.payoutEntry.findMany).toHaveBeenCalledTimes(1);
  });

  it('货款按期分组', async () => {
    const prisma = makePrisma();
    prisma.merchantReceipt.findMany.mockResolvedValue([
      { amount: 10000, occurredAt: new Date('2026-08-10T00:00:00.000Z') },
      { amount: 5000, occurredAt: new Date('2026-08-20T00:00:00.000Z') },
    ]);
    const service = new LedgerService(prisma as never);

    const result = await service.aggregatePeriods('tenant-1', [period]);
    expect(result.get('2026-08')?.receiptAmount).toBe(15000);
    expect(result.get('2026-08')?.receiptCount).toBe(2);
  });

  it('⚠️ 没有结算单的期 → 佣金是 null（不是 0）', async () => {
    const prisma = makePrisma();
    const service = new LedgerService(prisma as never);

    const result = await service.aggregatePeriods('tenant-1', [period]);
    expect(result.get('2026-08')?.commissionAmount).toBeNull();
    expect(result.get('2026-08')?.statementStatus).toBeNull();
  });

  it('出款单按状态分桶：PAID 算已出款，REQUESTED 算在途', async () => {
    const prisma = makePrisma();
    prisma.payout.findMany.mockResolvedValue([
      {
        periodStart: period.from,
        status: PayoutStatus.PAID,
        netAmount: 8500,
        kind: 'NORMAL',
      },
      {
        periodStart: period.from,
        status: PayoutStatus.REQUESTED,
        netAmount: 5000,
        kind: 'SUPPLEMENT',
      },
    ]);
    const service = new LedgerService(prisma as never);

    const result = await service.aggregatePeriods('tenant-1', [period]);
    expect(result.get('2026-08')?.paidAmount).toBe(8500);
    expect(result.get('2026-08')?.inFlightAmount).toBe(5000);
    expect(result.get('2026-08')?.hasActiveNormal).toBe(true);
    expect(result.get('2026-08')?.normalPaid).toBe(true);
    expect(result.get('2026-08')?.hasActiveSupplement).toBe(true);
  });

  it('⚠️ 已被出款单占用的流水不再算「未纳入」', async () => {
    const prisma = makePrisma();
    prisma.merchantReceipt.findMany.mockResolvedValue([
      { amount: 10000, occurredAt: new Date('2026-08-10T00:00:00.000Z') },
      { amount: 5000, occurredAt: new Date('2026-08-20T00:00:00.000Z') },
    ]);
    prisma.payoutEntry.findMany.mockResolvedValue([
      { entryId: 'receipt-already-paid' },
    ]);
    prisma.merchantReceipt.findMany.mockResolvedValue([
      {
        id: 'receipt-already-paid',
        amount: 10000,
        occurredAt: new Date('2026-08-10T00:00:00.000Z'),
      },
      {
        id: 'receipt-new',
        amount: 5000,
        occurredAt: new Date('2026-08-20T00:00:00.000Z'),
      },
    ]);
    const service = new LedgerService(prisma as never);

    const result = await service.aggregatePeriods('tenant-1', [period]);
    // ⚠️ **未纳入的只有新来的那笔 5000**
    expect(result.get('2026-08')?.supplementAmount).toBe(5000);
  });
});
```

- [ ] **Step 2: 跑测试确认它失败**

```bash
cd api && npx jest src/modules/billing/ledger.service.spec.ts
```

Expected: **FAIL** —— `Cannot find module './ledger.service'`。

- [ ] **Step 3: 写实现**

`api/src/modules/billing/ledger.service.ts`：

```ts
import { Injectable } from '@nestjs/common';
import { PayoutStatus, SettlementStatus } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { formatPeriodLabel } from './settlement';
import { groupReceiptsByPeriod, splitPayoutAmounts } from './ledger';

/** 一期的聚合结果 */
export interface PeriodAmounts {
  /** 货款净额（实时聚合，带符号） */
  receiptAmount: number;
  /** 货款流水笔数 */
  receiptCount: number;
  /** 该期结算单 id；null = 该期没有结算单 */
  statementId: string | null;
  /** 佣金净额（**带符号**，取结算单的 `netAmount`）；null = 该期没有结算单 */
  commissionAmount: number | null;
  /** 结算单状态；null = 该期没有结算单 */
  statementStatus: SettlementStatus | null;
  /** 抽佣流水笔数（结算单纳入的） */
  commissionEntryCount: number;
  /** 已出款金额（`PAID` 的出款单之和） */
  paidAmount: number;
  /** 在途金额（`REQUESTED` / `APPROVED` / `PROCESSING` 的出款单之和） */
  inFlightAmount: number;
  /** 有没有活跃的正常单（活跃含 `PAID`） */
  hasActiveNormal: boolean;
  /** 有没有活跃的补差单 */
  hasActiveSupplement: boolean;
  /** 正常单是否已 `PAID` */
  normalPaid: boolean;
  /** 未纳入的货款（补差金额）；null = 还没算 */
  supplementAmount: number | null;
}

/** 一批出款单（聚合时只需要这几个字段） */
interface PayoutRow {
  periodStart: Date;
  status: PayoutStatus;
  netAmount: number;
  kind: 'NORMAL' | 'SUPPLEMENT';
}

/**
 * 按期批量聚合账目数据（阶段 5i）。
 *
 * ⚠️ **这个服务存在的唯一理由：把 N 次查询变成固定次数** ——
 *    阶段 5h-2 的 L55（`availablePeriods` 的 N+1）就是这么来的：
 *    逐期循环调 `computeAmounts`，每期 3 次查询。
 *    商家侧对账单也要按期聚合 → 同样的 N+1 会再出现一次。
 *    → **两边共用这一个服务**，数字与查询次数一起统一。
 *
 * ⚠️ **「活跃」的定义与 `findActivePayout` 逐字一致**：
 *    `notIn(REJECTED, CANCELLED, FAILED)` —— **含 `PAID`**。
 *    三处（部分唯一索引的 `WHERE`、`findActivePayout`、这里的活跃判定）
 *    必须是同一个集合，否则会出现「查询认为不活跃、插入却被索引拦下」的错位。
 */
@Injectable()
export class LedgerService {
  constructor(private readonly prisma: TenantPrismaService) {}

  /**
   * 一次查齐所有期的货款 / 佣金 / 出款，内存里按期分组。
   *
   * ⚠️ **查询次数与期数无关** —— 不论 1 期还是 100 期，都是 6 次查询。
   *
   * ⚠️ **商家侧调用时不要手写 `tenantId`** —— 租户作用域扩展会自动附加；
   *    但 `settlement_statement_entries` 与 `payout_entries` **没有 tenantId
   *    字段、不在白名单** → 这里用「先查该租户的结算单/出款单，再按 id 关联」
   *    的方式限定它们，**归属天然安全**（那些 id 本来就是该租户的）。
   */
  async aggregatePeriods(
    tenantId: string,
    periods: Array<{ from: Date; to: Date }>,
  ): Promise<Map<string, PeriodAmounts>> {
    const empty = (): PeriodAmounts => ({
      receiptAmount: 0,
      receiptCount: 0,
      statementId: null,
      commissionAmount: null,
      statementStatus: null,
      commissionEntryCount: 0,
      paidAmount: 0,
      inFlightAmount: 0,
      hasActiveNormal: false,
      hasActiveSupplement: false,
      normalPaid: false,
      supplementAmount: null,
    });

    const result = new Map<string, PeriodAmounts>();
    if (periods.length === 0) {
      return result;
    }

    const from = new Date(
      Math.min(...periods.map((p) => p.from.getTime())),
    );
    const to = new Date(
      Math.max(...periods.map((p) => p.to.getTime())),
    );

    // ---- ① 货款流水（一次）----
    const receipts = await this.prisma.merchantReceipt.findMany({
      where: {
        tenantId,
        occurredAt: { gte: from, lt: to },
      },
      select: { id: true, amount: true, occurredAt: true },
    });
    const receiptByPeriod = groupReceiptsByPeriod(receipts);

    // ---- ② 结算单（一次）----
    const statements = await this.prisma.settlementStatement.findMany({
      where: {
        tenantId,
        periodStart: { gte: from, lt: to },
      },
      select: {
        id: true,
        periodStart: true,
        netAmount: true,
        status: true,
      },
    });
    const statementByPeriod = new Map(
      statements.map((s) => [formatPeriodLabel(s.periodStart), s]),
    );

    // ---- ③ 结算单纳入的抽佣流水（一次）----
    // ⚠️ **`settlement_statement_entries` 不在租户白名单**（没有 tenantId 字段）
    //    → 用「该租户的结算单 id」限定它，归属天然安全。
    const statementIds = statements.map((s) => s.id);
    const statementLinks =
      statementIds.length > 0
        ? await this.prisma.settlementStatementEntry.findMany({
            where: { statementId: { in: statementIds } },
            select: { statementId: true, entryId: true },
          })
        : [];
    const entryCountByStatement = new Map<string, number>();
    for (const link of statementLinks) {
      entryCountByStatement.set(
        link.statementId,
        (entryCountByStatement.get(link.statementId) ?? 0) + 1,
      );
    }

    // ---- ④ 出款单（一次）----
    const payouts = (await this.prisma.payout.findMany({
      where: {
        tenantId,
        periodStart: { gte: from, lt: to },
      },
      select: { id: true, periodStart: true, status: true, netAmount: true, kind: true },
    })) as PayoutRow[];

    // ---- ⑤ 已被出款单占用的货款流水（一次）----
    // ⚠️ **`payout_entries` 同样不在租户白名单** → 用「该租户的出款单 id」限定。
    const payoutIds = payouts.map((p) => p.id);
    const payoutLinks =
      payoutIds.length > 0
        ? await this.prisma.payoutEntry.findMany({
            where: { payoutId: { in: payoutIds } },
            select: { payoutId: true, entryId: true },
          })
        : [];
    const claimedEntryIds = new Set(payoutLinks.map((l) => l.entryId));

    // ---- ⑥ 分期汇总 ----
    for (const period of periods) {
      const label = formatPeriodLabel(period.from);
      const amounts = empty();

      // 货款
      const receiptSum = receiptByPeriod.get(label);
      amounts.receiptAmount = receiptSum?.amount ?? 0;
      amounts.receiptCount = receiptSum?.count ?? 0;

      // 佣金（取结算单的冻结值）
      const statement = statementByPeriod.get(label);
      if (statement) {
        amounts.statementId = statement.id;
        amounts.commissionAmount = statement.netAmount;
        amounts.statementStatus = statement.status;
        amounts.commissionEntryCount =
          entryCountByStatement.get(statement.id) ?? 0;
      }

      // 出款单分桶
      const periodPayouts = payouts.filter(
        (p) => formatPeriodLabel(p.periodStart) === label,
      );
      const buckets = splitPayoutAmounts(periodPayouts);
      amounts.paidAmount = buckets.paid;
      amounts.inFlightAmount = buckets.inFlight;
      for (const payout of periodPayouts) {
        const active =
          payout.status !== PayoutStatus.REJECTED &&
          payout.status !== PayoutStatus.CANCELLED &&
          payout.status !== PayoutStatus.FAILED;
        if (payout.kind === 'NORMAL') {
          if (active) {
            amounts.hasActiveNormal = true;
          }
          if (payout.status === PayoutStatus.PAID) {
            amounts.normalPaid = true;
          }
        } else if (active) {
          amounts.hasActiveSupplement = true;
        }
      }

      // 未纳入的货款（补差金额）
      // ⚠️ **只算「没有被任何出款单占用」的货款** ——
      //    已被正常单纳入的那批不算（它已经打出去了）。
      const unclaimed = receipts
        .filter((r) => formatPeriodLabel(r.occurredAt) === label)
        .filter((r) => !claimedEntryIds.has(r.id))
        .reduce((sum, r) => sum + r.amount, 0);
      amounts.supplementAmount = unclaimed;

      result.set(label, amounts);
    }

    return result;
  }
}
```

⚠️ **`splitPayoutAmounts` 的入参类型**：它要 `PayoutLike`（含 `kind`），
而 `PayoutRow` 多了 `id` 与 `periodStart` → 结构上兼容 ✅（TS 的结构化类型）。

- [ ] **Step 4: 跑测试确认它过了**

```bash
cd api && npx jest src/modules/billing/ledger.service.spec.ts
```

Expected: **PASS**（5 个用例全过）。

- [ ] **Step 5: 注册到模块**

`api/src/modules/billing/billing.module.ts` 的 `providers` 里加 `LedgerService`，
`exports` 里也加（商家侧的服务层要注入它）：

```ts
import { LedgerService } from './ledger.service';
```

```ts
  providers: [
    // ...
    LedgerService,
  ],
  exports: [
    // ...
    LedgerService,
  ],
```

- [ ] **Step 6: 提交**

```bash
git add api/src/modules/billing/ledger.service.ts api/src/modules/billing/ledger.service.spec.ts api/src/modules/billing/billing.module.ts
git commit -m "feat(billing): 按期批量聚合服务——把 N 次查询变成固定 6 次"
```

---

### Task 5: 商家侧对账单的服务层与端点

**Files:**
- Create: `api/src/modules/billing/merchant-statement.service.ts`
- Create: `api/src/modules/billing/merchant-statement.service.spec.ts`
- Create: `api/src/modules/billing/merchant-statement.controller.ts`
- Modify: `api/src/modules/billing/billing.module.ts`（注册 controller + provider）

- [ ] **Step 1: 写服务层的类型（先定形状）**

`api/src/modules/billing/merchant-statement.service.ts` 的类型部分：

```ts
/** 一期对账单的视图（商家侧） */
export interface StatementPeriodView {
  /** 周期标签 `YYYY-MM` */
  period: string;
  /** 该期结算单 id；null = 还没生成 */
  statementId: string | null;
  /** 结算单状态；null = 还没生成 */
  statementStatus: SettlementStatus | null;
  /** 货款净额（实时聚合） */
  receiptAmount: number;
  /** 货款流水笔数 */
  receiptCount: number;
  /** 佣金净额（**带符号**，取结算单的冻结值）；null = 没有结算单 */
  commissionAmount: number | null;
  /** 抽佣流水笔数（结算单纳入的） */
  commissionEntryCount: number;
  /** 商家应结 = 货款净额 − 佣金净额；null = 佣金未知 */
  payableAmount: number | null;
  /** 已出款金额 */
  paidAmount: number;
  /** 在途金额 */
  inFlightAmount: number;
  /** 待出款金额 = 应结 − 已出款 − 在途；null = 应结未知 */
  pendingAmount: number | null;
  /** 已超付金额（> 0 = 平台多付了） */
  overpaidAmount: number;
  /** 可以申请哪种出款；null = 现在不能申请 */
  applicableKind: 'NORMAL' | 'SUPPLEMENT' | null;
  /** 不能申请时的原因（给商家看的中文）；null = 能申请 */
  blockedReason: string | null;
}

/** 一期对账单的详情（商家侧） */
export interface StatementPeriodDetail extends StatementPeriodView {
  /** 抽佣明细（结算单纳入的流水） */
  commissionEntries: Array<{
    entryId: string;
    orderNo: string;
    type: string;
    /** 计佣基数（整数分） */
    baseAmount: number;
    /** 费率（基点，10000 = 100%） */
    rateBps: number;
    /** 佣金金额（**带符号**：抽佣为正、冲回为负） */
    amount: number;
    /** ISO 8601 */
    occurredAt: string;
  }>;
  /** 货款明细（实时） */
  receiptEntries: Array<{
    entryId: string;
    orderNo: string;
    type: string;
    /** 金额（**带符号**） */
    amount: number;
    /** ISO 8601 */
    occurredAt: string;
    /** 是否已经被出款单出过 */
    claimed: boolean;
  }>;
}
```

- [ ] **Step 2: 写失败的单测**

`api/src/modules/billing/merchant-statement.service.spec.ts`：

```ts
import { SettlementStatus } from '@prisma/client';
import { MerchantStatementService } from './merchant-statement.service';

describe('MerchantStatementService（阶段 5i）', () => {
  const period = {
    from: new Date('2026-08-01T00:00:00.000Z'),
    to: new Date('2026-09-01T00:00:00.000Z'),
  };

  function makeService(overrides: {
    amounts?: Record<string, unknown>;
    receipts?: Array<Record<string, unknown>>;
    commissionEntries?: Array<Record<string, unknown>>;
  } = {}) {
    const ledger = {
      aggregatePeriods: jest.fn().mockResolvedValue(
        new Map([
          [
            '2026-08',
            {
              receiptAmount: 10000,
              receiptCount: 1,
              commissionAmount: 1500,
              statementStatus: SettlementStatus.CONFIRMED,
              commissionEntryCount: 1,
              paidAmount: 0,
              inFlightAmount: 0,
              hasActiveNormal: false,
              hasActiveSupplement: false,
              normalPaid: false,
              supplementAmount: null,
              ...(overrides.amounts ?? {}),
            },
          ],
        ]),
      ),
    };
    const prisma = {
      merchantReceipt: {
        findMany: jest
          .fn()
          .mockResolvedValue(overrides.receipts ?? []),
      },
      settlementStatement: { findFirst: jest.fn().mockResolvedValue(null) },
      settlementStatementEntry: { findMany: jest.fn().mockResolvedValue([]) },
      commissionEntry: {
        findMany: jest
          .fn()
          .mockResolvedValue(overrides.commissionEntries ?? []),
      },
    };
    const service = new MerchantStatementService(prisma as never, ledger as never);
    return { service, prisma, ledger };
  }

  it('应结 = 货款净额 − 佣金净额', async () => {
    const { service } = makeService();
    const views = await service.list();
    expect(views[0].payableAmount).toBe(8500);
  });

  it('待出款 = 应结 − 已出款 − 在途', async () => {
    const { service } = makeService({
      amounts: { paidAmount: 3000, inFlightAmount: 1000 },
    });
    const views = await service.list();
    expect(views[0].pendingAmount).toBe(4500);
  });

  it('⚠️ 超付时待出款是 0（不出现负数），且超付金额单独给出', async () => {
    const { service } = makeService({
      amounts: { receiptAmount: 0, commissionAmount: 0, paidAmount: 8500 },
    });
    const views = await service.list();
    expect(views[0].pendingAmount).toBe(0);
    expect(views[0].overpaidAmount).toBe(8500);
  });

  it('⚠️ 没有结算单 → 佣金与应结都是 null', async () => {
    const { service } = makeService({
      amounts: { commissionAmount: null, statementStatus: null },
    });
    const views = await service.list();
    expect(views[0].commissionAmount).toBeNull();
    expect(views[0].payableAmount).toBeNull();
    expect(views[0].applicableKind).toBeNull();
  });

  // ---- 护栏 S2 / S3：明细加总必须等于汇总 ----
  it('S2：抽佣明细加总 = 佣金净额（对不上就抛错，不让商家对不上账）', async () => {
    const { service } = makeService({
      commissionEntries: [
        {
          id: 'e1',
          orderNo: 'ORD-001',
          type: 'COMMISSION',
          baseAmount: 10000,
          rateBps: 500,
          amount: 1500,
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
        },
      ],
    });

    // ⚠️ **佣金净额是 1500，明细加总也是 1500** → 一致，不抛错
    await expect(
      service.detail('2026-08'),
    ).resolves.toBeDefined();
  });

  it('S2：⚠️ 明细加总与佣金净额对不上 → 抛错', async () => {
    const { service } = makeService({
      // ⚠️ **佣金净额是 1500，但明细加总只有 100** → 对不上
      commissionEntries: [
        {
          id: 'e1',
          orderNo: 'ORD-001',
          type: 'COMMISSION',
          baseAmount: 10000,
          rateBps: 500,
          amount: 100,
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
        },
      ],
    });

    await expect(service.detail('2026-08')).rejects.toThrow(/不一致/);
  });

  it('S3：⚠️ 货款明细加总与货款净额对不上 → 抛错', async () => {
    const { service } = makeService({
      receipts: [
        {
          id: 'r1',
          orderNo: 'ORD-001',
          type: 'SALE',
          amount: 100,
          occurredAt: new Date('2026-08-10T00:00:00.000Z'),
        },
      ],
    });

    // ⚠️ **货款净额是 10000，明细加总只有 100** → 对不上
    await expect(service.detail('2026-08')).rejects.toThrow(/不一致/);
  });
});
```

- [ ] **Step 3: 跑测试确认它失败**

```bash
cd api && npx jest src/modules/billing/merchant-statement.service.spec.ts
```

Expected: **FAIL** —— `Cannot find module './merchant-statement.service'`。

- [ ] **Step 4: 写服务层实现**

`api/src/modules/billing/merchant-statement.service.ts`：

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { SettlementStatus } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { getTenantContext } from '../../common/tenant/tenant-context';
import { LedgerService, PeriodAmounts } from './ledger.service';
import { deriveApplicableKind } from './ledger';
import { formatPeriodLabel, resolveMonthlyPeriod } from './settlement';

/** 一期对账单的视图（商家侧） */
export interface StatementPeriodView {
  period: string;
  statementId: string | null;
  statementStatus: SettlementStatus | null;
  receiptAmount: number;
  receiptCount: number;
  commissionAmount: number | null;
  commissionEntryCount: number;
  payableAmount: number | null;
  paidAmount: number;
  inFlightAmount: number;
  pendingAmount: number | null;
  overpaidAmount: number;
  applicableKind: 'NORMAL' | 'SUPPLEMENT' | null;
  blockedReason: string | null;
}

/** 一期对账单的详情（商家侧） */
export interface StatementPeriodDetail extends StatementPeriodView {
  commissionEntries: Array<{
    entryId: string;
    orderNo: string;
    type: string;
    baseAmount: number;
    rateBps: number;
    amount: number;
    occurredAt: string;
  }>;
  receiptEntries: Array<{
    entryId: string;
    orderNo: string;
    type: string;
    amount: number;
    occurredAt: string;
    claimed: boolean;
  }>;
}

/**
 * 商家侧的「对账单」（阶段 5i）。
 *
 * ⚠️ **数字一律来自 `LedgerService.aggregatePeriods`** ——
 *    与出款页共用同一份聚合 → 商家在两个页面看到的数字**必然一致**（护栏 S4）。
 *
 * ⚠️ **佣金是「冻结值」（取结算单），货款是「实时值」** ——
 *    抽佣明细必须是**结算单纳入的那些流水**，否则商家把明细加总会发现
 *    与页面上的佣金净额对不上（设计 §5.3）。
 */
@Injectable()
export class MerchantStatementService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly ledger: LedgerService,
  ) {}

  /**
   * 列出该商家**所有有货款流水的期**。
   *
   * ⚠️ **包含不能申请出款的期** —— 商家需要看到「我这期有货款，
   *    但结算单还没确认」，否则只能打电话问客服（设计 §5.7）。
   */
  async list(): Promise<StatementPeriodView[]> {
    const context = getTenantContext();
    const tenantId = context.tenantId;
    if (!tenantId) {
      throw new NotFoundException('商家上下文不存在');
    }

    // ⚠️ **先用货款流水找出有哪些期**（商家侧，租户作用域自动附加 tenantId）
    const receipts = await this.prisma.merchantReceipt.findMany({
      select: { occurredAt: true },
    });
    const labels = [
      ...new Set(receipts.map((r) => formatPeriodLabel(r.occurredAt))),
    ].sort((a, b) => b.localeCompare(a));

    const periods = labels.map((label) => resolveMonthlyPeriod(label));
    const aggregated = await this.ledger.aggregatePeriods(tenantId, periods);

    return labels.map((label) => {
      // ⚠️ **聚合结果里一定有这一期**（期是从流水查出来的），
      //    但 TypeScript 不知道 —— 兜一个空值，别让 `undefined` 漏到视图里。
      const amounts = aggregated.get(label);
      if (!amounts) {
        throw new NotFoundException('该期没有货款流水');
      }
      return this.toView(label, amounts);
    });
  }

  /**
   * 一期的详情（汇总 + 抽佣明细 + 货款明细）。
   */
  async detail(period: string): Promise<StatementPeriodDetail> {
    const context = getTenantContext();
    const tenantId = context.tenantId;
    if (!tenantId) {
      throw new NotFoundException('商家上下文不存在');
    }

    const resolved = resolveMonthlyPeriod(period);
    const aggregated = await this.ledger.aggregatePeriods(tenantId, [
      resolved,
    ]);
    const amounts = aggregated.get(resolved.label);
    if (!amounts) {
      throw new NotFoundException('该期没有货款流水');
    }

    const view = this.toView(resolved.label, amounts);

    // ---- 抽佣明细：结算单纳入的流水 ----
    const commissionEntries = await this.commissionEntriesOf(
      tenantId,
      resolved.from,
    );
    // ---- 货款明细：实时的 ----
    const receiptEntries = await this.receiptEntriesOf(tenantId, resolved);

    // ⚠️⚠️ **自检：明细加总必须等于汇总**（护栏 S2 / S3）——
    //    明细与汇总来自**两处不同的查询**（明细是「结算单纳入的流水」与
    //    「实时货款流水」，汇总是聚合算出来的）→ 不一致就说明其中一边算错了。
    //    ⚠️ **在这里炸，而不是让商家对不上账** ——
    //    商家把明细加总发现与页面上的佣金净额差 1 分，他会以为平台算错了，
    //    然后来投诉。宁可这个接口 500。
    //
    // ⚠️ **抽佣明细加总 == 结算单的 `netAmount`**：结算单生成时
    //    `netAmount = grossAmount + reversalAmount`，而纳入的正是同一批流水
    //    （流水 append-only，金额永不变）→ 必然相等。
    const commissionSum = commissionEntries.reduce(
      (sum, entry) => sum + entry.amount,
      0,
    );
    if (commissionSum !== (amounts.commissionAmount ?? 0)) {
      throw new Error(
        `抽佣明细加总 ${commissionSum} 与佣金净额 ${amounts.commissionAmount} 不一致`,
      );
    }

    // ⚠️ **货款明细加总 == 货款净额**（同一个来源，理应恒等）
    const receiptSum = receiptEntries.reduce(
      (sum, entry) => sum + entry.amount,
      0,
    );
    if (receiptSum !== amounts.receiptAmount) {
      throw new Error(
        `货款明细加总 ${receiptSum} 与货款净额 ${amounts.receiptAmount} 不一致`,
      );
    }

    return { ...view, commissionEntries, receiptEntries };
  }

  /** 一期的视图 */
  private toView(
    period: string,
    amounts: PeriodAmounts,
  ): StatementPeriodView {
    const payable =
      amounts.commissionAmount === null
        ? null
        : amounts.receiptAmount - amounts.commissionAmount;

    const pending =
      payable === null
        ? null
        : Math.max(0, payable - amounts.paidAmount - amounts.inFlightAmount);
    const overpaid =
      payable === null ? 0 : Math.max(0, amounts.paidAmount - payable);

    const applicable = deriveApplicableKind({
      periodEnded: true,
      receiptAmount: amounts.receiptAmount,
      receiptCount: amounts.receiptCount,
      commissionAmount: amounts.commissionAmount,
      statementStatus: amounts.statementStatus,
      hasActiveNormal: amounts.hasActiveNormal,
      hasActiveSupplement: amounts.hasActiveSupplement,
      normalPaid: amounts.normalPaid,
      supplementAmount: amounts.supplementAmount,
    });

    return {
      period,
      statementId: amounts.statementId,
      statementStatus: amounts.statementStatus,
      receiptAmount: amounts.receiptAmount,
      receiptCount: amounts.receiptCount,
      commissionAmount: amounts.commissionAmount,
      commissionEntryCount: amounts.commissionEntryCount,
      payableAmount: payable,
      paidAmount: amounts.paidAmount,
      inFlightAmount: amounts.inFlightAmount,
      pendingAmount: pending,
      overpaidAmount: overpaid,
      applicableKind: applicable.kind,
      blockedReason: applicable.reason,
    };
  }

  /** 抽佣明细（结算单纳入的流水） */
  private async commissionEntriesOf(
    tenantId: string,
    periodStart: Date,
  ): Promise<StatementPeriodDetail['commissionEntries']> {
    // ⚠️ **先查该租户这一期的结算单** —— 租户作用域自动附加 tenantId →
    //    查不到就是「这期没有结算单」→ 没有明细。
    const statement = await this.prisma.settlementStatement.findFirst({
      where: { tenantId, periodStart },
      select: { id: true },
    });
    if (!statement) {
      return [];
    }

    // ⚠️ **`settlement_statement_entries` 不在租户白名单**（没有 tenantId 字段）
    //    → 用上面查到的 `statementId` 限定它，归属天然安全。
    const links = await this.prisma.settlementStatementEntry.findMany({
      where: { statementId: statement.id },
      select: { entryId: true },
    });
    if (links.length === 0) {
      return [];
    }

    const entries = await this.prisma.commissionEntry.findMany({
      where: { id: { in: links.map((l) => l.entryId) } },
      orderBy: { occurredAt: 'asc' },
      select: {
        id: true,
        orderNo: true,
        type: true,
        baseAmount: true,
        rateBps: true,
        amount: true,
        occurredAt: true,
      },
    });

    return entries.map((entry) => ({
      entryId: entry.id,
      orderNo: entry.orderNo,
      type: entry.type,
      baseAmount: entry.baseAmount,
      rateBps: entry.rateBps,
      amount: entry.amount,
      occurredAt: entry.occurredAt.toISOString(),
    }));
  }

  /** 货款明细（实时） */
  private async receiptEntriesOf(
    tenantId: string,
    period: { from: Date; to: Date },
  ): Promise<StatementPeriodDetail['receiptEntries']> {
    const receipts = await this.prisma.merchantReceipt.findMany({
      where: { tenantId, occurredAt: { gte: period.from, lt: period.to } },
      orderBy: { occurredAt: 'asc' },
      select: {
        id: true,
        orderNo: true,
        type: true,
        amount: true,
        occurredAt: true,
      },
    });

    // ⚠️ **标出哪些已经被出款单出过** ——
    //    货款明细是实时的，混着「已出」与「未出」两批 →
    //    不标出来商家会困惑（「这 ¥100 为什么还在待出款里」）。
    const payouts = await this.prisma.payout.findMany({
      where: { tenantId, periodStart: period.from },
      select: { id: true },
    });
    const payoutIds = payouts.map((p) => p.id);
    // ⚠️ **`payout_entries` 不在租户白名单** → 用该租户的出款单 id 限定它。
    const links =
      payoutIds.length > 0
        ? await this.prisma.payoutEntry.findMany({
            where: { payoutId: { in: payoutIds } },
            select: { entryId: true },
          })
        : [];
    const claimed = new Set(links.map((l) => l.entryId));

    return receipts.map((receipt) => ({
      entryId: receipt.id,
      orderNo: receipt.orderNo,
      type: receipt.type,
      amount: receipt.amount,
      occurredAt: receipt.occurredAt.toISOString(),
      claimed: claimed.has(receipt.id),
    }));
  }
}
```

- [ ] **Step 5: 跑测试确认它过了**

```bash
cd api && npx jest src/modules/billing/merchant-statement.service.spec.ts
```

Expected: **PASS**（4 个用例全过）。

- [ ] **Step 6: 写端点**

`api/src/modules/billing/merchant-statement.controller.ts`：

```ts
import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { MerchantStatementService } from './merchant-statement.service';

/**
 * 商家侧的对账单接口（阶段 5i）。
 *
 * ⚠️ **只读** —— 对账单只是「看」，申请出款仍然走 `merchant/payouts`。
 *
 * ⚠️ **角色**：`MERCHANT_OWNER` —— 与出款接口同款。
 * 员工看对账单没有风险（不改钱），但与出款接口保持一致更简单。
 */
@ApiTags('merchant-statements')
@Controller('merchant/statements')
@Roles(UserRole.MERCHANT_OWNER)
export class MerchantStatementController {
  constructor(private readonly statements: MerchantStatementService) {}

  @Get()
  @ApiOperation({ summary: '我的对账单（每一期的货款、佣金与应结）' })
  async list() {
    return this.statements.list();
  }

  @Get(':period')
  @ApiOperation({ summary: '某一期的对账单详情（含抽佣明细与货款明细）' })
  async detail(@Param('period') period: string) {
    return this.statements.detail(period);
  }
}
```

- [ ] **Step 7: 注册到模块**

`api/src/modules/billing/billing.module.ts`：
- `import { MerchantStatementController } from './merchant-statement.controller';`
- `import { MerchantStatementService } from './merchant-statement.service';`
- `controllers` 里加 `MerchantStatementController`
- `providers` 里加 `MerchantStatementService`

- [ ] **Step 8: 跑 lint 与全量单测**

```bash
cd api && npm run lint
cd api && npm test 2>&1 | tail -5
```

Expected: 全绿，lint 无输出。

- [ ] **Step 9: 提交**

```bash
git add api/src/modules/billing/merchant-statement.service.ts \
        api/src/modules/billing/merchant-statement.service.spec.ts \
        api/src/modules/billing/merchant-statement.controller.ts \
        api/src/modules/billing/billing.module.ts
git commit -m "feat(billing): 商家侧对账单——每一期的货款、佣金（含费率）与应结"
```

---

### Task 6: `availablePeriods` 改用批量聚合（修 L55）

**Files:**
- Modify: `api/src/modules/billing/payout.service.ts`（`availablePeriods()`）
- Modify: `api/test/payout-execution.e2e-spec.ts`（若断言口径变了）

⚠️ **这个 Task 的价值有两层**：
① 把「每期 3 次查询」变成「固定 6 次」；
② **让出款页与对账单真的共用同一份聚合** —— 否则两个页面迟早漂移（护栏 S4）。

⚠️ **返回结构不变** → `merchant-admin` 的 `AvailablePeriod` 类型与申请页**不用改**。

- [ ] **Step 1: 改 `availablePeriods()`**

`api/src/modules/billing/payout.service.ts`：

1. 在构造函数注入 `LedgerService`：

```ts
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly queues: QueueService,
    private readonly ledger: LedgerService,
  ) {}
```

2. 把 `availablePeriods()` 的循环体改成用聚合结果：

```ts
  async availablePeriods(): Promise<AvailablePeriodView[]> {
    const context = getTenantContext();
    const tenantId = context.tenantId;
    if (!tenantId) {
      throw new BadRequestException('缺少租户上下文');
    }

    const now = await this.prisma.databaseNow();

    // ⚠️ **只查一次** —— 找出该商家有哪些期有货款流水。
    //    商家侧靠租户作用域扩展自动附加 tenantId。
    const receipts = await this.prisma.merchantReceipt.findMany({
      where: { occurredAt: { lt: now } },
      select: { occurredAt: true },
    });
    const labels = [
      ...new Set(receipts.map((r) => formatPeriodLabel(r.occurredAt))),
    ].sort((a, b) => b.localeCompare(a));

    const periods = labels.map((label) => resolveMonthlyPeriod(label));
    // ⚠️ **一次查齐所有期**（阶段 5i）—— 原来这里是**逐期循环调
    //    `computeAmounts`**（每期 3 次查询 → N+1，阶段 5h-2 的 L55）。
    const aggregated = await this.ledger.aggregatePeriods(tenantId, periods);

    const views: AvailablePeriodView[] = [];
    for (const label of labels) {
      const resolved = resolveMonthlyPeriod(label);
      if (resolved.to.getTime() > now.getTime()) {
        continue;
      }
      const amounts = aggregated.get(label);
      if (!amounts) {
        continue;
      }

      const appliedKind: PayoutKind | null = amounts.hasActiveSupplement
        ? PayoutKind.SUPPLEMENT
        : amounts.hasActiveNormal
          ? PayoutKind.NORMAL
          : null;
      const supplementAvailable =
        amounts.normalPaid &&
        amounts.supplementAmount !== null &&
        amounts.supplementAmount > 0;
      const supplementAmount = supplementAvailable
        ? amounts.supplementAmount
        : null;

      // ⚠️ **没有活跃单时按 5h-1 的规则跳过**（含「正常单是
      //    REJECTED / CANCELLED / FAILED」的情况 → 走正常路径重新申请）
      if (!amounts.hasActiveNormal && !amounts.hasActiveSupplement) {
        if (amounts.receiptCount === 0 || amounts.receiptAmount - (amounts.commissionAmount ?? 0) <= 0) {
          continue;
        }
      }

      views.push({
        period: label,
        receiptAmount: amounts.receiptAmount,
        commissionAmount: amounts.commissionAmount ?? 0,
        netAmount:
          amounts.commissionAmount === null
            ? amounts.receiptAmount
            : amounts.receiptAmount - amounts.commissionAmount,
        entryCount: amounts.receiptCount,
        statementStatus: amounts.statementStatus,
        alreadyApplied: appliedKind !== null,
        appliedKind,
        supplementAvailable,
        supplementAmount,
      });
    }
    return views;
  }
```

⚠️ **注意 `commissionAmount` 的符号** —— `computeAmounts` 里是
`statement ? statement.netAmount : 0`（**可能是负数**），
聚合结果里 `commissionAmount` 是 `null`（没有结算单）→ 这里用 `?? 0` 兜 ✅
（与旧行为逐字一致）。

- [ ] **Step 2: 跑 e2e 确认没破坏出款页**

```bash
cd api && npm run test:e2e -- test/payout-execution.e2e-spec.ts
```

Expected: **23 个用例全过**（5h-2 的 20 条 + 本阶段补的 3 条）。

⚠️ **若有挂的**：多半是「补差金额」或「佣金口径」的断言。
逐条看是不是**口径真的变了**（该改断言）还是**实现错了**（该改代码）。

- [ ] **Step 3: 跑全量**

```bash
cd api && npm run test:e2e 2>&1 | tail -5
cd api && npm test 2>&1 | tail -5
cd api && npm run lint
```

Expected: 全绿。

- [ ] **Step 4: 提交**

```bash
git add api/src/modules/billing/payout.service.ts
git commit -m "perf(billing): 可申请周期改用批量聚合——修掉阶段 5h-2 的 L55 的 N+1"
```

---

### Task 7: 商家端「对账单」页面

**Files:**
- Create: `merchant-admin/src/lib/statement.ts`
- Create: `merchant-admin/src/lib/statement.test.ts`
- Create: `merchant-admin/src/app/(dashboard)/statements/page.tsx`
- Create: `merchant-admin/src/app/(dashboard)/statements/[period]/page.tsx`
- Modify: `merchant-admin/src/app/(dashboard)/layout.tsx`（加「对账单」导航）
- Create: `merchant-admin/test/app/statements-page.test.tsx`

- [ ] **Step 1: 写 `lib/statement.ts`**

```ts
/**
 * 对账单的类型与文案（阶段 5i）。
 *
 * ⚠️ **与后端 `api/src/modules/billing/merchant-statement.service.ts` 一一对应**。
 *
 * ⚠️ **金额一律整数分**，界面上用「元」（`lib/money.ts` 的 `centsToYuan`）。
 */
import { formatDateTime } from '@/lib/billing';
import { centsToYuan } from '@/lib/money';

/** 结算单的状态 */
export type StatementStatus = 'DRAFT' | 'CONFIRMED' | 'PAID';

/**
 * 结算单状态的中文文案（**商家侧**）。
 *
 * ⚠️ **结算单的 `PAID` 译成「已结算」，不是「已出款」** ——
 *    结算单说的是「这一期的佣金定了」，出款单说的是「钱打给你了」，
 *    两个都译成「已出款」会让商家以为是一回事。
 */
export const STATEMENT_STATUS_LABEL: Record<StatementStatus, string> = {
  DRAFT: '待确认',
  CONFIRMED: '已确认',
  PAID: '已结算',
};

/** 结算单状态 → 中文文案（未知值回落到「未知状态」） */
export function describeStatementStatus(
  status: StatementStatus | string | null,
): string {
  if (!status) return '待确认';
  return STATEMENT_STATUS_LABEL[status as StatementStatus] ?? '未知状态';
}

/** 可以申请哪种出款 */
export type ApplicableKind = 'NORMAL' | 'SUPPLEMENT';

/** 整数分 → 「¥12.34」 */
export function formatCents(cents: number): string {
  return `¥${centsToYuan(cents)}`;
}

/** 费率（基点）→ 「5%」 */
export function formatRateBps(rateBps: number): string {
  // ⚠️ **基点转百分比要保留一位小数**：500 bps = 5%，750 bps = 7.5%。
  //    `rateBps / 100` 得到的是百分数（5、7.5）→ 再拼 '%'。
  const percent = rateBps / 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;
}

/** 一期对账单 */
export interface StatementPeriod {
  /** 周期标识（`YYYY-MM`） */
  period: string;
  statementId: string | null;
  statementStatus: StatementStatus | null;
  /** 货款净额（整数分，带符号） */
  receiptAmount: number;
  receiptCount: number;
  /** 佣金净额（**带符号**：正数 = 平台抽了，负数 = 平台退了）；null = 没有结算单 */
  commissionAmount: number | null;
  commissionEntryCount: number;
  /** 商家应结；null = 佣金未知 */
  payableAmount: number | null;
  /** 已出款 */
  paidAmount: number;
  /** 在途 */
  inFlightAmount: number;
  /** 待出款；null = 应结未知 */
  pendingAmount: number | null;
  /** 已超付（> 0 = 平台多付了） */
  overpaidAmount: number;
  /** 可以申请哪种出款；null = 现在不能申请 */
  applicableKind: ApplicableKind | null;
  /** 不能申请时的原因；null = 能申请 */
  blockedReason: string | null;
}

/** 一期对账单的详情 */
export interface StatementPeriodDetail extends StatementPeriod {
  commissionEntries: Array<{
    entryId: string;
    orderNo: string;
    type: string;
    baseAmount: number;
    rateBps: number;
    amount: number;
    occurredAt: string;
  }>;
  receiptEntries: Array<{
    entryId: string;
    orderNo: string;
    type: string;
    amount: number;
    occurredAt: string;
    claimed: boolean;
  }>;
}

/** 抽佣流水类型 → 中文文案 */
export function describeCommissionEntryType(type: string): string {
  return type === 'REVERSAL' ? '抽佣冲回' : '抽佣';
}

/** 货款流水类型 → 中文文案 */
export function describeReceiptType(type: string): string {
  return type === 'SALE_REVERSAL' ? '货款冲回' : '货款入账';
}

/** 时间格式化（复用 `lib/billing.ts` 的实现） */
export { formatDateTime };
```

- [ ] **Step 2: 写 `lib/statement.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import {
  describeCommissionEntryType,
  describeReceiptType,
  describeStatementStatus,
  formatCents,
  formatRateBps,
} from '../src/lib/statement';

describe('对账单的文案与格式化', () => {
  it('结算单状态：已结算（不是「已出款」）', () => {
    expect(describeStatementStatus('PAID')).toBe('已结算');
    expect(describeStatementStatus('CONFIRMED')).toBe('已确认');
    expect(describeStatementStatus('DRAFT')).toBe('待确认');
  });

  it('⚠️ 未知状态 → 未知状态（不原样回显裸枚举）', () => {
    expect(describeStatementStatus('WHATEVER')).toBe('未知状态');
  });

  it('⚠️ null → 待确认（还没生成结算单）', () => {
    expect(describeStatementStatus(null)).toBe('待确认');
  });

  it('费率：500 bps → 5%；750 bps → 7.5%', () => {
    expect(formatRateBps(500)).toBe('5%');
    expect(formatRateBps(750)).toBe('7.5%');
  });

  it('金额：整数分 → ¥12.34', () => {
    expect(formatCents(1234)).toBe('¥12.34');
  });

  it('流水类型的中文', () => {
    expect(describeCommissionEntryType('COMMISSION')).toBe('抽佣');
    expect(describeCommissionEntryType('REVERSAL')).toBe('抽佣冲回');
    expect(describeReceiptType('SALE')).toBe('货款入账');
    expect(describeReceiptType('SALE_REVERSAL')).toBe('货款冲回');
  });
});
```

- [ ] **Step 3: 跑测试确认它过了**

```bash
cd merchant-admin && npx vitest run test/lib/statement.test.ts
```

Expected: **PASS**。

⚠️ ⚠️ **测试文件的导入路径**：项目里的 Vitest 测试在 `merchant-admin/test/` 下，
导入 `../src/lib/...` ✅（照抄 `test/lib/payout.test.ts` 的写法）。

- [ ] **Step 4: 写列表页**

`merchant-admin/src/app/(dashboard)/statements/page.tsx`：

```tsx
import Link from 'next/link';
import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import {
  describeStatementStatus,
  formatCents,
} from '@/lib/statement';
import type { StatementPeriod } from '@/lib/statement';

/**
 * 商家侧的「对账单」列表页（Server Component）。
 *
 * ⚠️ **与「出款」页的分工**：出款页是**操作**（申请、撤回），
 *    对账单页是**核对**（看构成与明细、算清我能拿多少）。
 *
 * ⚠️ **金额一律用后端返回的值** —— 前端自己加总一遍就是第二套口径，迟早漂。
 */
export default async function StatementsPage() {
  let data: StatementPeriod[] | null = null;
  let error: string | null = null;

  try {
    data = await apiFetchAuthed<StatementPeriod[]>('/merchant/statements');
  } catch (cause) {
    error =
      cause instanceof ApiError
        ? `加载对账单失败：${cause.message}`
        : cause instanceof Error
          ? cause.message
          : '对账单加载失败';
  }

  const periods = data ?? [];

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-bold">对账单</h2>
      <p className="text-sm text-muted-foreground">
        每一期平台从你的货款里抽了多少、你还该拿多少，逐笔都能核对。
        货款按流水实时统计，平台佣金以已确认的结算单为准。
      </p>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {data && (
        <>
          <p className="text-xs text-muted-foreground">共 {periods.length} 期</p>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th>周期</th>
                <th>结算单</th>
                <th>货款净额</th>
                <th>平台佣金</th>
                <th>应结金额</th>
                <th>已出款</th>
                <th>待出款</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {periods.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-4 text-muted-foreground">
                    还没有货款入账。
                  </td>
                </tr>
              ) : (
                periods.map((item) => (
                  <tr key={item.period} className="border-b">
                    <td>
                      <Link href={`/statements/${item.period}`} className="underline">
                        {item.period}
                      </Link>
                    </td>
                    <td>{describeStatementStatus(item.statementStatus)}</td>
                    <td>{formatCents(item.receiptAmount)}</td>
                    {/* ⚠️ **佣金是带符号的**：负数 = 平台退回了佣金 */}
                    <td>
                      {item.commissionAmount === null
                        ? '—'
                        : formatCents(item.commissionAmount)}
                    </td>
                    <td>
                      {item.payableAmount === null
                        ? '—'
                        : formatCents(item.payableAmount)}
                    </td>
                    <td>{formatCents(item.paidAmount)}</td>
                    <td>
                      {item.pendingAmount === null
                        ? '—'
                        : formatCents(item.pendingAmount)}
                    </td>
                    <td>
                      {item.overpaidAmount > 0 ? (
                        <span className="text-destructive">
                          已超付 {formatCents(item.overpaidAmount)}，待平台调账
                        </span>
                      ) : item.blockedReason ? (
                        <span className="text-muted-foreground">
                          {item.blockedReason}
                        </span>
                      ) : item.applicableKind === 'SUPPLEMENT' ? (
                        '可申请补差'
                      ) : item.applicableKind === 'NORMAL' ? (
                        '可申请出款'
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 5: 写详情页**

`merchant-admin/src/app/(dashboard)/statements/[period]/page.tsx`：

```tsx
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import {
  describeCommissionEntryType,
  describeReceiptType,
  describeStatementStatus,
  formatCents,
  formatDateTime,
  formatRateBps,
} from '@/lib/statement';
import type { StatementPeriodDetail } from '@/lib/statement';

/**
 * 商家侧的「对账单」详情页（Server Component）。
 *
 * ⚠️ **两段明细的加总分别等于两个汇总数** ——
 *    抽佣明细加总 = 佣金净额；货款明细加总 = 货款净额。
 *    商家能自己核对（设计 §5.3 的自洽性）。
 */
export default async function StatementDetailPage({
  params,
}: {
  params: Promise<{ period: string }>;
}) {
  const { period } = await params;

  let data: StatementPeriodDetail | null = null;
  let error: string | null = null;

  try {
    data = await apiFetchAuthed<StatementPeriodDetail>(
      `/merchant/statements/${period}`,
    );
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 404) {
      notFound();
    }
    error =
      cause instanceof ApiError
        ? `加载对账单失败：${cause.message}`
        : cause instanceof Error
          ? cause.message
          : '对账单加载失败';
  }

  if (!data) {
    return (
      <div className="flex flex-col gap-6">
        <h2 className="text-2xl font-bold">对账单</h2>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">对账单 {data.period}</h2>
        <Link href="/statements" className="underline">
          返回列表
        </Link>
      </div>

      <div className="flex flex-col gap-1 text-sm">
        <p>
          结算单：{describeStatementStatus(data.statementStatus)}
        </p>
        <p>
          货款净额 {formatCents(data.receiptAmount)} · 平台佣金{' '}
          {data.commissionAmount === null
            ? '待确认'
            : formatCents(data.commissionAmount)}{' '}
          · 应结金额{' '}
          {data.payableAmount === null
            ? '待确认'
            : formatCents(data.payableAmount)}
        </p>
        <p>
          已出款 {formatCents(data.paidAmount)}
          {data.inFlightAmount > 0 &&
            ` · 在途 ${formatCents(data.inFlightAmount)}`}
          {data.pendingAmount !== null &&
            ` · 待出款 ${formatCents(data.pendingAmount)}`}
        </p>
        {data.overpaidAmount > 0 && (
          <p className="text-destructive">
            本期已超付 {formatCents(data.overpaidAmount)}，待平台调账。
          </p>
        )}
        {data.blockedReason && (
          <p className="text-muted-foreground">{data.blockedReason}</p>
        )}
        <p className="text-xs text-muted-foreground">
          货款按流水实时统计，平台佣金以已确认的结算单为准；结算单确认之后回填的货款会走补差出款。
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-lg font-semibold">抽佣明细</h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th>时间</th>
              <th>订单号</th>
              <th>类型</th>
              <th>计佣基数</th>
              <th>费率</th>
              <th>佣金</th>
            </tr>
          </thead>
          <tbody>
            {data.commissionEntries.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-4 text-muted-foreground">
                  该期没有抽佣明细。
                </td>
              </tr>
            ) : (
              data.commissionEntries.map((entry) => (
                <tr key={entry.entryId} className="border-b">
                  <td>{formatDateTime(entry.occurredAt)}</td>
                  <td>{entry.orderNo}</td>
                  <td>{describeCommissionEntryType(entry.type)}</td>
                  <td>{formatCents(entry.baseAmount)}</td>
                  <td>{formatRateBps(entry.rateBps)}</td>
                  <td>{formatCents(entry.amount)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-lg font-semibold">货款明细</h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th>时间</th>
              <th>订单号</th>
              <th>类型</th>
              <th>金额</th>
              <th>是否已出款</th>
            </tr>
          </thead>
          <tbody>
            {data.receiptEntries.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-4 text-muted-foreground">
                  该期没有货款流水。
                </td>
              </tr>
            ) : (
              data.receiptEntries.map((entry) => (
                <tr key={entry.entryId} className="border-b">
                  <td>{formatDateTime(entry.occurredAt)}</td>
                  <td>{entry.orderNo}</td>
                  <td>{describeReceiptType(entry.type)}</td>
                  <td>{formatCents(entry.amount)}</td>
                  <td>{entry.claimed ? '已出款' : '未出款'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: 加导航项**

`merchant-admin/src/app/(dashboard)/layout.tsx` 的 `<nav>` 里，
在「出款」那行**之前**加：

```tsx
            <Link href="/statements" className="underline-offset-4 hover:underline">
              对账单
            </Link>
```

- [ ] **Step 7: 写页面测试**

⚠️ **遍历元素树而不是渲染 HTML**（照 `payouts-page.test.tsx` 的做法）：
页面上有 `next/link`，在 Next 运行时之外渲染它可能抛错。
⚠️ **`@/auth` 必须 mock 掉** —— `@/lib/api-client` 会 import 它，
而 `next-auth` 会间接 import `next/server` → `ERR_MODULE_NOT_FOUND`。

`merchant-admin/test/app/statements-page.test.tsx`：

```tsx
/**
 * 商家侧对账单列表页（Server Component）的页面级测试。
 *
 * ⚠️ **遍历元素树而不是渲染 HTML**：页面上有 `next/link`，
 * 在 Next 运行时之外渲染它可能抛错。直接 `await StatementsPage(...)`
 * 拿到元素树，只读 `props.children`，**不执行任何组件函数**。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn() }));

const { apiFetchAuthedMock } = vi.hoisted(() => ({
  apiFetchAuthedMock: vi.fn(),
}));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>(
    '@/lib/api-client',
  );
  return {
    ...actual,
    apiFetchAuthed: apiFetchAuthedMock,
  };
});

import StatementsPage from '@/app/(dashboard)/statements/page';
import type { StatementPeriod } from '@/lib/statement';

import { collectHrefs, collectText, hasText } from '../helpers/page-tree';

/**
 * ⚠️ **三个金额刻意用三个不同的数值**（货款 ¥5.00 / 佣金 ¥3.00 / 应结 ¥9.00）：
 * 前端若自己加总（5.00 − 3.00 = 2.00），与后端给的 ¥9.00 不同 → 能锁住。
 */
const PERIOD: StatementPeriod = {
  period: '2026-08',
  statementId: 'statement-1',
  statementStatus: 'CONFIRMED',
  receiptAmount: 500,
  receiptCount: 2,
  commissionAmount: 300,
  commissionEntryCount: 1,
  payableAmount: 900,
  paidAmount: 0,
  inFlightAmount: 0,
  pendingAmount: 900,
  overpaidAmount: 0,
  applicableKind: 'NORMAL',
  blockedReason: null,
};

async function renderPage(): Promise<string[]> {
  const element = await StatementsPage();
  return collectText(element);
}

async function renderHrefs(): Promise<string[]> {
  const element = await StatementsPage();
  return collectHrefs(element);
}

beforeEach(() => {
  vi.clearAllMocks();
  apiFetchAuthedMock.mockResolvedValue([PERIOD]);
});

describe('对账单列表页：取数', () => {
  it('打到商家侧的 /merchant/statements（不是平台侧）', async () => {
    await renderPage();

    expect(apiFetchAuthedMock).toHaveBeenCalledTimes(1);
    const [path] = apiFetchAuthedMock.mock.calls[0] as [string];
    // ⚠️ **精确匹配而不是 `toContain`**：路径写歪了照样绿。
    expect(path).toBe('/merchant/statements');
  });
});

describe('对账单列表页：金额一律用后端返回的值', () => {
  it('⚠️ 应结金额是后端给的值，不是前端把货款与佣金加总出来的', async () => {
    const texts = await renderPage();

    // ⚠️ **这条是护栏「前端不自己算金额」的直接锁**：
    // 后端给的应结是 900 分 → ¥9.00；前端自己加总是 500 − 300 = 200 分 → ¥2.00。
    expect(hasText(texts, '¥9.00')).toBe(true);
    expect(hasText(texts, '¥2.00')).toBe(false);
  });

  it('货款净额与平台佣金也分别显示出来', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '¥5.00')).toBe(true);
    expect(hasText(texts, '¥3.00')).toBe(true);
  });

  it('⚠️ 表头把货款净额 / 平台佣金 / 应结金额三列分开列出来', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '货款净额')).toBe(true);
    expect(hasText(texts, '平台佣金')).toBe(true);
    expect(hasText(texts, '应结金额')).toBe(true);
  });
});

describe('对账单列表页：状态与可申请性', () => {
  it('结算单状态显示中文（已确认）', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '已确认')).toBe(true);
    expect(hasText(texts, 'CONFIRMED')).toBe(false);
  });

  it('⚠️ 结算单已结算时显示「已结算」（不是「已出款」—— 那是出款单的说法）', async () => {
    apiFetchAuthedMock.mockResolvedValue([
      { ...PERIOD, statementStatus: 'PAID' as const },
    ]);

    const texts = await renderPage();

    expect(hasText(texts, '已结算')).toBe(true);
    expect(hasText(texts, '已出款')).toBe(false);
  });

  it('可申请时显示「可申请出款」', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '可申请出款')).toBe(true);
  });

  it('⚠️ 可申请补差时显示「可申请补差」（与出款页同一套判定）', async () => {
    apiFetchAuthedMock.mockResolvedValue([
      { ...PERIOD, applicableKind: 'SUPPLEMENT' as const },
    ]);

    const texts = await renderPage();

    expect(hasText(texts, '可申请补差')).toBe(true);
  });

  it('⚠️ 不能申请时显示原因（商家要知道为什么）', async () => {
    apiFetchAuthedMock.mockResolvedValue([
      {
        ...PERIOD,
        applicableKind: null,
        blockedReason: '该期的结算单尚未确认',
      },
    ]);

    const texts = await renderPage();

    expect(hasText(texts, '该期的结算单尚未确认')).toBe(true);
  });

  it('⚠️ 超付时显示超付金额与「待平台调账」', async () => {
    apiFetchAuthedMock.mockResolvedValue([
      { ...PERIOD, overpaidAmount: 8500, pendingAmount: 0 },
    ]);

    const texts = await renderPage();

    expect(hasText(texts, '已超付')).toBe(true);
    expect(hasText(texts, '待平台调账')).toBe(true);
  });
});

describe('对账单列表页：取数失败与空数据', () => {
  it('⚠️ 取数失败时显示错误提示，且不崩', async () => {
    const { ApiError } = await vi.importActual<
      typeof import('@/lib/api-client')
    >('@/lib/api-client');
    apiFetchAuthedMock.mockRejectedValue(
      new ApiError(500, 'INTERNAL', '后端炸了'),
    );

    const texts = await renderPage();

    expect(hasText(texts, '加载对账单失败')).toBe(true);
    expect(hasText(texts, '后端炸了')).toBe(true);
  });

  it('没有对账单时显示「还没有货款入账。」而不是空白表', async () => {
    apiFetchAuthedMock.mockResolvedValue([]);

    const texts = await renderPage();

    expect(hasText(texts, '还没有货款入账。')).toBe(true);
  });
});

describe('对账单列表页：详情页链接', () => {
  it('⚠️ 每一行都有指向详情页的链接（商家要能点进去看明细）', async () => {
    const hrefs = await renderHrefs();

    expect(hrefs).toContain('/statements/2026-08');
  });
});
```

`merchant-admin/test/app/statement-detail-page.test.tsx`：

```tsx
/**
 * 商家侧对账单详情页（Server Component）的页面级测试。
 *
 * ⚠️ **`notFound` 必须 mock 掉** —— 真实实现会抛 `NEXT_NOT_FOUND`，
 *    在测试进程里那就是一个普通异常。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn() }));

const { apiFetchAuthedMock, notFoundMock } = vi.hoisted(() => ({
  apiFetchAuthedMock: vi.fn(),
  notFoundMock: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>(
    '@/lib/api-client',
  );
  return {
    ...actual,
    apiFetchAuthed: apiFetchAuthedMock,
  };
});

vi.mock('next/navigation', () => ({ notFound: notFoundMock }));

import StatementDetailPage from '@/app/(dashboard)/statements/[period]/page';
import type { StatementPeriodDetail } from '@/lib/statement';

import { collectText, hasText } from '../helpers/page-tree';

const DETAIL: StatementPeriodDetail = {
  period: '2026-08',
  statementId: 'statement-1',
  statementStatus: 'CONFIRMED',
  receiptAmount: 500,
  receiptCount: 2,
  commissionAmount: 300,
  commissionEntryCount: 1,
  payableAmount: 900,
  paidAmount: 0,
  inFlightAmount: 0,
  pendingAmount: 900,
  overpaidAmount: 0,
  applicableKind: 'NORMAL',
  blockedReason: null,
  commissionEntries: [
    {
      entryId: 'entry-1',
      orderNo: 'ORD-001',
      type: 'COMMISSION',
      baseAmount: 10000,
      rateBps: 500,
      amount: 500,
      occurredAt: '2026-08-10T00:00:00.000Z',
    },
  ],
  receiptEntries: [
    {
      entryId: 'receipt-1',
      orderNo: 'ORD-001',
      type: 'SALE',
      amount: 10000,
      occurredAt: '2026-08-10T00:00:00.000Z',
      claimed: true,
    },
    {
      entryId: 'receipt-2',
      orderNo: 'ORD-002',
      type: 'SALE',
      amount: 5000,
      occurredAt: '2026-08-20T00:00:00.000Z',
      claimed: false,
    },
  ],
};

async function renderPage(): Promise<string[]> {
  const element = await StatementDetailPage({
    params: Promise.resolve({ period: '2026-08' }),
  });
  return collectText(element);
}

beforeEach(() => {
  vi.clearAllMocks();
  apiFetchAuthedMock.mockResolvedValue(DETAIL);
});

describe('对账单详情页：取数', () => {
  it('打到商家侧的 /merchant/statements/:period', async () => {
    await renderPage();

    const [path] = apiFetchAuthedMock.mock.calls[0] as [string];
    expect(path).toBe('/merchant/statements/2026-08');
  });

  it('⚠️ 404 时调 notFound（而不是渲染一个空页）', async () => {
    const { ApiError } = await vi.importActual<
      typeof import('@/lib/api-client')
    >('@/lib/api-client');
    apiFetchAuthedMock.mockRejectedValue(
      new ApiError(404, 'NOT_FOUND', '该期没有货款流水'),
    );

    await expect(renderPage()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFoundMock).toHaveBeenCalledTimes(1);
  });
});

describe('对账单详情页：抽佣明细含费率', () => {
  it('⚠️ 费率显示成百分比（500 bps → 5%）', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '5%')).toBe(true);
    expect(hasText(texts, '500 bps')).toBe(false);
  });

  it('抽佣明细显示订单号与类型', async () => {
    const texts = await renderPage();

    expect(hasText(texts, 'ORD-001')).toBe(true);
    expect(hasText(texts, '抽佣')).toBe(true);
  });

  it('⚠️ 计佣基数与佣金金额分别显示', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '¥100.00')).toBe(true);
    expect(hasText(texts, '¥5.00')).toBe(true);
  });
});

describe('对账单详情页：货款明细标出是否已出款', () => {
  it('⚠️ 已出款与未出款分别标出来（商家要能对上哪些钱已经拿到了）', async () => {
    const texts = await renderPage();

    expect(hasText(texts, '已出款')).toBe(true);
    expect(hasText(texts, '未出款')).toBe(true);
  });
});

describe('对账单详情页：口径说明', () => {
  it('⚠️ 页面说明「货款按流水实时统计、佣金以已确认结算单为准」', async () => {
    const texts = await renderPage();

    // ⚠️ **这句不能省** —— 商家看到「应结」会变，必须知道为什么。
    expect(hasText(texts, '货款按流水实时统计')).toBe(true);
    expect(hasText(texts, '平台佣金以已确认的结算单为准')).toBe(true);
  });
});
```

- [ ] **Step 8: 跑前端测试**

```bash
cd merchant-admin && npx vitest run test/lib/statement.test.ts test/app/statements-page.test.tsx
cd merchant-admin && npm test 2>&1 | tail -5
```

Expected: 全绿。

- [ ] **Step 9: 提交**

```bash
git add merchant-admin/src/lib/statement.ts merchant-admin/src/lib/statement.test.ts \
        merchant-admin/src/app/\(dashboard\)/statements \
        merchant-admin/src/app/\(dashboard\)/layout.tsx \
        merchant-admin/test/app/statements-page.test.tsx
git commit -m "feat(merchant-admin): 对账单页——每期的货款、佣金（含费率）与逐笔明细"
```

---

### Task 8: 失败注入 + 浏览器手测 + 验收记录

**Files:**
- Modify: `api/test/ledger-reconciliation.e2e-spec.ts`（补 e2e 用例）
- Create: `docs/superpowers/plans/2026-10-30-plan-05i-ledger-reconciliation-acceptance.md`

⚠️ **本 Task 的 e2e 用例要先写完并跑绿**，再做失败注入。

- [ ] **Step 1: 补 e2e 用例**

往 `api/test/ledger-reconciliation.e2e-spec.ts` 里加这些用例（商家侧）：

| # | 用例 | 验证的护栏 |
|---|------|-----------|
| 1 | 商家看到某期的对账单：货款、佣金、应结三个数与出款页**逐分相等** | S4 |
| 2 | 商家 A 访问商家 B 的期 → 404 | S1 |
| 3 | 抽佣明细加总 = 佣金净额 | S2 |
| 4 | 货款明细加总 = 货款净额 | S3 |
| 5 | 同一期，出款页说「可申请补差」时，对账单也说 `applicableKind = 'SUPPLEMENT'` | S4 |
| 6 | 结算单未确认的期 → 对账单说「不可申请」且给出原因 | — |
| 8 | 报表切到流水表后与切前逐分相等（**Task 3 已覆盖，此处复跑确认**）| S5 |
| 7 | 同月内退款 → 已出款 > 应结 → `overpaidAmount > 0` 且 `pendingAmount = 0` | S7 |

⚠️ **用例 1 与 5 的关键**：出款页的 `available-periods` 与对账单的
`/merchant/statements` 要**对比着断言** → 这才是 S4 的真正含义。

⚠️ **月份**：用 `2025-08 ~ 2026-09` 区间里没用过的月份。

- [ ] **Step 2: 跑 e2e 确认全绿**

```bash
cd api && npm run test:e2e -- test/ledger-reconciliation.e2e-spec.ts
```

Expected: 全绿。

- [ ] **Step 3: 失败注入 I1–I9**

⚠️ **逐条做，改一处 → 跑 → 确认目标用例挂 → 还原 → 确认又过**。

| # | 注入点 | 必须挂掉的用例 |
|---|--------|--------------|
| I1 | 报表的冲回不取负（`toReportAmounts` 的 `reversal` 改成 `reversalSum`） | 「冲回的口径是正数要减」 |
| I2 | 报表的抽佣收入仍读 `orders` | 「按流水的归期算」 |
| I3 | 对账单的抽佣明细改成按期实时聚合 | 「抽佣明细加总 = 佣金净额」 |
| I4 | 对账单的佣金改成实时聚合 | 「应结 = 货款 − 佣金」 |
| I5 | 商家接口不校验 `statementId` 归属 | 「商家 A 看商家 B 的期」 |
| I6 | 自检脚本把零额抽佣或零额冲回算成缺口（**跑 `npx jest test/check-ledger.spec.ts`**）| 「零额订单不算缺口」（S6）|
| I7 | 「已出款 / 在途 / 待出款」把在途并进待出款 | 「待出款 = 应结 − 已出款 − 在途」 |
| I8 | 超付时抛错而不是显示 `overpaidAmount` | 「超付时待出款是 0 且不报错」 |
| I9 | 对账单的 `applicableKind` 照列表页的筛选写 | 「两个接口给出相同的结论」 |

⚠️ **每条注入后必须 `git checkout -- <文件>` 还原**，并 `git status --short` 确认干净。

⚠️ **I6 改的是脚本的判定逻辑** → 跑的是 `npx jest test/check-ledger.spec.ts`。

- [ ] **Step 4: 浏览器手测**

⚠️ **手测前要改 `infra/docker-compose.yml`**（手测完还原）：

```yaml
    environment:
      NODE_ENV: development
      FAKE_PAYOUT_ENABLED: 'true'
      PAYOUT_RETRY_BASE_DELAY_MS: '2000'
```

```bash
cd infra && docker compose up -d --build api merchant-admin platform-admin
```

⚠️ **必须 rebuild** —— 源码在镜像里，旧镜像没有本阶段的代码。

手测步骤（商家端 `http://localhost:3002`，平台端 `http://127.0.0.1:3003`）：

| # | 手测项 | 预期 |
|---|--------|------|
| 1 | 商家进「对账单」 | 列出所有有货款的期 |
| 2 | 点进某一期 | 货款、佣金、应结三个数与出款页**一致** |
| 3 | 看抽佣明细 | 每笔有费率；**加总 = 佣金净额** |
| 4 | 看货款明细 | 每笔标了「已出款 / 未出款」 |
| 5 | 平台超管看报表 | 数字与切前一致（用同期的结算单核对） |
| 6 | 商家在出款页申请一期 | 与对账单显示的「应结」相同 |

⚠️ **手测完还原 compose**：

```bash
cd .. && git checkout -- infra/docker-compose.yml
cd infra && docker compose up -d api
```

⚠️ **清理手测数据**（按外键依赖顺序删）：

```sql
DELETE FROM payout_entries WHERE "payoutId" IN (SELECT id FROM payouts WHERE "tenantId" = '<商家>');
DELETE FROM payouts WHERE "tenantId" = '<商家>';
DELETE FROM settlement_statement_entries WHERE "statementId" IN (SELECT id FROM settlement_statements WHERE "tenantId" = '<商家>');
DELETE FROM settlement_statements WHERE "tenantId" = '<商家>';
DELETE FROM commission_entries WHERE "tenantId" = '<商家>';
DELETE FROM merchant_receipts WHERE "tenantId" = '<商家>';
```

- [ ] **Step 5: 写验收记录**

`docs/superpowers/plans/2026-10-30-plan-05i-ledger-reconciliation-acceptance.md`，
照 5h-2 的格式（§一 概览 / §二 关键口径 / §三 手测 / §四 护栏核对 + 失败注入 /
§五 发现的缺陷 / §六 遗留项 / §七 复现方法）。

⚠️ **失败注入的表格要逐条写**：注入点、目标用例、实测挂了几条、**是不是符合预期**。
⚠️ **「挂 0 条」要逐条查清原因**（5g/5h-2 的教训：挂 0 条通常是「测试没覆盖到
那个形状」或「注入写错了」，不是「护栏不存在」）。

- [ ] **Step 6: 跑全量测试并提交**

```bash
cd api && npm test 2>&1 | tail -5
cd api && npm run test:e2e 2>&1 | tail -5
cd api && npm run lint
cd merchant-admin && npm test 2>&1 | tail -5
cd platform-admin && npm test 2>&1 | tail -5
```

```bash
git add api/test/ledger-reconciliation.e2e-spec.ts \
        docs/superpowers/plans/2026-10-30-plan-05i-ledger-reconciliation-acceptance.md
git commit -m "docs: 阶段 5i 验收记录——报表口径切换与商家侧对账单"
```

---

## §0.4 实施期注意（按 Task 给子代理的提醒）

| Task | 提醒 |
|------|------|
| 1 | 纯函数**不许碰数据库**；金额全整数分；`toReportAmounts` 的符号不变体要抛错 |
| 2 | 判定规则**必须排除零额订单**（回填在零额时提前 return）→ 否则脚本永远 exit 1 |
| 3 | ⚠️ **切前切后一致时，同一个断言两边都过** → 必须造「订单支付期 ≠ 流水归期」的数据才能区分两个口径 |
| 4 | 查询次数与期数**无关**；`settlement_statement_entries` / `payout_entries` 用 id 列表限定 |
| 5 | 佣金是**冻结值**、货款是**实时值**；明细必须与汇总自洽 |
| 6 | **返回结构不变** → 前端不用改；`commissionAmount` 用 `?? 0` 兜（可能是负数） |
| 7 | `params` 是 `Promise`（Next 15）→ 要 `await`；结算单 `PAID` 译成「已结算」 |
| 8 | 注入后必须还原并核实 `git status` 干净；「挂 0 条」要查清原因再下结论 |

## §0.5 已知的坑（来自设计与实施期）

1. **`tenantContext.run` 的回调必须是 async**（同步回调 → 租户隔离静默失效）。
2. **`commission_entries` 在租户白名单、`settlement_statement_entries` 与
   `payout_entries` 不在** → 后两者必须用 id 列表限定。
3. **报表的 `reversal` 是正数、流水表的 `reversalAmount` 是负数** —— 符号写反净收入翻倍。
4. **结算单的 `netAmount` 是佣金净额，出款单的 `netAmount` 是商家应结** —— 别混。
5. **佣金净额可以是负数**（只有冲回没有抽佣的期）→ 前端 `lib/payout.ts` 的
   「佣金都是正数」注释不准确（R10，本阶段不改）。
6. **`payouts` 的部分唯一索引覆盖 `PAID`** → 查已出款的单能走索引，不需要加索引。
7. **零佣金商家永远没有结算单** → 对账单要说「本期无平台佣金」，不能让商家以为漏出单。
8. **本机开发库的订单佣金全是 0** → 验证报表切换必须造有佣金的订单（订阅 trial 套餐）。
