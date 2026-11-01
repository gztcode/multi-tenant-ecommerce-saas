import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ReconciliationResolution,
  ReconciliationSeverity,
  ReconciliationSource,
  ReconciliationStatus,
} from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import {
  platformScope,
  tenantContext,
} from '../../common/tenant/tenant-context';
import { withTimeout } from '../../common/util/with-timeout';
import { clampPagination } from '../../common/http/pagination';
import {
  FAKE_PAYOUT_UNAVAILABLE_MESSAGE,
  PAYOUT_PROVIDERS,
} from '../../common/payment/payout.constants';
import type {
  ChannelPayoutRecord,
  PayoutProvider,
} from '../../common/payment/payout-provider.interface';
import {
  FAKE_PAYOUT_CHANNEL,
  isFakePayoutEnabled,
} from '../../common/payment/fake-payout.provider';
import {
  LocalPayoutForReconcile,
  ReconcileDiff,
  reconcile,
} from './payout-reconcile.engine';
import { PayoutReconciliationResolver } from './payout-reconciliation-resolver.service';

/** 时间窗的最大跨度（天） */
export const RECONCILIATION_MAX_WINDOW_DAYS = 31;

/** 渠道侧返回的记录数上限 */
export const RECONCILIATION_MAX_CHANNEL_RECORDS = 10_000;

/** 单次对账的执行超时（毫秒） */
export const RECONCILIATION_TIMEOUT_MS = 30_000;

/**
 * 详情接口一次最多返回多少条差异项。
 *
 * ⚠️ **一个对账任务最多能产生上万条差异**（渠道记录数上限就是 10000 条）
 *    → 一次性全吐给浏览器会卡死。截断时必须带 `itemsTruncated` 标记，
 *    静默截断会让人以为「就这些差异」。
 */
export const RECONCILIATION_MAX_ITEMS = 200;

/** 判定 D 类用的「扩大窗口」余量（小时） */
export const RECONCILIATION_EXPANDED_MARGIN_HOURS = 15;

/**
 * 渠道对账服务（阶段 5m）。
 *
 * ## 它做什么
 *
 * 1. 查本地参与比对的单（按 `paidAt` / `processingAt` / `failedAt` 三个时间戳）
 * 2. 拉渠道侧的流水（`listPayouts`）
 * 3. 交给比对引擎分类
 * 4. 落差异项 + 去重
 * 5. A 类自动纠正
 *
 * ⚠️ **跑在平台作用域下** —— 对账是平台级动作，跨所有租户。
 */
@Injectable()
export class PayoutReconciliationService {
  private readonly logger = new Logger(PayoutReconciliationService.name);

  constructor(
    private readonly prisma: TenantPrismaService,
    @Inject(PAYOUT_PROVIDERS)
    private readonly providers: Map<string, PayoutProvider>,
    private readonly resolver: PayoutReconciliationResolver,
  ) {}

