import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CommissionEntryType,
  PayoutStatus,
  SettlementStatus,
  type CommissionEntry,
  type SettlementStatement,
} from '@prisma/client';

import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import {
  platformScope,
  tenantContext,
} from '../../common/tenant/tenant-context';
import { isUniqueViolation } from '../../common/errors/unique-constraint';
import {
  formatPeriodLabel,
  resolveMonthlyPeriod,
  summarizeEntries,
  type MonthlyPeriod,
} from './settlement';

/** 结算单对外的形状（列表与详情共用） */
export interface SettlementView {
  id: string;
  tenantId: string;
  tenantName: string;
  subdomain: string;
  statementNo: string;
  /** 周期起点（含）。ISO 8601 */
  periodStart: string;
  /** 周期终点（不含）。ISO 8601 */
  periodEnd: string;
  /** 周期标识（`YYYY-MM`） */
  periodLabel: string;
  /** 抽佣毛额（整数分） */
  grossAmount: number;
  /**
   * 退款冲回（整数分，**负数**）。
   *
   * ⚠️ **与平台收入报表的 `reversal` 符号相反** ——
   *    报表那边是**正数**（`netRevenue = commissionRevenue − reversal`），
   *    结算单这边是**负数**（`netAmount = grossAmount + reversalAmount`）。
   *    拿报表的公式去套结算单的字段，净额会翻倍。
   */
  reversalAmount: number;
  /** 净额（整数分，可以是负数） */
  netAmount: number;
  /** 纳入的流水笔数 */
  entryCount: number;
  /**
   * 这一期「缺笔」的数量：当期真实流水笔数 − 结算单纳入的笔数。
   *
   * ⚠️ **0 = 不缺笔**。
   * ⚠️ **只比笔数** —— 抽佣流水是 append-only（`commission_entries` 全仓没有
   *    update / upsert），笔数没变 ⇒ 纳入的集合没变 ⇒ 金额也没变。
   *    ⚠️ 若将来流水变得可变（可改金额 / 可改归期），这里必须改成比金额之和。
   */
  missingEntryCount: number;
  status: SettlementStatus;
  /** 确认时间。ISO 8601。null = 未确认 */
  confirmedAt: string | null;
  /** ISO 8601 */
  createdAt: string;
}

/** 生成结算单的结果 */
export interface GenerateSettlementResult {
  /** 本次涉及的商家对应的单据（新建的 + 因幂等而复用的） */
  items: SettlementView[];
  /** 新建了几张 */
  created: number;
  /** 因「该期已有单据」而复用了几张 */
  skipped: number;
  /**
   * 批量生成时**没能出单**的商家（冲突）。
   *
   * ⚠️ **批量模式不因为一个商家出错就中断整批**：每个商家各自提交事务，
   *    前面的商家已经落库了，中途抛 409 会让调用方**无从得知哪几张已生成**，
   *    重跑又会走幂等分支返回旧单 —— 差异更看不出来。
   *    所以冲突在这里**收集**起来，成功的那几张照常返回。
   *
   * ⚠️ **包含两类**：
   *    ① 409 冲突（流水已被别的结算单结算过）；
   *    ② 该商家在这一期**查不到流水**（没出单）。
   *    两类都要**看得见** —— 静默少一个商家，调用方无从得知。
   *
   * ⚠️ **显式点名单个商家时不会走到这里**：调用方明确知道是哪一家，
   *    直接抛 409 / 404 更直接。
   */
  conflicts: Array<{ tenantId: string; message: string }>;
  /**
   * **过时**的商家 id（列表）。
   *
   * ⚠️ **「该期已有单据」不代表这张单还是对的**：该期后来又进了流水
   *    （比如跑了一次 `npm run backfill:commissions`），复用出来的旧单就
   *    **缺笔**了。不标出来的话调用方看到 `skipped: 1` 就以为「本期已结清」，
   *    实际金额是错的。
   *
   * ⚠️ **只标记，不改单据**：已 `CONFIRMED` 的单据是冻结的，不能动。
   *    需要修正的话走「取消确认 → 重算」。
   */
  stale: string[];
}

/** 结算单详情（含明细行） */
export interface SettlementDetailView extends SettlementView {
  /**
   * 本期能不能通过「取消确认 → 重算」修正。
   *
   * ⚠️ **取决于有没有出款单引用**（P6 闸）：
   *    有出款单引用时 `unconfirm` 会被 409 拦下 → 只能走调账流程。
   */
  canRecalculate: boolean;
  entries: Array<{
    entryId: string;
    orderNo: string;
    type: CommissionEntryType;
    amount: number;
    rateBps: number;
    baseAmount: number;
    occurredAt: string;
  }>;
}

/** 单号撞了最多重试几次 */
const MAX_NUMBER_ATTEMPTS = 5;

/**
 * 结算单的服务（阶段 5g）。
 *
 * ⚠️ **数据只从 `commission_entries` 来**，不从订单重新聚合 ——
 *    报表那套口径抄一遍必然漂（设计文档 §2.1）。
 *
 * ⚠️ **必须显式走平台作用域**（跨租户聚合）：控制器上的 `@Roles` 管的是
 *    「谁能调」，管不了「service 在什么作用域里查库」。
 *    不显式声明的话，被商家上下文调用时会**静默只统计一个租户的数据**。
 *
 * ⚠️ **金额符号口径**：本服务的 `reversalAmount` 恒 ≤ 0（冲回是负数），
 *    `netAmount = grossAmount + reversalAmount`。
 *    平台收入报表那边是**相反的符号**（`reversal` 恒 ≥ 0，
 *    `netRevenue = commissionRevenue − reversal`）——
 *    两者混用会让净额翻倍，详见 `SettlementAmounts` 的注释。
 */
