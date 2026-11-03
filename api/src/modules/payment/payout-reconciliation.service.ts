import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  PayoutOperationAction,
  ReconciliationDiffType,
  ReconciliationResolution,
  ReconciliationSeverity,
  ReconciliationSource,
  ReconciliationStatus,
} from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { PayoutProviderRegistry } from '../../common/payment/payout-provider.registry';
import {
  platformScope,
  tenantContext,
} from '../../common/tenant/tenant-context';
import { TimeoutError, withTimeout } from '../../common/util/with-timeout';
import { clampPagination } from '../../common/http/pagination';
import {
  CHANNEL_LIST_PAGE_SIZE,
  FAKE_PAYOUT_UNAVAILABLE_MESSAGE,
  PAYOUT_PROVIDERS,
} from '../../common/payment/payout.constants';
import { DEFAULT_CHANNEL_TIMEOUT_MS } from '../../common/channel/channel.types';
import { normalizeChannel } from '../../common/channel/channel-config';
import {
  CHANNEL_ALERT_SINK,
  type ChannelAlert,
  type ChannelAlertSink,
  LoggingChannelAlertSink,
} from '../../common/channel/channel-alert';
import type {
  ChannelPayoutRecord,
  PayoutProvider,
} from '../../common/payment/payout-provider.interface';
import {
  FAKE_PAYOUT_CHANNEL,
  isFakePayoutEnabled,
} from '../../common/payment/fake-payout.provider';
import { PlatformSettingService } from '../../common/platform-settings/platform-setting.service';
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

/**
 * 对账翻页的**单页**超时预算（毫秒，阶段 6b Task 13）。
 *
 * ⚠️ **不再是「整轮固定 30 秒」** —— 真渠道每页 1～2 秒，20 页就要 40 秒，
 *    固定预算必然误判超时。现在按「页数 × 单页超时」算总预算。
 * 对账查询比普通渠道调用慢（银行侧常要跨库查），单页预算给到 30 秒。
 */
export const RECONCILIATION_PAGE_TIMEOUT_MS = 30_000;

/**
 * 对账翻页的最大页数。
 *
 * 与 `fetchChannelRecords` 的上限守卫一致：收到第 21 页才可能超过
 * `RECONCILIATION_MAX_CHANNEL_RECORDS`（21 × 500 = 10500 > 10000）。
 */
export const RECONCILIATION_MAX_PAGES =
  Math.ceil(RECONCILIATION_MAX_CHANNEL_RECORDS / CHANNEL_LIST_PAGE_SIZE) + 1;

/**
 * 单页超时预算：取渠道描述符的 `timeoutMs`，但**不低于对账页的 30 秒**。
 *
 * - provider 没声明（未注册 / 旧实现）→ `DEFAULT_CHANNEL_TIMEOUT_MS`；
 * - 声明得更短（如默认 10 秒）→ 对账页仍用 30 秒（对账查询本来就慢）；
 * - 声明得更长 → 尊重渠道自己的预算。
 */
export function reconciliationPageTimeoutMs(
  providerTimeoutMs?: number,
): number {
  return Math.max(
    providerTimeoutMs ?? DEFAULT_CHANNEL_TIMEOUT_MS,
    RECONCILIATION_PAGE_TIMEOUT_MS,
  );
}

/** 对账总预算 = 页数 × 单页超时（阶段 6b Task 13；导出便于单测断言） */
export function reconciliationTimeoutBudget(
  pages: number,
  pageTimeoutMs: number = RECONCILIATION_PAGE_TIMEOUT_MS,
): number {
  return pages * pageTimeoutMs;
}

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
 * 批量确认单次最多处理多少条（阶段 6a）。
 *
 * ⚠️ **单次请求必须是有界的** —— A 类纠正每条都要独立事务
 *    （`markPaid` + 留痕），几千条会超过 HTTP 超时并把连接占死。
 *    客户端按游标循环调用，直到 `nextCursor = null`。
 */
export const BATCH_CONFIRM_MAX_ITEMS = 200;

/** 批量确认的失败项 */
export interface BatchConfirmFailure {
  id: string;
  message: string;
}

/** 批量确认结果（**允许部分成功**，不整体回滚） */
export interface BatchConfirmResult {
  succeeded: string[];
  failed: BatchConfirmFailure[];
  nextCursor: string | null;
}