  /**
   * 手动触发一次对账（同步执行）。
   *
   * ⚠️ **三道上限**：窗口跨度 ≤ 31 天；渠道记录数 ≤ 10000；执行 ≤ 30 秒。
   *    超限一律把任务落 `FAILED` 并写明原因，**不做静默截断** ——
   *    截断出来的对账结论是错的。
   */
  async trigger(input: {
    channel: string;
    from: Date;
    to: Date;
    operatorId: string;
  }): Promise<{
    id: string;
    status: string;
    diffCount: number;
    matchedCount: number;
  }> {
    await this.assertWindow(input.from, input.to);
    this.assertChannelAvailable(input.channel);

    const reconciliation = await tenantContext.run(platformScope(), async () =>
      this.prisma.payoutReconciliation.create({
        data: {
          channel: input.channel,
          source: ReconciliationSource.API,
          windowFrom: input.from,
          windowTo: input.to,
          status: ReconciliationStatus.RUNNING,
          triggeredBy: input.operatorId,
        },
      }),
    );

    try {
      return await withTimeout(
        this.run(reconciliation.id, input.channel, input.from, input.to),
        RECONCILIATION_TIMEOUT_MS,
        '渠道对账',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await tenantContext.run(platformScope(), async () => {
        // ⚠️ **只把还在 `RUNNING` 的任务落 `FAILED`** ——
        //    `withTimeout` 是 `Promise.race`，超时**不会取消**底层的 `run()`，
        //    后台它仍在跑、最后会把任务改成 `COMPLETED`。
        //    → 两边都加 `RUNNING` 守卫，**先落终态的赢**。
        //    不加守卫的后果不只是状态显示错：超时落 `FAILED` 又被翻成
        //    `COMPLETED` → `runScheduled` 的幂等检查只查 `COMPLETED`
        //    → 那个窗口**永远不会再被对账**，那批出款单的差异静默丢失。
        const affected = await this.prisma.payoutReconciliation.updateMany({
          where: {
            id: reconciliation.id,
            status: ReconciliationStatus.RUNNING,
          },
          data: {
            status: ReconciliationStatus.FAILED,
            finishedAt: await this.prisma.databaseNow(),
            errorMessage: message,
          },
        });
        if (affected.count === 0) {
          // ⚠️ **任务行已被别人改过终态** —— 说明不是超时这条路径，
          //    静默即可，但留一行日志便于排查。
          this.logger.warn(
            `对账任务 ${reconciliation.id} 未落 FAILED（状态已被其他路径改过）`,
          );
        }
      });
      throw error;
    }
  }

  /** 定时对账：对「昨天」（UTC 自然日） */
  async runScheduled(channel: string): Promise<void> {
    if (!this.assertChannelAvailable(channel, false)) {
      return;
    }
    const now = await this.prisma.databaseNow();
    const to = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);

    // ⚠️ **幂等**：同一天重复跑 → 已有 `COMPLETED` 任务就跳过
    const existing = await tenantContext.run(platformScope(), async () =>
      this.prisma.payoutReconciliation.findFirst({
        where: {
          channel,
          windowFrom: from,
          windowTo: to,
          status: ReconciliationStatus.COMPLETED,
        },
      }),
    );
    if (existing) {
      this.logger.log(`渠道对账跳过（该窗口已有完成的任务 ${existing.id}）`);
      return;
    }

    await this.trigger({
      channel,
      from,
      to,
      operatorId: 'system:scheduler',
    });
  }

