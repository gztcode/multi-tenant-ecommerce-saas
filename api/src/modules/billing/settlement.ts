import { BadRequestException } from '@nestjs/common';
import { CommissionEntryType } from '@prisma/client';

/**
 * 结算单的纯函数（阶段 5g）。
 *
 * ⚠️ **本文件是纯函数**：不碰数据库、不读上下文。
 * 与 `commission.ts`（抽佣计算）同款理由 ——
 * **计钱的每一条分支都要能被完整断言**。
 *
 * ⚠️ **全程整数域**：金额一律整数分。
 */

/** 一个自然月的区间 */
export interface MonthlyPeriod {
  /** 区间起点（含）。该月 1 日 00:00:00.000Z */
  from: Date;
  /** 区间终点（不含）。次月 1 日 00:00:00.000Z */
  to: Date;
  /** 周期标识（`YYYY-MM`） */
  label: string;
}

/**
 * `YYYY-MM` → 该自然月的区间（左闭右开）。
 *
 * ⚠️ **为什么用 `YYYY-MM` 而不是 `from` / `to`**：
 * 调用方自己算月边界容易算错（时区、月末是 30 号还是 31 号），
 * 而「2026 年 10 月」是超管的真实心智。用 `YYYY-MM` 后，
 * **月边界只由后端算一次**，前端与 CLI 都不需要知道月末是几号。
 *
 * ⚠️ **区间是左闭右开 `[from, to)`**：与 `CommissionService.ledger` /
 *    `ReportService.summary` 同一套区间语义（相邻两期不重不漏）。
 */
export function resolveMonthlyPeriod(period: string): MonthlyPeriod {
  const matched = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (!matched) {
    throw new BadRequestException('周期格式非法：必须是 YYYY-MM（如 2026-10）');
  }
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  // ⚠️ **年份必须在 [1000, 9998] 之间**：
  //    ① `Date.UTC` 会把 0–99 的年份映射到 1900+年（`Date.UTC(1, 0, 1)` = 1901 年），
  //    那会让「标签是 0001-01、区间却是 1901 年 1 月」—— 标签与区间不一致，
  //    而且全程不报错；
  //    ② 上界留出余量，避免终点落到 `+010000-` 这种扩展年份格式。
  if (year < 1000 || year > 9998) {
    throw new BadRequestException(
      `周期年份超出范围：必须是 1000 到 9998 之间的年份（收到 ${year}）`,
    );
  }
  // ⚠️ **`Date.UTC` 的月份是从 0 起的**：`month - 1` 是本月，`month` 是次月。
  //    写错就是差一个月（10 月的区间算成 11 月）。
  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 1));
  return { from, to, label: period };
}

/**
 * 从周期起点反推出周期标识。
 *
 * ⚠️ **用 UTC 的年月日**：整个系统的时间都是 UTC
 * （数据库的 `now()`、流水的 `occurredAt`），用本地时区会差 8 小时。
 */
export function formatPeriodLabel(periodStart: Date): string {
  // ⚠️ **非法 Date 要当场炸**：`getUTCFullYear()` / `getUTCMonth()` 对
  //    `Invalid Date` 返回 `NaN`，`padStart` 对 `NaN` 不生效 ——
  //    不检查就会返回 `'NaN-NaN'` 这种标签，一路带着它跑到前端。
  if (Number.isNaN(periodStart.getTime())) {
    throw new Error('周期起点不是合法的时间');
  }
  const year = periodStart.getUTCFullYear();
  const month = String(periodStart.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/** 一笔待纳入结算单的流水（只需要类型与金额） */
export interface SettleableEntry {
  type: CommissionEntryType;
  /** 带符号：抽佣为正、冲回为负 */
  amount: number;
}

/** 结算单的三个金额 */
export interface SettlementAmounts {
  /** 抽佣毛额（整数分）。恒 >= 0 */
  grossAmount: number;
  /**
   * 退款冲回（整数分）。恒 <= 0。
   *
   * ⚠️ **与平台收入报表的 `reversal` 符号相反** ——
   *    报表那边是**正数**（`netRevenue = commissionRevenue − reversal`），
   *    结算单这边是**负数**（`netAmount = grossAmount + reversalAmount`）。
   *    拿报表的公式去套结算单的字段，净额会翻倍。
   */
  reversalAmount: number;
  /** 净额 = grossAmount + reversalAmount。**可以是负数** */
  netAmount: number;
  /** 纳入的流水笔数 */
  entryCount: number;
}

/**
 * 把一批流水算成结算单的三个金额。
 *
 * ⚠️ **冲回不要再取一次负**：流水的 `REVERSAL.amount` 本身就是负数
 * （5e 的 N2 护栏），再取负会让净额翻倍。
 *
 * ⚠️ **净额可以是负数**：某商家本期只有一笔退款冲回、没有新的抽佣，
 * 那这一期平台「倒欠」商家钱。负数是合法结果，不是错误。
 */
export function summarizeEntries(
  entries: SettleableEntry[],
): SettlementAmounts {
  let grossAmount = 0;
  let reversalAmount = 0;
  for (const entry of entries) {
    if (entry.type === CommissionEntryType.COMMISSION) {
      grossAmount += entry.amount;
    } else if (entry.type === CommissionEntryType.REVERSAL) {
      reversalAmount += entry.amount;
    } else {
      // ⚠️ **枚举扩容时在这里炸出来**，而不是把新类型静默算成冲回 ——
      //    「冲回恒 ≤ 0」的不变量一旦被破坏，账就直接算错了。
      //    ⚠️ 用 `String(...)` 而不是模板字符串：这里的 `entry.type` 被 TS 收窄成
      //    `never`，而 eslint 的 `restrict-template-expressions` 不允许 `never` 进模板串。
      throw new Error(`未知的流水类型：${String(entry.type)}`);
    }
  }
  // ⚠️ **不变量护栏**：毛额恒 >= 0、冲回恒 <= 0。
  //    符号写反或枚举扩容时，这里立刻炸，而不是算出一张错账。
  if (grossAmount < 0 || reversalAmount > 0) {
    throw new Error(
      `流水符号异常：毛额 ${grossAmount}，冲回 ${reversalAmount}`,
    );
  }
  return {
    grossAmount,
    reversalAmount,
    netAmount: grossAmount + reversalAmount,
    entryCount: entries.length,
  };
}