@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  constructor(private readonly prisma: TenantPrismaService) {}

  /**
   * 生成某期的结算单。
   *
   * ⚠️ **周期必须已结束**（设计 D7）：周期内的流水还会变，
   *    此时的数字不是凭证。周期末流水本就齐了（抽佣按支付期、冲回按退款期、
   *    迟到的支付按 `paidAt` 归期），生成即完整。
   *
   * ⚠️ **幂等**：同一商家同一周期重复生成 → **返回既有单据**，不产生第二张。
   *
   * @param tenantId 缺省 = 该期**所有有流水的商家**
   */
  async generate(input: {
    period: string;
    tenantId?: string;
  }): Promise<GenerateSettlementResult> {
    const period = resolveMonthlyPeriod(input.period);

    return tenantContext.run(platformScope(), async () => {
      // ⚠️ **周期校验用数据库的时钟**（护栏 M15 的同款理由）：
      //    多副本部署时各机器的时钟有偏差，边界时刻会摇摆。
      const now = await this.prisma.databaseNow();
      if (period.to.getTime() > now.getTime()) {
        throw new BadRequestException(
          `周期 ${period.label} 尚未结束，不能出结算单`,
        );
      }

      const tenantIds = input.tenantId
        ? [input.tenantId]
        : await this.merchantIdsWithEntriesInPeriod(period);

      const items: SettlementView[] = [];
      const conflicts: Array<{ tenantId: string; message: string }> = [];
      const stale: string[] = [];
      let created = 0;
      let skipped = 0;

      for (const tenantId of tenantIds) {
        let outcome: Awaited<ReturnType<SettlementService['generateOne']>>;
        try {
          outcome = await this.generateOne(tenantId, period, now);
        } catch (error) {
          // ⚠️ **显式点名了商家 → 直接抛**：
          //    调用方明确知道是哪一家，收集起来反而要他自己去列表里找。
          if (input.tenantId) {
            throw error;
          }
          // ⚠️ **批量模式收集冲突而不是中断整批**：
          //    每个商家各自提交事务，前面的商家**已经落库**了。
          //    中途抛错会让调用方无从得知哪几张已生成（重跑又走幂等分支，
          //    更看不出差异）。
          if (error instanceof ConflictException) {
            conflicts.push({ tenantId, message: error.message });
            continue;
          }
          throw error;
        }

        if (outcome.kind === 'empty') {
          // ⚠️ **显式点名了商家而这家本期没流水 → 404**：
          //    超管明确点了名，「这家没流水」是要知道的事实。
          if (input.tenantId) {
            throw new NotFoundException(
              `该商家在 ${period.label} 没有抽佣流水，无法生成结算单`,
            );
          }
          // ⚠️ **批量模式下也必须记进 `conflicts`，不能静默跳过**：
          //    静默跳过的话，调用方看到 `items` 少了这家，却**没有任何标记**
          //    告诉他「这家没出单」—— 少了一个商家、响应里却看不出原因，
          //    排查的人根本不会想到去查这家。
          //
          //    ⚠️ **触发条件罕见但代价更高**：批量模式选的商家集合按定义
          //    都有流水，只有期间流水被删/改期才会命中。正因为罕见，
          //    没有人会去查它 —— 静默就等于永久丢失。
          conflicts.push({
            tenantId,
            message: `该商家在 ${period.label} 没有抽佣流水，未生成结算单`,
          });
          continue;
        }

        items.push(outcome.view);
        if (outcome.kind === 'created') {
          created += 1;
        } else {
          skipped += 1;
          // ⚠️ **复用分支也要核对当期流水**：
          //    这张单是之前生成的，那之后该期可能又进了流水（回填补录）。
          //    条数对不上就说明它**缺笔**了 —— 必须让调用方看见，
          //    否则 `skipped: 1` 会被误读成「本期已结清」。
          if (outcome.stale) {
            stale.push(tenantId);
          }
        }
      }

      return { items, created, skipped, conflicts, stale };
    });
  }

  /**
   * 给一个商家生成一张单（幂等）。
   *
   * ⚠️ **撞号处理在事务外**：事务一旦因 P2002 失败就回滚了，
   *    在事务里查「目标单据在不在」是查不出真相的。
   */
  private async generateOne(
    tenantId: string,
    period: MonthlyPeriod,
    now: Date,
  ): Promise<
    | { kind: 'created'; view: SettlementView }
    | { kind: 'reused'; view: SettlementView; stale: boolean }
    | { kind: 'empty' }
  > {
    // ---- 先查后插：这一期已经有单据 → 幂等复用 ----
    const existing = await this.prisma.settlementStatement.findFirst({
      where: { tenantId, periodStart: period.from },
    });
    if (existing) {
      // ⚠️ **复用也要核对当期流水**：这张单是之前生成的，
      //    那之后该期可能又进了流水（比如跑了一次 `npm run backfill:commissions`）。
      //    条数对不上就说明它**缺笔**了 —— 不标出来的话，
      //    调用方看到「已复用」就以为「本期已结清」，实际金额是错的。
      //
      //    ⚠️ **只比对笔数，不改单据**：已 `CONFIRMED` 的单据是冻结的。
      //    需要修正走「取消确认 → 重算」。
      //
      //    ⚠️ **为什么比笔数就够**：抽佣流水是 **append-only** 的 ——
      //    `commission_entries` 全仓没有任何 `update` / `updateMany` / `upsert`，
      //    `amount` 与 `occurredAt`（归期）都不会被改。
      //    所以「当期流水笔数没变」⇒ 「纳入的流水集合没变」⇒
      //    「金额必然也没变」。比金额是多余的。
      //    ⚠️ **若将来流水变得可变（可改金额 / 可改归期）**，
      //    这里必须改成比**金额之和**，否则「笔数相同、金额被改过」会漏判。
      const current = await this.entriesInPeriod(tenantId, period);
      const view = await this.toView(existing);
      return {
        kind: 'reused',
        view,
        stale: current.length !== existing.entryCount,
      };
    }

    // ---- 取该商家该期的流水 ----
    const entries = await this.entriesInPeriod(tenantId, period);
    if (entries.length === 0) {
      return { kind: 'empty' };
    }

    const amounts = summarizeEntries(entries);

    // ⚠️ **先查「这笔流水是不是已经被结算过了」**（D9 的 `@@unique([entryId])`）：
    //    明细关联行表**不在租户作用域白名单里**（它没有 tenantId 字段），
    //    所以扩展不会自动附加任何过滤 —— 这里查到的就是全局事实。
    //
    //    为什么要先查：撞 `entryId` 与撞 `statementNo` 是**两回事**，
    //    但两者都是 P2002。若不区分就重试换号，最后抛出的
    //    「生成结算单号失败」会把「这笔流水重复结算」这个真实原因
    //    完全掩盖掉 —— 排查的人会去查随机数，查不到根因。
    await this.assertEntriesNotSettled(entries);

    // ---- 建单据 + 关联行（一个事务） ----
    for (let attempt = 0; attempt < MAX_NUMBER_ATTEMPTS; attempt++) {
      const statementNo = generateStatementNo(now);
      try {
        const statement = await this.prisma.$transaction(
          async (tx) => {
            const created = await tx.settlementStatement.create({
              data: {
                tenantId,
                statementNo,
                periodStart: period.from,
                periodEnd: period.to,
                grossAmount: amounts.grossAmount,
                reversalAmount: amounts.reversalAmount,
                netAmount: amounts.netAmount,
                entryCount: amounts.entryCount,
                status: SettlementStatus.DRAFT,
              },
            });
            await tx.settlementStatementEntry.createMany({
              data: entries.map((entry) => ({
                statementId: created.id,
                entryId: entry.id,
              })),
            });
            return created;
          },
          { maxWait: 10_000, timeout: 10_000 },
        );
        const view = await this.toView(statement);
        return { kind: 'created', view };
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
        // ⚠️ **P2002 有三个可能来源，必须逐个区分**：
        //
        //    ① 撞 `(tenantId, periodStart)` → 并发下别人先生成了 → 幂等返回它
        //    ② 撞 `statementNo`             → 只是号撞了 → 换个号再来
        //    ③ 撞 `entryId`                 → 这笔流水已经被别的结算单结算过了
        //
        //    ⚠️ **不靠 `error.meta.target` 判别**（`InvoiceService` 的做法在
        //    不同驱动版本下形状不一致），而是**重新查一次事实**：
        //    目标单据在不在？目标流水被关联了没？
        //
        //    ⚠️ **事务已回滚**：撞 `entryId` 时整笔事务回滚 → 单据**不存在** →
        //    只查单据的话会误判成「只是号撞了」→ 换号重试 5 次 →
        //    最后抛「生成结算单号失败：连续多次撞上唯一索引」，
        //    **错误信息完全误导**（真实原因是流水重复结算）。
        const raced = await this.prisma.settlementStatement.findFirst({
          where: { tenantId, periodStart: period.from },
        });
        if (raced) {
          // ⚠️ **同样是复用**：并发下别人抢先出了单，也要核对当期流水条数，
          //    否则「并发复用出来的旧单缺笔」同样会被静默放过。
          //
          //    ⚠️ **比笔数就够的前提**：抽佣流水是 **append-only** 的 ——
          //    `commission_entries` 全仓没有 `update` / `updateMany` / `upsert`，
          //    `amount` 与 `occurredAt`（归期）不可变 →
          //    笔数不变则纳入的流水集合不变，金额也必然不变。
          //    ⚠️ **若将来流水变得可变**，这里要改成比**金额之和**。
          const current = await this.entriesInPeriod(tenantId, period);
          const view = await this.toView(raced);
          return {
            kind: 'reused',
            view,
            stale: current.length !== raced.entryCount,
          };
        }

        // ⚠️ **这里撞的是 `entryId`，不是单号** —— 事务回滚了，
        //    所以单据查不到（上面已经判过）。真实的冲突是「这笔流水
        //    已经被另一张结算单结算过」，不能换号重试。
        await this.assertEntriesNotSettled(entries);

        this.logger.warn(
          `结算单号 ${statementNo} 撞号，换一个号重试（第 ${attempt + 1} 次）`,
        );
      }
    }

    // ⚠️ **连撞 5 次说明随机数有问题**（或有别的进程在批量生成），
    //    此时抛错比「静默不出单据」好 —— 后者会让商家永远结不了账。
    throw new Error('生成结算单号失败：连续多次撞上唯一索引');
  }

  /**
   * 断言这批流水**还没有被任何结算单结算过**。
   *
   * ⚠️ **明细关联行表不受租户作用域约束**（它没有 `tenantId` 字段，
   *    刻意不在 `TENANT_SCOPED_MODELS` 白名单里）→ 扩展不附加任何过滤，
   *    这里查到的就是**全局事实**。本阶段全是平台侧调用，没有问题；
   *    将来做商家侧接口时，明细查询必须先校验 `statementId` 属于当前租户。
   *
   * ⚠️ **抛 409 而不是 500**：这不是「服务器内部错误」，
   *    而是「请求与当前状态冲突」—— 这笔流水已经在别的单子里了。
   *
   * @param entries 该商家该期准备纳入结算的流水
   */
  private async assertEntriesNotSettled(
    entries: CommissionEntry[],
  ): Promise<void> {
    const entryIds = entries.map((entry) => entry.id);
    const linked = await this.prisma.settlementStatementEntry.findMany({
      where: { entryId: { in: entryIds } },
      select: { entryId: true },
    });
    if (linked.length === 0) {
      return;
    }
    const linkedIds = new Set(linked.map((row) => row.entryId));
    const conflicted = entries
      .filter((entry) => linkedIds.has(entry.id))
      .map((entry) => entry.orderNo);
    throw new ConflictException(
      `这些流水已经被结算过了，不能重复结算：${conflicted.join('、')}`,
    );
  }

  /**
   * 断言这批流水**没有被别的结算单**结算过（重算时用）。
   *
   * ⚠️ **与 `assertEntriesNotSettled` 的区别**：重算时，这张单据**自己**
   *    的关联行是合法的（事务里先删掉再重建）。所以要把「本单自己占着的」
   *    排除掉，只判「别的单据占着的」。
   *
   * @param entries 该商家该期准备纳入结算的流水
   * @param statementId 本单自己的 id（它的关联行不算冲突）
   */
  private async assertEntriesNotSettledByOthers(
    entries: CommissionEntry[],
    statementId: string,
  ): Promise<void> {
    const entryIds = entries.map((entry) => entry.id);
    const linked = await this.prisma.settlementStatementEntry.findMany({
      where: { entryId: { in: entryIds } },
      select: { entryId: true, statementId: true },
    });
    const others = linked.filter((row) => row.statementId !== statementId);
    if (others.length === 0) {
      return;
    }
    const otherIds = new Set(others.map((row) => row.entryId));
    const conflicted = entries
      .filter((entry) => otherIds.has(entry.id))
      .map((entry) => entry.orderNo);
    throw new ConflictException(
      `这些流水已经被别的结算单结算过了，不能重复结算：${conflicted.join('、')}`,
    );
  }

  /** 该期有流水的商家 id 列表 */
  private async merchantIdsWithEntriesInPeriod(
    period: MonthlyPeriod,
  ): Promise<string[]> {
    const rows = await this.prisma.commissionEntry.groupBy({
      by: ['tenantId'],
      where: { occurredAt: { gte: period.from, lt: period.to } },
    });
    return rows.map((row) => row.tenantId);
  }

  /** 某商家某期的流水（左闭右开） */
  private async entriesInPeriod(
    tenantId: string,
    period: MonthlyPeriod,
  ): Promise<CommissionEntry[]> {
    return this.prisma.commissionEntry.findMany({
      where: {
        tenantId,
        occurredAt: { gte: period.from, lt: period.to },
      },
      orderBy: { occurredAt: 'asc' },
    });
  }

  /**
   * 某一期当期真实的抽佣流水笔数。
   *
   * ⚠️ **按流水自己的 `occurredAt` 归期** —— 不能用账单的 `periodStart` 去筛流水：
   *    流水的归期是 `occurredAt`，账单的周期是 `periodStart`，
   *    两者不是一回事（跨期回填的流水归期在退款期，不在原期）。
   */
  private async actualEntryCount(
    tenantId: string,
    period: MonthlyPeriod,
  ): Promise<number> {
    return this.prisma.commissionEntry.count({
      where: { tenantId, occurredAt: { gte: period.from, lt: period.to } },
    });
  }

  /**
   * 把一行结算单变成对外的形状（含商家名与子域名）。
   *
   * ⚠️ **商家名要单独查**：`SettlementStatement.tenantId` 是纯标量、
   * 没声明 Prisma 关系 → 拿不到商家名。
   * （`Tenant` **不在** `TENANT_SCOPED_MODELS` 白名单里，任何作用域都能查。）
   */
  private async toView(
    statement: SettlementStatement,
  ): Promise<SettlementView> {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: statement.tenantId },
      select: { name: true, subdomain: true },
    });
    // ⚠️ **缺笔数也要算** —— `SettlementView` 的字段是**每处返回都要有**的，
    //    单张视图不能只为了少一次查询就把它填成 0。
    const missingEntryCount = await this.missingEntryCountOf(statement);
    return this.toViewFields(
      statement,
      {
        // ⚠️ **查不到商家名就回落到 id 本身**：商家被删了也要让超管看到这一行
        //（「有个商家产生了抽佣但查不到它的信息」是超管必须知道的事实）。
        name: tenant?.name ?? statement.tenantId,
        // ⚠️ **子域名查不到时给「—」**：空串看不出是「商家不存在」还是「数据缺失」。
        subdomain: tenant?.subdomain ?? '—',
      },
      missingEntryCount,
    );
  }

  /**
   * 单张结算单的缺笔数：当期真实流水笔数 − 结算单纳入的笔数。
   *
   * ⚠️ **按流水自己的 `occurredAt` 归期** —— 不能用账单的 `periodStart` 去筛流水：
   *    流水的归期是 `occurredAt`，账单的周期是 `periodStart`，
   *    两者不是一回事（跨期回填的流水归期在退款期，不在原期）。
   */
  private async missingEntryCountOf(
    statement: SettlementStatement,
  ): Promise<number> {
    // ⚠️ **上界用「周期标识反推出来的标准区间」，不用 `statement.periodEnd`** ——
    //    `periodEnd` 是可以被人手工改宽的脏数据字段（`periodStart` 对应的
    //    那个月的标准上界才是这一期真正的边界）。
    //    批量路径（`missingEntryCounts`）是**逐条按 `occurredAt` 归期**的，
    //    这里若改用 `periodEnd` 当上界 → 手工改宽后会把下个月的流水算进来
    //    → **同一张单在列表页与详情页给出两个不同的缺笔数**。
    //    两处口径必须同源，所以这里也走标准区间。
    const period = resolveMonthlyPeriod(
      formatPeriodLabel(statement.periodStart),
    );
    const actual = await this.actualEntryCount(statement.tenantId, period);
    // ⚠️ **差值不能是负数**：结算单纳入的笔数不可能多于当期真实笔数
    //    （流水是 append-only，不会被删）。
    return Math.max(0, actual - statement.entryCount);
  }

  /** 单据本体 → 对外字段（不含商家信息） */
  private toViewFields(
    statement: SettlementStatement,
    tenant: { name: string; subdomain: string },
    missingEntryCount: number,
  ): SettlementView {
    return {
      id: statement.id,
      tenantId: statement.tenantId,
      tenantName: tenant.name,
      subdomain: tenant.subdomain,
      statementNo: statement.statementNo,
      periodStart: statement.periodStart.toISOString(),
      periodEnd: statement.periodEnd.toISOString(),
      periodLabel: formatPeriodLabel(statement.periodStart),
      grossAmount: statement.grossAmount,
      reversalAmount: statement.reversalAmount,
      netAmount: statement.netAmount,
      entryCount: statement.entryCount,
      missingEntryCount,
      status: statement.status,
      confirmedAt: statement.confirmedAt?.toISOString() ?? null,
      createdAt: statement.createdAt.toISOString(),
    };
  }

  /**
   * 重算：重新聚合该商家该期的流水。
   *
   * ⚠️ **只有 `DRAFT` 能重算**：`CONFIRMED` 的单据是冻结的，
   *    要改先「取消确认」。已确认的单据被悄悄改掉，
   *    超管手里那份就与系统里的对不上了。
   *
   * ⚠️ **必须先删旧的关联行**：不删的话 `entryId` 的唯一约束会让
   *    重新插入撞上**自己**（上一轮已经关联过同一批流水）→ 整批失败。
   */
  async recalculate(statementId: string): Promise<SettlementView> {
    return tenantContext.run(platformScope(), async () => {
      const statement = await this.prisma.settlementStatement.findFirst({
        where: { id: statementId },
      });
      if (!statement) {
        throw new NotFoundException('结算单不存在');
      }
      if (statement.status !== SettlementStatus.DRAFT) {
        throw new ConflictException(
          `结算单当前是「${statement.status}」状态，不能重算。请先取消确认。`,
        );
      }

      const period: MonthlyPeriod = {
        from: statement.periodStart,
        to: statement.periodEnd,
        label: formatPeriodLabel(statement.periodStart),
      };
      const entries = await this.entriesInPeriod(statement.tenantId, period);

      // ⚠️ **当期查不到流水 → 409，绝不重算成「0 元 0 明细」**：
      //    「该结的账结完了」与「从来就没有流水」是两回事，
      //    混为一谈就是把一张有金额的单**无声抹成零**。
      //    而且这是**静默抹账**的形态 —— 万一 `entriesInPeriod` 的查询条件
      //    哪天写错了，单据会被无声清零，没有任何报错线索。
      //
      //    ⚠️ **与 `generate` 的语义对齐**：`generate` 在无流水时是 404 /
      //    静默跳过，从来不会产出一张空单。
      if (entries.length === 0) {
        throw new ConflictException(
          `该期已无抽佣流水（${period.label}），不能重算成空单。` +
            '若单据金额有误，请先核对该期的流水是否被删除。',
        );
      }

      const amounts = summarizeEntries(entries);

      // ⚠️ **先查「有没有别的单据占着这批流水」**（D9 的 `@@unique([entryId])`）：
      //    事务里删掉本单自己的关联行、再重新插入时，若其中某笔流水
      //    已被**另一张**单据占用 → `createMany` 撞 P2002 → 整笔事务回滚 →
      //    P2002 一路冒到全局异常过滤器会变成 500「服务器内部错误」，
      //    超管完全看不出是「流水重复结算」。这里提前判掉，给出 409。
      //
      //    ⚠️ **正常数据下不会命中**：一笔流水的 `occurredAt` 只落在一个自然月，
      //    同一商家同一周期只有一张单（`@@unique([tenantId, periodStart])`）。
      //    这道闸防的是「手工改过 periodEnd」或「并发生成」这类脏数据。
      await this.assertEntriesNotSettledByOthers(entries, statement.id);

      let updated: SettlementStatement;
      try {
        updated = await this.prisma.$transaction(
          async (tx) => {
            await tx.settlementStatementEntry.deleteMany({
              where: { statementId: statement.id },
            });
            await tx.settlementStatementEntry.createMany({
              data: entries.map((entry) => ({
                statementId: statement.id,
                entryId: entry.id,
              })),
            });
            // ⚠️ **条件更新**：where 带 `status` —— 并发重算时只有一个能成功。
            const affected = await tx.settlementStatement.updateMany({
              where: { id: statement.id, status: SettlementStatus.DRAFT },
              data: {
                grossAmount: amounts.grossAmount,
                reversalAmount: amounts.reversalAmount,
                netAmount: amounts.netAmount,
                entryCount: amounts.entryCount,
              },
            });
            if (affected.count === 0) {
              throw new ConflictException('结算单状态已变，不能重算');
            }
            const rows = await tx.settlementStatement.findFirst({
              where: { id: statement.id },
            });
            if (!rows) {
              throw new NotFoundException('结算单不存在');
            }
            return rows;
          },
          { maxWait: 10_000, timeout: 10_000 },
        );
      } catch (error) {
        // ⚠️ **P2002 逃逸成 500 的兜底**：
        //    上面的 `assertEntriesNotSettledByOthers` 与事务之间存在
        //    **TOCTOU 窗口** —— 并发 `generate` 抢先把这笔流水结算了，
        //    事务里的 `createMany` 就会撞 `entryId` 唯一索引。
        //    P2002 一路冒到全局异常过滤器会变成 500「服务器内部错误」，
        //    超管完全看不出是「流水重复结算」。
        //
        //    ⚠️ **事务此时已回滚 → 可以查到真相**：补跑一次
        //    `assertEntriesNotSettledByOthers` 让它抛 409。
        //    若它没抛（说明撞的不是 `entryId`），则原样重抛 ——
        //    **不要把别的故障伪装成「重复结算」**。
        if (!isUniqueViolation(error)) {
          throw error;
        }
        await this.assertEntriesNotSettledByOthers(entries, statement.id);
        throw error;
      }

      return this.toView(updated);
    });
  }

  /**
   * 确认：`DRAFT → CONFIRMED`。
   *
   * ⚠️ **幂等**：重复确认原样返回，不报错。
   * ⚠️ **条件更新**（where 带 `status`）—— 两次并发确认不能都成功。
   */
  async confirm(statementId: string): Promise<SettlementView> {
    return tenantContext.run(platformScope(), async () => {
      const now = await this.prisma.databaseNow();
      const affected = await this.prisma.settlementStatement.updateMany({
        where: { id: statementId, status: SettlementStatus.DRAFT },
        data: { status: SettlementStatus.CONFIRMED, confirmedAt: now },
      });

      const statement = await this.prisma.settlementStatement.findFirst({
        where: { id: statementId },
      });
      if (!statement) {
        throw new NotFoundException('结算单不存在');
      }
      if (affected.count === 0) {
        // ⚠️ **已经是 CONFIRMED → 幂等返回**（不是报错）。
        if (statement.status === SettlementStatus.CONFIRMED) {
          return this.toView(statement);
        }
        throw new ConflictException(
          `结算单当前是「${statement.status}」状态，不能确认`,
        );
      }
      return this.toView(statement);
    });
  }

  /**
   * 这张结算单有没有被**活跃的**出款单引用（护栏 P6 的判定）。
   *
   * ⚠️ **只有非终态的出款单才算**：REJECTED / CANCELLED / FAILED 的单
   *    没有把钱打出去，它们不构成「钱已经出去了」的事实
   *    → 不该拦住修正漏结的路径。
   *    ⚠️ **FAILED 也要排除**（阶段 5h-2）：出款失败的单仍然挂着
   *    `statementId`，但不排除的话，一次出款失败会让该结算单
   *    永远无法取消确认。
   *
   * ⚠️ **查得到全局的出款单**：调用方都跑在**平台作用域**下
   *    （`tenantContext.run(platformScope(), ...)`）→ 平台作用域下扩展
   *    **不附加** tenantId 条件 → 查到的就是全局事实。
   *
   * ⚠️ **这里有 TOCTOU 窗口**：闸是「读—判断—写」三步，不是事务。
   *    闸通过之后、状态更新之前若**新建**了一张引用这张结算单的出款单，
   *    这道闸挡不住它。
   *    ⚠️ **本阶段这个窗口不致命**：出款单要走到「引用这张结算单」
   *    必须先 `apply`，而 `apply` 要求该期结算单**已 CONFIRMED** ——
   *    也就是说，能在这个窗口里插进来的单，它锁定的佣金来自
   *    **确认状态**的结算单，与这里重算后的草稿值可能不同。
   *    彻底堵住要靠 `approve` 侧回查（见 `PayoutService.approve`）。
   *
   * ⚠️ **`unconfirm` 与 `detail`（`canRecalculate`）共用这一个判定** ——
   *    两处各写一份 → 口径漂了 → 前端说「可以重算」、
   *    点下去却被 409 拦下。
   */
  private async hasActivePayoutReference(
    statementId: string,
  ): Promise<boolean> {
    const referenced = await this.prisma.payout.findFirst({
      where: {
        statementId,
        status: {
          notIn: [
            PayoutStatus.REJECTED,
            PayoutStatus.CANCELLED,
            PayoutStatus.FAILED,
          ],
        },
      },
      select: { id: true },
    });
    return referenced !== null;
  }

  /**
   * 取消确认：`CONFIRMED → DRAFT`。
   *
   * ⚠️ **为什么需要它**：漏结（已确认的单据之后又有该期的流水进来，
   *    比如跑了一次 `npm run backfill:commissions`）是死账 ——
   *    没有回退路径就永远修不好。退回来重算一次即可修正（设计 D6）。
   *
   * ⚠️ **`PAID` 不能取消**：已出款的单据退回来，改动的钱已经打给商家了。
   *
   * ⚠️ **已被出款单引用的也不能取消**（阶段 5h-1，护栏 P6）：
   *    出款单的佣金金额是**审批那一刻锁定的快照**。结算单退回来重算，
   *    佣金就变了 → 已批的出款单金额失真 → 平台打出去的钱与账对不上。
   *    详见下方方法体内的闸。
   */
  async unconfirm(statementId: string): Promise<SettlementView> {
    return tenantContext.run(platformScope(), async () => {
      const statement = await this.prisma.settlementStatement.findFirst({
        where: { id: statementId },
      });
      if (!statement) {
        throw new NotFoundException('结算单不存在');
      }
      if (statement.status !== SettlementStatus.CONFIRMED) {
        throw new ConflictException(
          `结算单当前是「${statement.status}」状态，不能取消确认`,
        );
      }

      // ⚠️ **已被出款单引用的结算单不能取消确认**（阶段 5h-1，护栏 P6）：
      //    出款单的佣金金额是**审批那一刻锁定的快照**。
      //    结算单被取消确认后重算，佣金会变 → 已批的出款单金额失真
      //    → 平台打出去的钱与账对不上。
      //
      //    ⚠️ **判定与 `hasActivePayoutReference` 共用同一份实现** ——
      //    `detail` 里的 `canRecalculate` 说的是同一件事，
      //    两处各写一份 → 口径漂了 → 前端说「可以重算」、
      //    点下去却被 409 拦下。
      if (await this.hasActivePayoutReference(statementId)) {
        throw new ConflictException(
          '该结算单已被出款单引用，不能取消确认。若出款已执行，请走调账流程。',
        );
      }

      // ⚠️ **必须检查 `affected.count`**（与 `confirm` 对齐）：
      //    并发两次 `unconfirm` 时，两次都读到 `CONFIRMED`，
      //    第二次的 `updateMany` 影响 0 行。若不检查就继续往下走，
      //    它会读到 `DRAFT` 并**返回成功** —— 看起来像「取消确认成功」，
      //    实际是自己把自己的成功判定抄了一遍。
      //
      //    将来有 `PAID` 状态时，同样的写法会让「取消确认一个已出款的单」
      //    **静默成功** —— 那张单的钱都打给商家了。
      const affected = await this.prisma.settlementStatement.updateMany({
        where: { id: statementId, status: SettlementStatus.CONFIRMED },
        data: { status: SettlementStatus.DRAFT, confirmedAt: null },
      });

      const after = await this.prisma.settlementStatement.findFirst({
        where: { id: statementId },
      });
      if (!after) {
        throw new NotFoundException('结算单不存在');
      }
      if (affected.count === 0) {
        // ⚠️ **按实际状态报错**：并发下可能已经被别人改成别的状态了。
        throw new ConflictException(
          `结算单当前是「${after.status}」状态，不能取消确认`,
        );
      }
      return this.toView(after);
    });
  }

  /**
   * 结算单列表。
   *
   * ⚠️ **`total` 要是真实总数，不能用 `items.length`**：
   * `items` 被 `pageSize` 截断了，超管看到「总共 50 条」会以为平台只有 50 张单。
   * （与 `ReportService.listSubscriptions` 的同款理由。）
   */
  async list(input: {
    period?: string;
    status?: SettlementStatus;
    page: number;
    pageSize: number;
  }): Promise<{ items: SettlementView[]; total: number }> {
    const where: {
      periodStart?: Date;
      status?: SettlementStatus;
    } = {};
    if (input.period) {
      // ⚠️ **`period` 精确匹配 `periodStart`**：自然月的起点唯一。
      where.periodStart = resolveMonthlyPeriod(input.period).from;
    }
    if (input.status) {
      where.status = input.status;
    }

    return tenantContext.run(platformScope(), async () => {
      const [rows, total] = await Promise.all([
        this.prisma.settlementStatement.findMany({
          where,
          orderBy: [{ periodStart: 'desc' }, { createdAt: 'desc' }],
          skip: (input.page - 1) * input.pageSize,
          take: input.pageSize,
        }),
        this.prisma.settlementStatement.count({ where }),
      ]);
      // ⚠️ **缺笔数在 `toViews` 里批量算** —— 列表最多 200 行，
      //    「每行查一次」就是 200 次额外查询（N+1）。
      return { items: await this.toViews(rows), total };
    });
  }

  /**
   * 结算单详情（含明细）。
   *
   * ⚠️ **明细的金额从流水 join 出来，不做快照**：
   * 流水是 append-only 的（不软删、不改），金额永不变 →
   * join 出来的值与生成时算的值必然一致。多存一份就是第二处数字来源。
   */
  async detail(statementId: string): Promise<SettlementDetailView> {
    return tenantContext.run(platformScope(), async () => {
      const statement = await this.prisma.settlementStatement.findFirst({
        where: { id: statementId },
      });
      if (!statement) {
        throw new NotFoundException('结算单不存在');
      }

      const links = await this.prisma.settlementStatementEntry.findMany({
        where: { statementId },
      });
      const entryIds = links.map((link) => link.entryId);
      const entries =
        entryIds.length > 0
          ? await this.prisma.commissionEntry.findMany({
              where: { id: { in: entryIds } },
              orderBy: { occurredAt: 'asc' },
            })
          : [];
      const entryById = new Map(entries.map((entry) => [entry.id, entry]));

      const view = (await this.toViews([statement]))[0];

      // ⚠️ **能不能修正 = 有没有出款单引用**（P6 闸，与 `unconfirm` 同一份判定）。
      const canRecalculate = !(await this.hasActivePayoutReference(
        statement.id,
      ));

      const detailEntries = links.flatMap((link) => {
        const entry = entryById.get(link.entryId);
        // ⚠️ **查不到就跳过而不是崩**：关联行有外键 Restrict，
        //    正常情况下查不到；但崩掉整页比少显示一行糟得多。
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

      return {
        ...view,
        canRecalculate,
        // ⚠️ **按发生时间排序**：关联行是按 `statementId` 查出来的，
        //    顺序是任意的（数据库没有承诺）。明细要按业务时间读，
        //    否则超管看到的是一堆乱序的流水，对不上账。
        entries: detailEntries.sort((a, b) =>
          a.occurredAt < b.occurredAt
            ? -1
            : a.occurredAt > b.occurredAt
              ? 1
              : 0,
        ),
      };
    });
  }

  /**
   * 批量算每张结算单的「缺笔数」（列表页用）。
   *
   * ⚠️ **只查一次流水** —— 列表最多 200 行，「每行查一次」就是 N+1。
   *    做法：把本页所有结算单的 `(tenantId, periodStart)` 收集起来 →
   *    取 `min(periodStart)` 到 `max(periodEnd)` 的**区间** →
   *    **一次**查出该区间内所有相关租户的流水 →
   *    在内存里按 `(tenantId, formatPeriodLabel(occurredAt))` 分组计数。
   *
   * ⚠️ **区间只是取数的粗筛**（平台端列表可跨多期，周期筛选是可选的），
   *    **归期口径仍然是逐条按 `occurredAt` 算** —— 两者不矛盾：
   *    区间负责「把相关的行都捞回来」，`occurredAt` 负责「每一笔算哪一期」。
   *
   * ⚠️ **返回值与入参 `rows` 一一对应（按下标）**：
   *    同一租户同一期**只会有一张结算单**（`@@unique([tenantId, periodStart])`），
   *    所以 `(tenantId, periodLabel)` 足以唯一定位一张单。
   */
  private async missingEntryCounts(
    rows: SettlementStatement[],
  ): Promise<Map<number, number>> {
    const result = new Map<number, number>();
    if (rows.length === 0) {
      return result;
    }

    // ⚠️ **用 reduce 而不是 `Math.min(...arr)`**：`Math.min` 展开参数个数有上限，
    //    行数多了会抛「Maximum call stack size exceeded」。
    const from = new Date(
      rows.reduce(
        (min, row) => Math.min(min, row.periodStart.getTime()),
        Infinity,
      ),
    );
    const to = new Date(
      rows.reduce(
        (max, row) => Math.max(max, row.periodEnd.getTime()),
        -Infinity,
      ),
    );
    const tenantIds = [...new Set(rows.map((row) => row.tenantId))];

    // ⚠️ **一次查出区间内所有相关租户的流水**（`select` 只要归期要用的字段）。
    const entries = await this.prisma.commissionEntry.findMany({
      where: {
        tenantId: { in: tenantIds },
        occurredAt: { gte: from, lt: to },
      },
      select: { tenantId: true, occurredAt: true },
    });

    // ⚠️ **按 `(tenantId, 周期标识)` 分组计数** —— 归期按流水自己的
    //    `occurredAt` 算，不是按账单的 `periodStart`。
    const countByKey = new Map<string, number>();
    for (const entry of entries) {
      const key = `${entry.tenantId}|${formatPeriodLabel(entry.occurredAt)}`;
      countByKey.set(key, (countByKey.get(key) ?? 0) + 1);
    }

    rows.forEach((row, index) => {
      const key = `${row.tenantId}|${formatPeriodLabel(row.periodStart)}`;
      const actual = countByKey.get(key) ?? 0;
      // ⚠️ **差值不能是负数**：结算单纳入的笔数不可能多于当期真实笔数
      //    （流水是 append-only，不会被删）。
      result.set(index, Math.max(0, actual - row.entryCount));
    });
    return result;
  }

  /**
   * 批量把结算单变成对外的形状（商家名批量查，避免 N+1）。
   *
   * ⚠️ **缺笔数也是批量算的**（`missingEntryCounts`）——
   *    逐行查就是 N+1（列表最多 200 行）。
   */
  private async toViews(
    rows: SettlementStatement[],
  ): Promise<SettlementView[]> {
    if (rows.length === 0) {
      return [];
    }
    const tenantIds = [...new Set(rows.map((row) => row.tenantId))];
    const [tenants, missingCounts] = await Promise.all([
      this.prisma.tenant.findMany({
        where: { id: { in: tenantIds } },
        select: { id: true, name: true, subdomain: true },
      }),
      this.missingEntryCounts(rows),
    ]);
    const tenantById = new Map(tenants.map((tenant) => [tenant.id, tenant]));

    return rows.map((row, index) => {
      const tenant = tenantById.get(row.tenantId);
      return this.toViewFields(
        row,
        {
          name: tenant?.name ?? row.tenantId,
          subdomain: tenant?.subdomain ?? '—',
        },
        missingCounts.get(index) ?? 0,
      );
    });
  }
}

/**
 * 生成结算单号。
 *
 * ⚠️ **服务端生成**：结算单号不是秘密（它出现在对账单里），
 * 但**不能由客户端指定** —— 否则「A 单号对应 B 商家的账」就可能发生。
 *
 * ⚠️ **秒级时间戳 + 4 位随机数**：同一秒内生成 10000 张才会撞一次。
 */
function generateStatementNo(now: Date): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const random = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, '0');
  return `STL${stamp}${random}`;
}