  /** 对账的主体流程 */
  private async run(
    reconciliationId: string,
    channel: string,
    from: Date,
    to: Date,
  ): Promise<{
    id: string;
    status: string;
    diffCount: number;
    matchedCount: number;
  }> {
    const provider = this.providers.get(channel);
    if (!provider) {
      // ⚠️ **文案要与 `assertChannelAvailable` 一致** —— 同一件事说两句话，
      //    运营会以为是两个问题。
      throw new ConflictException(
        `该渠道当前不可用（${FAKE_PAYOUT_UNAVAILABLE_MESSAGE}），无法执行渠道对账`,
      );
    }

    // ---- ① 拉渠道流水 ----
    const expanded = {
      from: new Date(
        from.getTime() - RECONCILIATION_EXPANDED_MARGIN_HOURS * 3600_000,
      ),
      to: new Date(
        to.getTime() + RECONCILIATION_EXPANDED_MARGIN_HOURS * 3600_000,
      ),
    };
    const channelRecords = await provider.listPayouts({
      from: expanded.from,
      to: expanded.to,
    });
    // ⚠️ **渠道侧不承诺输出顺序** —— 假网关按 `referenceNo` 分组输出，
    //    真渠道更是分页/倒序/按状态分组都有 → 排序由比对引擎负责
    //    （引擎内部按 `paidAt` 升序排、`paidAt` 相同时按 `providerTxnId` 兜底）。
    //    ⚠️ **时间窗筛的是「发起打款时刻」** —— 假网关是同步的，两者等同；
    //    真渠道是异步的（发起与到账可能跨天）→ 真渠道接入时这个语义要重定。
    if (channelRecords.length > RECONCILIATION_MAX_CHANNEL_RECORDS) {
      throw new ConflictException(
        `渠道返回了 ${channelRecords.length} 条流水，超过上限 ${RECONCILIATION_MAX_CHANNEL_RECORDS} 条，请缩小时间窗`,
      );
    }

    // ---- ② 查本地参与比对的单 ----
    const localPayouts = await this.loadLocalPayouts(from, to);

    // ---- ③ 比对 ----
    const output = reconcile({
      window: { from, to },
      expandedWindow: expanded,
      localPayouts,
      channelRecords,
    });

    // ---- ④ 落差异项 + 去重 ----
    const completed = await tenantContext.run(platformScope(), async () => {
      await this.supersedePreviousPending(output.diffs, reconciliationId);
      if (output.diffs.length > 0) {
        await this.prisma.payoutReconciliationItem.createMany({
          data: output.diffs.map((diff) => ({
            reconciliationId,
            type: diff.type,
            severity: diff.severity,
            payoutId: diff.payoutId,
            channelTxnId: diff.channelTxnId,
            channelReferenceNo: diff.channelReferenceNo,
            channelAmount: diff.channelAmount,
            channelStatus: diff.channelStatus,
            channelPaidAt: diff.channelPaidAt,
            localAmount: diff.localAmount,
            localStatus: diff.localStatus,
          })),
        });
      }
      // ⚠️ **同样只认 `RUNNING`** —— 超时后 `trigger` 的 catch 已把任务
      //    落成 `FAILED`，这时后台的 `run()` 才跑完 → 不能再翻回 `COMPLETED`
      //    （那会让 `runScheduled` 的幂等检查永远跳过这个窗口）。
      const affected = await this.prisma.payoutReconciliation.updateMany({
        where: {
          id: reconciliationId,
          status: ReconciliationStatus.RUNNING,
        },
        data: {
          status: ReconciliationStatus.COMPLETED,
          finishedAt: await this.prisma.databaseNow(),
          channelCount: channelRecords.length,
          localCount: localPayouts.length,
          matchedCount: output.matchedCount,
          diffCount: output.diffs.length,
        },
      });
      return affected.count > 0;
    });

    // ⚠️ **没落成 `COMPLETED` 就不做 A 类纠正** —— 说明这轮已经超时、
    //    任务被落成 `FAILED`。这时再改出款单的状态，会出现
    //    「任务说失败、单子说已付」两边对不上。
    if (!completed) {
      this.logger.warn(
        `对账任务 ${reconciliationId} 未落 COMPLETED（可能已超时落 FAILED），跳过 A 类自动纠正`,
      );
      return {
        id: reconciliationId,
        status: ReconciliationStatus.FAILED,
        diffCount: output.diffs.length,
        matchedCount: output.matchedCount,
      };
    }

    // ---- ⑤ A 类自动纠正 ----
    await this.resolver.resolveAutoDiffs(output.diffs, reconciliationId);

    return {
      id: reconciliationId,
      status: ReconciliationStatus.COMPLETED,
      diffCount: output.diffs.length,
      matchedCount: output.matchedCount,
    };
  }