/** 批量确认的入参（校验已在 DTO 与中转路由做过，这里只做业务复核） */
export type BatchConfirmInput =
  | {
      reconciliationId: string;
      mode: 'IDS';
      itemIds: string[];
      note: string;
      operatorId: string;
    }
  | {
      reconciliationId: string;
      mode: 'FILTER';
      cursor?: string;
      limit?: number;
      note: string;
      operatorId: string;
    };

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
    private readonly settings: PlatformSettingService,
    // ⚠️ **阶段 6b：渠道描述符（只读 `timeoutMs`）** —— `PayoutProvidersModule`
    //    是 `@Global()`，不产生模块边。`@Optional` 为旧的直接 `new` 用法兜底，
    //    没有注册表时按 provider 自己的 `timeoutMs` 算预算。
    @Optional()
    private readonly registry?: PayoutProviderRegistry,
    // ⚠️ **阶段 6b**：默认绑 `LoggingChannelAlertSink`（`@Optional` 让现有
    //    直接 `new` 的测试不必改构造参数）。模块里显式注册同一个实例如默认值。
    @Optional()
    @Inject(CHANNEL_ALERT_SINK)
    private readonly alerts: ChannelAlertSink = new LoggingChannelAlertSink(),
  ) {}

  /**
   * 某个渠道的单页超时预算（阶段 6b Task 13）。
   *
   * 优先读注册表的描述符（未注册渠道注册表会回落默认值）；
   * 注册表不可用（如单测里只给了渠道 Map）时，按 provider 自己的
   * `timeoutMs` → `DEFAULT_CHANNEL_TIMEOUT_MS` 兜底。**不抛错**。
   */
  private pageTimeoutMs(channel: string): number {
    return reconciliationPageTimeoutMs(this.providerTimeoutMs(channel));
  }

  /** 发告警（钩子出错绝不影响主流程） */
  private emitAlert(event: ChannelAlert): void {
    try {
      this.alerts.alert(event);
    } catch (error) {
      // ⚠️ **告警失败不能盖住原始错误** —— 主流程照常继续
      this.logger.warn(
        `渠道告警发送失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** 渠道声明的单次超时（未声明 / 未注册 → 默认值）；永远不抛错 */
  private providerTimeoutMs(channel: string): number | undefined {
    try {
      const descriptor = this.registry?.descriptor(channel);
      if (descriptor) {
        return descriptor.timeoutMs;
      }
    } catch {
      // 注册表不可用 → 走下面的兜底
    }
    const provider = this.providers.get(channel);
    return provider?.timeoutMs;
  }

  /**
   * 手动触发一次对账（同步执行）。
   *
   * ⚠️ **三道上限**：窗口跨度 ≤ 31 天；渠道记录数 ≤ 10000；
   *    执行 ≤ 页数 × 单页超时（阶段 6b 起不再是固定 30 秒）。
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

    // ⚠️ **预算 = 页数 × 单页超时**（阶段 6b Task 13）——
    //    不再是固定 30 秒：真渠道 20 页 × 单页 2 秒就要 40 秒，
    //    固定 30 秒会把**正常完成**的对账判成超时。
    const pageTimeoutMs = this.pageTimeoutMs(input.channel);
    const budgetMs = reconciliationTimeoutBudget(
      RECONCILIATION_MAX_PAGES,
      pageTimeoutMs,
    );
    const startedAt = Date.now();
    try {
      return await withTimeout(
        this.run(reconciliation.id, input.channel, input.from, input.to),
        budgetMs,
        // ⚠️ **文案仍走 `TimeoutError` 的中文格式**（与现有一致），
        //    括号里补上渠道名与页数，运营才知道该查哪个渠道、扫了多少页。
        `渠道对账（渠道 ${input.channel}，最多 ${RECONCILIATION_MAX_PAGES} 页）`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof TimeoutError) {
        // ⚠️ **只多一条结构化告警，不改变原有行为** —— 任务仍落 FAILED、
        //    错误仍原样抛出。
        this.emitAlert({
          channel: input.channel,
          provider:
            this.providers.get(input.channel)?.provider ?? input.channel,
          operation: 'reconcile',
          elapsedMs: Date.now() - startedAt,
          definitive: false,
          message,
        });
      }
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
      // ⚠️ **静默跳过会在「渠道已启用、对账却不跑」时毫无线索** ——
      //    留一行带渠道名的 warn，至少能在日志里看到原因。
      this.logger.warn(
        `定时对账跳过渠道「${channel}」：该渠道当前不可用于 API 对账` +
          '（未启用 / 仅限非生产 / 尚未适配）。',
      );
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
    const channelRecords = await this.fetchChannelRecords(
      provider,
      expanded.from,
      expanded.to,
    );
    // ⚠️ **渠道侧不承诺输出顺序** —— 假网关按 `referenceNo` 分组输出，
    //    真渠道更是分页/倒序/按状态分组都有 → 排序由比对引擎负责
    //    （引擎内部按 `paidAt` 升序排、`paidAt` 相同时按 `providerTxnId` 兜底）。
    //    ⚠️ **时间窗筛的是「发起打款时刻」** —— 假网关是同步的，两者等同；
    //    真渠道是异步的（发起与到账可能跨天）→ 真渠道接入时这个语义要重定。

    // ---- ② 查本地参与比对的单（按渠道隔离） ----
    const localPayouts = await this.loadLocalPayouts(channel, from, to);

    // ---- ③ 比对 ----
    const output = reconcile({
      window: { from, to },
      expandedWindow: expanded,
      localPayouts,
      channelRecords,
    });

    // ---- ④ 落差异项 + 去重 ----
    const completed = await tenantContext.run(platformScope(), async () => {
      await this.supersedePreviousPending(
        output.diffs,
        reconciliationId,
        channel,
      );
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

    // ---- ⑤ A 类自动纠正（API 来源才自动改钱） ----
    await this.resolver.resolveAutoDiffs(
      output.diffs,
      reconciliationId,
      ReconciliationSource.API,
    );

    return {
      id: reconciliationId,
      status: ReconciliationStatus.COMPLETED,
      diffCount: output.diffs.length,
      matchedCount: output.matchedCount,
    };
  }

  /**
   * 拉渠道侧的流水（**循环翻页**，阶段 5m 技术债）。
   *
   * ⚠️ **必须翻页** —— 真渠道（银行 / 支付渠道）一次拉不动整个时间窗：
   *    对账查询都有分页上限，一个月的流水动辄几万条。
   *    结束条件是「本页不满 `pageSize`」—— 拿满一页说明可能还有下一页。
   *    ⚠️ 这个结束条件**依赖 provider 真的按 `pageSize` 返回**（见
   *    `PayoutProvider.listPayouts` 的契约注释）：某个渠道若自作主张把每页
   *    压得更小（比如最多给 100 条而我们请求 500），这里会在第 1 页就
   *    判定「到底了」→ **静默只拿到一小部分流水**，比对结果全错且不报错。
   *
   * ## 超时预算（阶段 6b Task 13）
   *
   * ⚠️ **总预算 = 页数 × 单页超时**（见 `trigger`），不再是「整轮固定 30 秒」——
   *    真渠道每页 1～2 秒时，10000 条（20 页）要 20～40 秒，固定 30 秒会误判。
   *
   * ⚠️ **翻页保持串行，不并发**：结束条件是「本页不满 `pageSize`」，并发翻页
   *    必须先知道总页数才能扇出，而总页数只能靠逐页探测；并发还会让
   *    `receivedCount` 上限守卫（死循环保险丝）失效 —— 几页同时在途时
   *    条数已经超限也拦不住。收益不值这些代价，超时预算已经解决了问题。
   *
   * @returns 去重后的渠道流水
   */
  private async fetchChannelRecords(
    provider: PayoutProvider,
    from: Date,
    to: Date,
  ): Promise<ChannelPayoutRecord[]> {
    /** 去重后的结果 */
    const records: ChannelPayoutRecord[] = [];
    /** 已见过的渠道交易号（只记非空的） */
    const seenTxnIds = new Set<string>();
    /** ⚠️ **收到的原始条数（含重复）** —— 上限守卫按它算 */
    let receivedCount = 0;

    for (let page = 1; ; page += 1) {
      const rows = await provider.listPayouts({
        from,
        to,
        page,
        pageSize: CHANNEL_LIST_PAGE_SIZE,
      });
      receivedCount += rows.length;
      for (const row of rows) {
        // ⚠️ **按 `providerTxnId` 去重** —— 页码分页的固有缺陷：
        //    翻页期间渠道侧数据变动会让**页边界漂移**，相邻两页可能出现同一条流水。
        //    重复的流水进到比对引擎会被当成两笔 → 产出**假的差异项**，
        //    甚至触发假的「自动纠正」（把真没打出去的单改成已付）。
        // ⚠️ **空串不去重** —— 真渠道可能给空串，按空串去重会让不同的记录互相吞掉。
        if (row.providerTxnId) {
          if (seenTxnIds.has(row.providerTxnId)) {
            continue;
          }
          seenTxnIds.add(row.providerTxnId);
        }
        records.push(row);
      }
      // ⚠️ **累计条数超上限就抛错** ——
      //    ① 文案不能改：运营与文档都按这句话理解；
      //    ② 它同时是**死循环的保险丝** —— 万一某个 provider 实现了分页却
      //       实际忽略分页参数（每页都返回全量），累计条数会在第 2 页就超限
      //       → 不会无限循环；
      //    ③ 按**收到的原始条数**判（含重复），不是去重后的数量 ——
      //       这个守卫的目的是防内存爆掉，要保守。
      if (receivedCount > RECONCILIATION_MAX_CHANNEL_RECORDS) {
        throw new ConflictException(
          `渠道返回了 ${receivedCount} 条流水，超过上限 ${RECONCILIATION_MAX_CHANNEL_RECORDS} 条，请缩小时间窗`,
        );
      }
      if (rows.length < CHANNEL_LIST_PAGE_SIZE) {
        break;
      }
    }
    return records;
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
    // ⚠️ **渠道名先归一化**（阶段 6 审查结论）：`fake-payout ` / `FAKE-PAYOUT`
    //    会被当成另一个渠道 —— 本地单一条都匹配不上，整份账单变成 D 类假告警。
    const channel = normalizeChannel(input.channel);
    if (channel.length === 0) {
      throw new BadRequestException('对账渠道不能为空');
    }
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
          channel,
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

    const localPayouts = await this.loadLocalPayouts(channel, from, to);
    const output = reconcile({
      window: { from, to },
      expandedWindow: { from, to },
      localPayouts,
      channelRecords: input.records,
    });

    await tenantContext.run(platformScope(), async () => {
      await this.supersedePreviousPending(
        output.diffs,
        reconciliation.id,
        channel,
      );
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

    await this.resolver.resolveAutoDiffs(
      output.diffs,
      reconciliation.id,
      ReconciliationSource.FILE,
    );

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
   *
   * ⚠️ **按 `payoutChannel` 精确过滤（阶段 6a）** —— 接了第二家渠道后，
   *    两家渠道在**同一时间窗**内的单会一起落进比对：渠道 A 的账单里没有 B 的单，
   *    于是 B 的单全被判成 D 类假告警，甚至触发假的 A 类自动纠正。
   *
   * ⚠️ **存量单的归属按「平台默认渠道」处理（阶段 6a）** —— 5m 之前落库的单
   *    没有 `payoutChannel`（列是后加的）。第二家渠道一上线，它们会被误判成
   *    「B 渠道的单、A 账单里没有」→ D 类假告警。
   *    所以 `null` 只在 `channel === 平台默认渠道` 时纳入；**解析失败时宁可漏
   *    也不乱纳**（`getPayoutDefaultChannel` 会抛错 → 本次对账直接失败，
   *    运营看到的是配置问题，而不是错得离谱的比对结果）。
   */
  private async loadLocalPayouts(
    channel: string,
    from: Date,
    to: Date,
  ): Promise<LocalPayoutForReconcile[]> {
    return tenantContext.run(platformScope(), async () => {
      const { channel: defaultChannel } =
        await this.settings.getPayoutDefaultChannel();
      // ⚠️ **不能用 `{ in: [channel, null] }`** —— Prisma 的
      //    `StringNullableFilter.in` 只接受 `string[]`（`null` 是用
      //    `equals: null` / 顶层 `OR` 表达的）。写成 `in` 会直接类型报错。
      const channelClause =
        channel === defaultChannel
          ? { OR: [{ payoutChannel: channel }, { payoutChannel: null }] }
          : { payoutChannel: channel };
      const rows = await this.prisma.payout.findMany({
        where: {
          AND: [
            channelClause,
            {
              OR: [
                { paidAt: { gte: from, lt: to } },
                { processingAt: { gte: from, lt: to } },
                { failedAt: { gte: from, lt: to } },
              ],
            },
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
   *
   * ⚠️ **限定到本任务的渠道（阶段 6a）** —— 去重是跨轮次的
   *    （同一个 `(payoutId, type)` 在不同轮次是同一个问题），
   *    但**同一张单只会属于一个渠道** → 把别的渠道的同键 PENDING 项标掉，
   *    等于无声地抹掉另一份账单的差异。所以按 `reconciliation.channel` 过滤。
   * ⚠️ **渠道过滤要下推到查询** —— 差异项表没有 `channel` 列，
   *    用 Prisma 的关系过滤 `reconciliation: { channel }`，不要取回来在内存里筛。
   */
  private async supersedePreviousPending(
    diffs: ReconcileDiff[],
    reconciliationId: string,
    channel: string,
  ): Promise<void> {
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
          reconciliation: { channel },
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
      // ⚠️ **区分两种「不可用」**（阶段 6 审查结论）：
      //    渠道在册但还没适配 API 对账（例如 `sandbox`）时，说「假网关没启用」
      //    会把运营引到 `FAKE_PAYOUT_ENABLED` 上，永远查不到真因。
      if (provider && !this.isFakeChannelUsable(channel)) {
        throw new ConflictException(
          `渠道「${channel}」暂不支持 API 对账（当前仅本地假出款网关支持）：` +
            '请改用 CSV 账单导入。',
        );
      }
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
      // ⚠️ **列表也要 `actionableCount`** —— 否则从列表点进详情前，运营
      //    根本看不出这单有没有可批量确认的东西。
      //    ⚠️ **用 `groupBy` 一次算完当前页**，不能每行 `count()`（N+1）。
      if (items.length === 0) {
        return { items, total };
      }
      const grouped = await this.prisma.payoutReconciliationItem.groupBy({
        by: ['reconciliationId'],
        where: {
          reconciliationId: { in: items.map((item) => item.id) },
          resolution: ReconciliationResolution.PENDING,
          type: ReconciliationDiffType.CHANNEL_PENDING_LOCAL,
          payoutId: { not: null },
        },
        _count: { _all: true },
      });
      const counts = new Map<string, number>(
        grouped.map((row) => [row.reconciliationId, row._count._all]),
      );
      return {
        items: items.map((item) => ({
          ...item,
          actionableCount: counts.get(item.id) ?? 0,
        })),
        total,
      };
    });
  }

  /** 对账任务详情 + 差异列表 */
  async detail(id: string): Promise<unknown> {
    return tenantContext.run(platformScope(), async () => {
      // ⚠️ **第一个查询只取任务本体** —— 差异项要单独查（见下）。
      //    带 `include: { items: true }` 会把**这个任务的全部差异项**捞进内存，
      //    一个任务能产生上万条 → 捞完再截断只是把内存峰值推迟到截断之前。
      const reconciliation = await this.prisma.payoutReconciliation.findFirst({
        where: { id },
      });
      if (!reconciliation) {
        throw new NotFoundException('对账任务不存在');
      }
      // ⚠️ **差异项要在查询层截断** —— 一个对账任务最多能产生上万条差异
      //    （渠道记录数上限就是 10000 条），一次性全吐给浏览器会卡死。
      //    → 截断并**明确告诉前端被截断了**（`itemsTruncated`），
      //    静默截断会让人以为「就这些差异」。
      // ⚠️ **必须按 `reconciliationId` 限定** —— 这张表没有 `tenantId`、
      //    不受租户作用域约束 → 不限定就是**全平台数据泄露**。
      // ⚠️ **要排序，且必须是「双键」** —— 原来靠 `include` 拿到的是无序的。
      //    但只按 `createdAt` 排**不够**：差异项是 `createMany` 批量插的，
      //    `createdAt` 是 `@default(now())` → **同一批次的行可能是同一个毫秒**。
      //    同毫秒内谁先谁后由执行计划决定（更新 / vacuum / 页分裂之后会变）
      //    → `take` 截断后「显示哪 200 条」就飘了，前端看到的差异项会莫名换一批。
      //    → 用 `id` 兜底做二级键，顺序才真的确定。
      //    （同一先例见 `common/payment/payout-verification.service.ts` 的 `orderBy`）
      const items = await this.prisma.payoutReconciliationItem.findMany({
        where: { reconciliationId: id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: RECONCILIATION_MAX_ITEMS,
      });
      // ⚠️ **总数要单独查** —— 截断后 `items.length` 已经不是真实条数，
      //    而前端要靠 `itemsTotal` 知道「还有多少条没显示」。
      const itemsTotal = await this.prisma.payoutReconciliationItem.count({
        where: { reconciliationId: id },
      });
      // ⚠️ **`actionableCount` 是「确认全部」按钮的分母** —— 口径与批量确认的
      //    FILTER 固定条件**逐字一致**（PENDING + A 类 + 有 payoutId），
      //    两边各算一套的话按钮说「250 条」、确认完只有 240 条被处理。
      //    ⚠️ 只有 `source = FILE` 才会大于 0（API 来源的 A 类已自动纠正）。
      //    ⚠️ **API 来源直接给 0，不查库** —— 口径就是「只有 FILE 才可能 > 0」，
      //    多一次 count 只会白白扫一遍差异表。
      const actionableCount =
        reconciliation.source === ReconciliationSource.FILE
          ? await this.prisma.payoutReconciliationItem.count({
              where: {
                reconciliationId: id,
                resolution: ReconciliationResolution.PENDING,
                type: ReconciliationDiffType.CHANNEL_PENDING_LOCAL,
                payoutId: { not: null },
              },
            })
          : 0;
      return {
        ...reconciliation,
        items,
        itemsTruncated: itemsTotal > items.length,
        itemsTotal,
        actionableCount,
      };
    });
  }

  /**
   * 批量确认 CSV 来源的 A 类差异（阶段 6a）。
   *
   * ## 为什么分两种模式
   *
   * - `IDS`：运营勾选了当前列表里的若干条；
   * - `FILTER`：运营点了「确认全部」—— 服务端按**固定条件 + 游标**一次取一批，
   *   客户端循环调用直到 `nextCursor = null`。不一次吃下整张表，理由见
   *   `BATCH_CONFIRM_MAX_ITEMS`。
   *
   * ⚠️ **批量不是「绕过校验」** —— 每一条都要复核「属于该任务 + 仍是 PENDING +
   *    类型是 A 类 + 有 payoutId」；只是省点击，不省校验。
   * ⚠️ **部分成功不回滚** —— 每条 A 类纠正各自独立事务；失败项计入 `failed`，
   *    不静默跳过（运营要能看见哪几条需要单独处理）。
   * ⚠️ **并发靠条件更新** —— 两个人同时点「确认全部」时，每条 `PROCESSING → PAID`
   *    只有一个能命中；后到的计入 `failed`，不会重复打款。
   */
  async batchConfirm(input: BatchConfirmInput): Promise<BatchConfirmResult> {
    const reconciliation = await tenantContext.run(platformScope(), async () =>
      this.prisma.payoutReconciliation.findFirst({
        where: { id: input.reconciliationId },
        select: { id: true, source: true },
      }),
    );
    // ⚠️ **任务不存在也走 409** —— 与「存在但不是 FILE」用同一句文案：
    //    对运营而言两者的处置完全一样（去别的地方确认），分开报只会让人困惑。
    if (
      !reconciliation ||
      reconciliation.source !== ReconciliationSource.FILE
    ) {
      throw new ConflictException('只有账单文件导入的对账任务支持批量确认');
    }

    if (input.mode === 'IDS') {
      return this.batchConfirmByIds(input);
    }
    return this.batchConfirmByFilter(input);
  }

  /** `IDS` 模式：按勾选的差异项逐条复核并确认 */
  private async batchConfirmByIds(input: {
    reconciliationId: string;
    itemIds: string[];
    note: string;
    operatorId: string;
  }): Promise<BatchConfirmResult> {
    const rows = await tenantContext.run(platformScope(), async () =>
      this.prisma.payoutReconciliationItem.findMany({
        where: {
          reconciliationId: input.reconciliationId,
          id: { in: input.itemIds },
        },
      }),
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    const succeeded: string[] = [];
    const failed: BatchConfirmFailure[] = [];
    // ⚠️ **按请求里的顺序处理** —— 前端拿 `failed` 对回自己勾的行时顺序稳定
    for (const itemId of input.itemIds) {
      const item = byId.get(itemId);
      const failure = this.assertBatchActionable(item);
      if (failure) {
        failed.push({ id: itemId, message: failure });
        continue;
      }
      const ok = await this.resolver.manualCorrectToPaid({
        payoutId: item!.payoutId!,
        channelTxnId: item!.channelTxnId,
        action: PayoutOperationAction.RECONCILE_TO_PAID_BY_FILE,
        operatorId: input.operatorId,
        reason: `CSV 账单批量确认：${input.note}`,
        reconciliationId: input.reconciliationId,
        itemId,
        note: input.note,
      });
      if (ok) {
        succeeded.push(itemId);
      } else {
        failed.push({
          id: itemId,
          message: '出款单已不是「打款中」状态（可能已被处理），未做改动',
        });
      }
    }
    return { succeeded, failed, nextCursor: null };
  }

  /** `FILTER` 模式：按游标取一批固定条件下的差异项并确认 */
  private async batchConfirmByFilter(input: {
    reconciliationId: string;
    cursor?: string;
    limit?: number;
    note: string;
    operatorId: string;
  }): Promise<BatchConfirmResult> {
    // ⚠️ **上限在服务层再夹一次** —— DTO 会挡 201，但中转路由 / 其它调用方
    //    未必经过 DTO；游标分页的「有界」是这个接口的核心约束。
    const limit = Math.min(
      Math.max(input.limit ?? BATCH_CONFIRM_MAX_ITEMS, 1),
      BATCH_CONFIRM_MAX_ITEMS,
    );
    const rows = await tenantContext.run(platformScope(), async () =>
      this.prisma.payoutReconciliationItem.findMany({
        where: {
          reconciliationId: input.reconciliationId,
          resolution: ReconciliationResolution.PENDING,
          type: ReconciliationDiffType.CHANNEL_PENDING_LOCAL,
          payoutId: { not: null },
          ...(input.cursor ? { id: { gt: input.cursor } } : {}),
        },
        orderBy: { id: 'asc' },
        take: limit,
      }),
    );
    const succeeded: string[] = [];
    const failed: BatchConfirmFailure[] = [];
    for (const item of rows) {
      const ok = await this.resolver.manualCorrectToPaid({
        payoutId: item.payoutId!,
        channelTxnId: item.channelTxnId,
        action: PayoutOperationAction.RECONCILE_TO_PAID_BY_FILE,
        operatorId: input.operatorId,
        reason: `CSV 账单批量确认：${input.note}`,
        reconciliationId: input.reconciliationId,
        itemId: item.id,
        note: input.note,
      });
      if (ok) {
        succeeded.push(item.id);
      } else {
        failed.push({
          id: item.id,
          message: '出款单已不是「打款中」状态（可能已被处理），未做改动',
        });
      }
    }
    // ⚠️ **游标前进到本批最后一条（失败项也前进）** —— 否则失败项会卡在
    //    游标前面被无限重试。拿满一批才给游标；不满说明到底了。
    const last = rows[rows.length - 1];
    const nextCursor = rows.length === limit && last ? last.id : null;
    return { succeeded, failed, nextCursor };
  }

  /** 复核一条差异项能否批量确认：返回失败原因，`null` 表示可以 */
  private assertBatchActionable(
    item:
      | {
          resolution: ReconciliationResolution;
          type: ReconciliationDiffType;
          payoutId: string | null;
        }
      | undefined,
  ): string | null {
    if (!item) {
      return '差异项不存在或不属于该对账任务';
    }
    if (item.resolution !== ReconciliationResolution.PENDING) {
      return '该差异项已被处置，无需重复确认';
    }
    if (item.type !== ReconciliationDiffType.CHANNEL_PENDING_LOCAL) {
      return '该差异项不属于「渠道已打款、本地处理中」，不能批量确认';
    }
    if (!item.payoutId) {
      return '该差异项没有关联的出款单，不能批量确认';
    }
    return null;
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
      // ⚠️ **在数据库里聚合，不要把全部未处置差异拉进内存数** ——
      //    差异表会越积越多（一个对账任务就能产生上万条）→ 全表扫会把内存打爆。
      const grouped = await this.prisma.payoutReconciliationItem.groupBy({
        by: ['severity'],
        where: { resolution: ReconciliationResolution.PENDING },
        _count: { _all: true },
      });
      // ⚠️ **缺哪一档就是 0** —— `groupBy` 只返回**出现过**的取值，
      //    直接把 `undefined` 放进返回值会让口径漂移（前端拿到 undefined）。
      const countOf = (severity: ReconciliationSeverity): number =>
        grouped.find((g) => g.severity === severity)?._count._all ?? 0;
      return {
        pendingCritical: countOf(ReconciliationSeverity.CRITICAL),
        pendingWarning: countOf(ReconciliationSeverity.WARNING),
        pendingInfo: countOf(ReconciliationSeverity.INFO),
      };
    });
  }
}