  /**
   * 导入渠道账单文件并对账（阶段 5m）。
   *
   * ⚠️ **两条来源走同一个比对引擎** —— API 拉来的记录与 CSV 解析出的记录，
   *    都转成 `ChannelPayoutRecord[]` 后进同一个 `reconcile()`。
   *
   * ⚠️ **`expandedWindow` 与 `window` 同区间** —— API 来源的「扩大窗口」
   *    是为了容忍渠道侧时钟偏移（提前 15 小时发起、延后 15 小时到账）；
   *    CSV 是运营自己挑的时间窗，没有偏移可容忍 → 扩大反而会把
   *    窗口外的渠道流水误判成 D 类（渠道打了钱而本地没有）→ 假告警。
   */
  async importRecords(input: {
    channel: string;
    fileName: string;
    columnMapping: string;
    records: ChannelPayoutRecord[];
    from?: Date;
    to?: Date;
    operatorId: string;
  }): Promise<{ id: string; diffCount: number; matchedCount: number }> {
    const now = await this.prisma.databaseNow();
    const to = input.to ?? now;
    const from = input.from ?? new Date(to.getTime() - 24 * 60 * 60 * 1000);
    await this.assertWindow(from, to);
    if (input.records.length > RECONCILIATION_MAX_CHANNEL_RECORDS) {
      throw new ConflictException(
        `账单文件有 ${input.records.length} 条流水，超过上限 ${RECONCILIATION_MAX_CHANNEL_RECORDS} 条`,
      );
    }

    const reconciliation = await tenantContext.run(platformScope(), async () =>
      this.prisma.payoutReconciliation.create({
        data: {
          channel: input.channel,
          source: ReconciliationSource.FILE,
          windowFrom: from,
          windowTo: to,
          fileName: input.fileName,
          columnMapping: input.columnMapping,
          status: ReconciliationStatus.RUNNING,
          triggeredBy: input.operatorId,
        },
      }),
    );

    const localPayouts = await this.loadLocalPayouts(from, to);
    const output = reconcile({
      window: { from, to },
      expandedWindow: { from, to },
      localPayouts,
      channelRecords: input.records,
    });

    await tenantContext.run(platformScope(), async () => {
      await this.supersedePreviousPending(output.diffs, reconciliation.id);
      if (output.diffs.length > 0) {
        await this.prisma.payoutReconciliationItem.createMany({
          data: output.diffs.map((diff) => ({
            reconciliationId: reconciliation.id,
            type: diff.type,
            severity: diff.severity,
            payoutId: diff.payoutId,
            channelTxnId: diff.channelTxnId,
            channelReferenceNo: diff.channelReferenceNo,
            channelAmount: diff.channelAmount,
            channelStatus: diff.channelStatus,
            channelPaidAt: diff.channelPaidAt,
            localAmount: diff.localAmount,
            localStatus: diff.localStatus,
          })),
        });
      }
      await this.prisma.payoutReconciliation.updateMany({
        where: { id: reconciliation.id },
        data: {
          status: ReconciliationStatus.COMPLETED,
          finishedAt: await this.prisma.databaseNow(),
          channelCount: input.records.length,
          localCount: localPayouts.length,
          matchedCount: output.matchedCount,
          diffCount: output.diffs.length,
        },
      });
    });

    await this.resolver.resolveAutoDiffs(output.diffs, reconciliation.id);

    return {
      id: reconciliation.id,
      diffCount: output.diffs.length,
      matchedCount: output.matchedCount,
    };
  }

  /**
   * 查参与比对的本地单。
   *
   * ⚠️ **判据是「这张单调过渠道」** —— 对应 `paidAt` / `processingAt` / `failedAt`
   *    三个时间戳。用 `createdAt` 筛会把「还没调过渠道的单」也捞进来
   *    → 它们在渠道侧压根没有记录 → 全变成假的 D 类。
   * ⚠️ **这个 `where` 不带 `status`** —— `PAID` / `PROCESSING` / `FAILED` 三种都要参与。
   */
  private async loadLocalPayouts(
    from: Date,
    to: Date,
  ): Promise<LocalPayoutForReconcile[]> {
    return tenantContext.run(platformScope(), async () => {
      const rows = await this.prisma.payout.findMany({
        where: {
          OR: [
            { paidAt: { gte: from, lt: to } },
            { processingAt: { gte: from, lt: to } },
            { failedAt: { gte: from, lt: to } },
          ],
        },
        select: {
          id: true,
          payoutNo: true,
          payoutTxnId: true,
          status: true,
          netAmount: true,
          receiptAmount: true,
          commissionAmount: true,
          entryCount: true,
          paidAt: true,
          processingAt: true,
          failedAt: true,
        },
      });
      return rows;
    });
  }

  /**
   * 去重：把历史上同 `(payoutId, type)` 的 `PENDING` 项标为 `IGNORED`。
   *
   * ⚠️ **不做这个，「未处置差异数」会单调增长** → 运营要反复处理同一个问题。
   * ⚠️ **历史记录保留** —— 审计时要能看到「这个问题被对账发现过几次」。
   * ⚠️ **D 类没有 `payoutId`** → 用 `channelTxnId` 代替。
   */
  private async supersedePreviousPending(
    diffs: ReconcileDiff[],
    reconciliationId: string,
  ): Promise<void> {
    // ⚠️ **这里不按渠道限定** —— 去重是**跨轮次**的（同一个
    //    `(payoutId, type)` 在不同轮次是同一个问题）。
    //    ⚠️ **前提：当前只有一个渠道** —— 将来接了第二家渠道，
    //    这里会顺手把**别的渠道**的同 `(payoutId, type)` PENDING 项也标掉，
    //    那时要补上渠道限定（`reconciliation: { channel }` 之类）。
    const note = `已被对账任务 ${reconciliationId} 重新评估`;
    const resolvedAt = await this.prisma.databaseNow();
    for (const diff of diffs) {
      const where = diff.payoutId
        ? { payoutId: diff.payoutId, type: diff.type }
        : diff.channelTxnId
          ? { channelTxnId: diff.channelTxnId, type: diff.type }
          : null;
      if (!where) {
        continue;
      }
      await this.prisma.payoutReconciliationItem.updateMany({
        where: {
          ...where,
          resolution: ReconciliationResolution.PENDING,
        },
        data: {
          resolution: ReconciliationResolution.IGNORED,
          note,
          resolvedAt,
        },
      });
    }
  }

  /** 校验时间窗跨度 */
  private async assertWindow(from: Date, to: Date): Promise<void> {
    if (to.getTime() <= from.getTime()) {
      throw new BadRequestException('时间窗的终点必须晚于起点');
    }
    const days = (to.getTime() - from.getTime()) / (24 * 3600_000);
    if (days > RECONCILIATION_MAX_WINDOW_DAYS) {
      throw new BadRequestException(
        `时间窗跨度不能超过 ${RECONCILIATION_MAX_WINDOW_DAYS} 天`,
      );
    }
    // ⚠️ **整体落在未来的窗口要拒** —— 对未来的时段对账必然是空的，
    //    却会落一条「已完成、0 差异」的记录 → 对账列表里多一条没意义的记录，
    //    还会让人以为「那个时段已经对过了，钱没问题」。
    // ⚠️ **用数据库时钟**（不是 `new Date()`）—— 混用两套时钟，
    //    库与应用差几毫秒就会在边界上判错。
    const now = await this.prisma.databaseNow();
    if (from.getTime() > now.getTime()) {
      throw new BadRequestException('时间窗不能落在未来');
    }
  }

  /**
   * 校验渠道可用。
   *
   * ⚠️ **文案不要写成「该渠道不支持批量查单」** —— 那暗示是渠道能力问题，
   *    运营看到会以为系统坏了；实际原因是「本地假网关没开」。
   */
  private assertChannelAvailable(channel: string, throwOnFail = true): boolean {
    const provider = this.providers.get(channel);
    const available = !!provider && this.isFakeChannelUsable(channel);
    if (!available && throwOnFail) {
      throw new ConflictException(
        `该渠道当前不可用（${FAKE_PAYOUT_UNAVAILABLE_MESSAGE}），无法执行渠道对账`,
      );
    }
    return available;
  }

  /** 假网关是否可用（开关开着且 provider 在册） */
  private isFakeChannelUsable(channel: string): boolean {
    // ⚠️ **当前只有一个渠道** —— 用假网关自己的开关判断
    //    （渠道名要匹配假网关，将来接了真渠道不能拿假网关的开关说它可用）
    return channel === FAKE_PAYOUT_CHANNEL && isFakePayoutEnabled();
  }

  /** 对账任务列表（分页） */
  async list(query: {
    page?: number;
    pageSize?: number;
  }): Promise<{ items: unknown[]; total: number }> {
    // ⚠️ **用 `clampPagination` 而不是手写夹取** ——
    //    `page` 是页码不是每页条数，夹住它的上限会让 100 页之后的数据
    //    **永远取不到**（对账任务是只增不减的历史表，比订单列表更敏感）。
    //    `clampPagination` 只夹 `page` 的下限、夹 `pageSize` 的 1..100，
    //    正是这里要的。
    const { page, pageSize } = clampPagination(query.page, query.pageSize);
    return tenantContext.run(platformScope(), async () => {
      const [items, total] = await Promise.all([
        this.prisma.payoutReconciliation.findMany({
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        this.prisma.payoutReconciliation.count(),
      ]);
      return { items, total };
    });
  }

  /** 对账任务详情 + 差异列表 */
  async detail(id: string): Promise<unknown> {
    return tenantContext.run(platformScope(), async () => {
      const reconciliation = await this.prisma.payoutReconciliation.findFirst({
        where: { id },
        include: { items: true },
      });
      if (!reconciliation) {
        throw new NotFoundException('对账任务不存在');
      }
      // ⚠️ **差异项要截断** —— 一个对账任务最多能产生上万条差异
      //    （渠道记录数上限就是 10000 条），一次性全吐给浏览器会卡死。
      //    → 截断并**明确告诉前端被截断了**（`itemsTruncated`），
      //    静默截断会让人以为「就这些差异」。
      const items = reconciliation.items.slice(0, RECONCILIATION_MAX_ITEMS);
      return {
        ...reconciliation,
        items,
        itemsTruncated: reconciliation.items.length > items.length,
        itemsTotal: reconciliation.items.length,
      };
    });
  }

  /** 处置一条差异 */
  async resolveItem(
    reconciliationId: string,
    itemId: string,
    input: {
      resolution: 'RESOLVED' | 'IGNORED';
      note: string;
      operatorId: string;
    },
  ): Promise<boolean> {
    return tenantContext.run(platformScope(), async () => {
      const affected = await this.prisma.payoutReconciliationItem.updateMany({
        where: { id: itemId, reconciliationId },
        data: {
          resolution: input.resolution,
          note: input.note,
          resolvedBy: input.operatorId,
          resolvedAt: await this.prisma.databaseNow(),
        },
      });
      if (affected.count === 0) {
        throw new NotFoundException('差异项不存在');
      }
      return true;
    });
  }

  /** 该单最近一次对账结论 */
  async statusForPayout(payoutId: string): Promise<unknown> {
    return tenantContext.run(platformScope(), async () =>
      this.prisma.payoutReconciliationItem.findFirst({
        where: { payoutId },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  /** 未处置差异的统计 */
  async summary(): Promise<{
    pendingCritical: number;
    pendingWarning: number;
    pendingInfo: number;
  }> {
    return tenantContext.run(platformScope(), async () => {
      const items = await this.prisma.payoutReconciliationItem.findMany({
        where: { resolution: ReconciliationResolution.PENDING },
        select: { severity: true },
      });
      return {
        pendingCritical: items.filter(
          (i) => i.severity === ReconciliationSeverity.CRITICAL,
        ).length,
        pendingWarning: items.filter(
          (i) => i.severity === ReconciliationSeverity.WARNING,
        ).length,
        pendingInfo: items.filter(
          (i) => i.severity === ReconciliationSeverity.INFO,
        ).length,
      };
    });
  }
}
