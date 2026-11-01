import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PayoutStatus, SettlementStatus } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import {
  platformScope,
  tenantContext,
} from '../../common/tenant/tenant-context';
import { PAYOUT_VERIFICATION } from '../../common/payment/payout-verification';
// ⚠️ **必须 `import type`** —— `PayoutVerification` 是接口，被用在
//    带装饰器的构造器参数上（`emitDecoratorMetadata` + `isolatedModules`
//    下，TS1272 要求装饰器签名里引用的类型必须是 type-only 导入）。
import type { PayoutVerification } from '../../common/payment/payout-verification';
import { PayoutCipherService } from './payout-cipher.service';

/** 打款的结果（worker 传给本服务） */
export interface MarkPaidInput {
  /** 渠道交易号 */
  providerTxnId: string;
  /** 打款渠道名 */
  channel: string;
  /** 打款成功的时刻（数据库时钟） */
  paidAt: Date;
}

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
  /**
   * ⚠️ **新增**（阶段 5m）：渠道交易号。失败时渠道也会给 —— 不存就无从核实。
   *
   * ⚠️ **只在渠道被调用过时才传** —— 渠道压根没被调用时传假值会污染核实判断。
   * ⚠️ **不传就不写**（`undefined` 会被 Prisma 忽略）—— 不能覆盖已有的值。
   */
  providerTxnId?: string;
}

/** 退回 APPROVED 等下一次重试的结果 */
export interface ScheduleRetryInput {
  /** 退回的时刻（数据库时钟） */
  now: Date;
  /** 本次失败的原因（记进 `failureReason`，给运营看） */
  reason: string;
}

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

/**
 * 出款执行的状态落库服务（阶段 5h-2）。
 *
 * ⚠️ **这是状态落库的唯一入口** —— worker 只调它，不自己写库。
 *    状态机的每一条转换都要带条件更新 + 同事务释放明细，
 *    分散在 worker 里一定会漏掉某一条。
 *
 * ⚠️ **全部跑在平台作用域下**：`payouts` 在租户白名单里，
 *    而队列消费端只知道一个 `payoutId`，不知道租户是谁
 *    （跨进程边界，`AsyncLocalStorage` 的上下文不跟着走）。
 *    平台作用域下扩展**不附加** tenantId 条件 → 查到的是全局事实。
 */
@Injectable()
export class PayoutExecutionService {
  private readonly logger = new Logger(PayoutExecutionService.name);

  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly cipher: PayoutCipherService,
    // ⚠️ **注入核实服务**（阶段 5m）—— B 类人工处置的闸 ④ 要用。
    //    按 token 注入（契约在 `common/`）→ **不产生 billing → payment 的模块边**。
    @Inject(PAYOUT_VERIFICATION)
    private readonly verification: PayoutVerification,
  ) {}

  /**
   * 抢单：`APPROVED → PROCESSING`，`attemptCount + 1`。
   *
   * ⚠️ **这是护栏 X1 的落点**：条件更新（`where` 带 `status: APPROVED`）
   *    保证「同一张出款单只有一个 worker 能抢到」。
   *    抢不到就返回 `null`，调用方**静默返回** —— 不重试、不落 `FAILED`
   *    （BullMQ 会把它记成失败 job，排查时全是假故障）。
   *
   * ⚠️ **金额与账户快照在这里一次性读出**：worker 后面只用自己的返回值，
   *    不再查库、不重算（护栏 X2 / X2b）。
   *
   * @param now 进 `PROCESSING` 的时刻（数据库时钟）
   */
  async claimForExecution(
    payoutId: string,
    now: Date,
  ): Promise<ExecutionClaim | null> {
    return tenantContext.run(platformScope(), async () => {
      // ⚠️ **抢单与读回在同一个事务里** —— 分开写的话，
      //    「已改成 PROCESSING 但还没读回金额」这个窗口里，
      //    另一个 worker 读到的可能是旧值。
      return this.prisma.$transaction(async (tx) => {
        const affected = await tx.payout.updateMany({
          where: { id: payoutId, status: PayoutStatus.APPROVED },
          data: {
            status: PayoutStatus.PROCESSING,
            processingAt: now,
            attemptCount: { increment: 1 },
          },
        });
        if (affected.count === 0) {
          return null;
        }
        const payout = await tx.payout.findFirst({
          where: { id: payoutId },
          select: {
            attemptCount: true,
            netAmount: true,
            payoutNo: true,
            snapshotAccountName: true,
            snapshotBankName: true,
            snapshotAccountNoCipher: true,
            snapshotMaskedAccountNo: true,
            snapshotEncryptionVersion: true,
          },
        });
        if (!payout) {
          return null;
        }
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
      });
    });
  }

  /**
   * 记录**本次实际调用的出款渠道名**到 `payouts.payoutChannel`。
   *
   * ⚠️ **为什么必须在「调渠道之前」写** —— 原来 `payoutChannel` 只有
   *    `markPaid` 才写 → 一张卡在 `PROCESSING` 的单渠道名是 `null`：
   *    ① `payout-reconciliation-resolver` 拿不到值，只能硬回落成 `'fake-payout'`；
   *    ② 将来接第二家渠道时，`PROCESSING` 的单**定位不到渠道** ——
   *    解卡核实闸（`pickProvider`）与打款 worker（`firstProvider`）都是
   *    「取第一个注册的渠道」，将来要改成「按 `payouts.payoutChannel` 取」，
   *    前提就是这里先把渠道名写上。
   *
   * ⚠️ **只写 `payoutChannel` 一个字段** —— 状态机与重试预算由本服务独家管，
   *    越权写状态会绕开条件更新。`where` 带 `status: PROCESSING`：
   *    状态已被别人改过（对账纠正 / 人工处置）时不会误写。
   *
   * ⚠️ **落库失败不阻断打款是调用方的决策** —— 打款是主流程，
   *    「记一下渠道名」是辅助动作。DB 抖动时若因此放弃打款，钱就
   *    **永远打不出去**（单子卡在 `PROCESSING`，兜底扫描只告警、绝不重试）
   *    → 商家永远收不到钱，且没有补偿路径。反过来，渠道名没记上的后果
   *    只是「这张单的对账口径退化成人工判断」，远小于「钱没打出去」。
   *    → 这里**抛出去**，由 worker 捕获后记 warn 日志再继续打款。
   *
   * ⚠️ **不抛异常的两件事**：DB 报错向上抛（调用方决定要不要阻断），
   *    但 `count === 0`（状态已被改过）**不抛** —— 那不是错误，
   *    只是「这张单的渠道名没记上」，只记 warn 日志。
   *
   * @param payoutId 出款单 id
   * @param channel 本次实际调用的渠道名
   */
  async recordChannel(payoutId: string, channel: string): Promise<void> {
    await tenantContext.run(platformScope(), async () => {
      const affected = await this.prisma.payout.updateMany({
        where: { id: payoutId, status: PayoutStatus.PROCESSING },
        data: { payoutChannel: channel },
      });
      if (affected.count === 0) {
        // ⚠️ **要补日志** —— 状态已经被别人改过（对账纠正 / 人工处置），
        //    这张单的渠道名没记上。不留痕的话事后无从判断它到底走的哪家渠道。
        this.logger.warn(
          `出款 ${payoutId} 记录出款渠道未命中（状态已变），渠道 ${channel}`,
        );
      }
    });
  }

  /**
   * 打款成功：`PROCESSING → PAID`，并把引用的结算单一并转 `PAID`。
   *
   * ⚠️ **结算单联动在同一个事务里**（设计 §6.5）：
   *    钱已经打出去了，账上没跟上 = 账实不符。
   *
   * ⚠️ **结算单用条件 `status: CONFIRMED`**（不是 `PAID`）：
   *    已 `PAID` 的结算单被另一张单再触发时 `count === 0`，**不报错**（幂等）。
   *
   * ⚠️ **补差单不改结算单状态**（护栏 X6）：
   *    结算单在正常单 `PAID` 时已经转过了。
   */
  async markPaid(payoutId: string, input: MarkPaidInput): Promise<boolean> {
    return tenantContext.run(platformScope(), async () => {
      const result = await this.prisma.$transaction(async (tx) => {
        const affected = await tx.payout.updateMany({
          where: { id: payoutId, status: PayoutStatus.PROCESSING },
          data: {
            status: PayoutStatus.PAID,
            paidAt: input.paidAt,
            payoutChannel: input.channel,
            payoutTxnId: input.providerTxnId,
            // ⚠️ **失败原因要清掉**：重试成功后之前那次失败的原因不该留着
            failureReason: null,
            // ⚠️ **新增**（阶段 5m）：`failedAt` 与 `failedBeforePayout` 也要清。
            //    残留的 `failedAt` 会让这张单落进**另一个**对账窗口；
            //    停在 `true` 的 `failedBeforePayout` 会让一张 `PAID` 的单
            //    带着「钱确定没打出去」的标记 —— 语义自相矛盾。
            failedAt: null,
            failedBeforePayout: false,
          },
        });
        if (affected.count === 0) {
          // ⚠️ **补日志**（阶段 5m）—— 现状是完全静默。
          //    对账纠正与 worker 可能撞车（worker 先落了 `PAID`），
          //    这时「渠道打了两次」的怀疑无法排除 → 有日志才查得清。
          this.logger.warn(
            `出款 ${payoutId} 的 markPaid 未命中（状态已变，可能已被对账纠正或人工处理）`,
          );
          return false;
        }

        const payout = await tx.payout.findFirst({
          where: { id: payoutId },
          select: { kind: true, statementId: true },
        });

        // ⚠️ **只有正常单才联动结算单**（X6）
        if (payout && payout.kind === 'NORMAL' && payout.statementId) {
          await tx.settlementStatement.updateMany({
            where: {
              id: payout.statementId,
              status: SettlementStatus.CONFIRMED,
            },
            // ⚠️ **`paidAt` 与 `status` 同一次 `data` 里写** ——
            //    分开写会出现「status=PAID 但 paidAt=null」的矛盾行
            data: { status: SettlementStatus.PAID, paidAt: input.paidAt },
          });
        }
        return true;
      });

      this.logger.log(`出款已打款：${payoutId}（渠道 ${input.channel}）`);
      return result;
    });
  }

  /**
   * 打款失败（超过重试上限）：`PROCESSING → FAILED` + **释放明细占用**。
   *
   * ⚠️ **释放明细是必须的**：`payout_entries.entryId` 是全局唯一索引。
   * 不释放的话，商家重新申请同一期会撞索引 → P2002 → 500。
   * 这是 5h-1 在「拒绝 / 撤回」上踩过的同一个坑（E5），`FAILED` 是第三条释放路径。
   *
   * ⚠️ **`statementId` 不清**：失败的单仍然引用那张结算单。
   *    P6 闸已经把 `FAILED` 加进排除列表，所以它不挡「取消确认」（设计 §6.4）。
   */
  async markFailed(payoutId: string, input: MarkFailedInput): Promise<boolean> {
    return tenantContext.run(platformScope(), async () => {
      const result = await this.prisma.$transaction(async (tx) => {
        const affected = await tx.payout.updateMany({
          where: { id: payoutId, status: PayoutStatus.PROCESSING },
          data: {
            status: PayoutStatus.FAILED,
            failedAt: input.failedAt,
            failureReason: input.reason,
            // ⚠️ **「钱确定没打出去」的标记**（阶段 5l）——
            //    平台端的「重试」按钮只对 true 的单出现。
            failedBeforePayout: input.failedBeforePayout ?? false,
            // ⚠️ **新增**（阶段 5m）：存渠道交易号。
            //    `payoutTxnId` 的唯一写入点原本是 `markPaid` → `FAILED` 的单
            //    没有交易号 → 「实时核实」对它们无从谈起。
            //    ⚠️ **`undefined` 会被 Prisma 忽略** → 渠道没被调用时不会写入空值，
            //    也不会覆盖已有的交易号。
            payoutTxnId: input.providerTxnId,
          },
        });
        if (affected.count === 0) {
          return false;
        }
        // ⚠️ **与状态更新同一个事务** —— 分开写会出现
        //    「状态已 FAILED、明细还占着」的窗口
        //
        // ⚠️ **读 id 与删明细必须同事务**（阶段 5m）—— 分开写会出现
        //    「明细已删、id 没记上」的窗口 → 这张单永远复原不了（只能落人工处理）。
        const releasedEntries = await tx.payoutEntry.findMany({
          where: { payoutId },
          select: { entryId: true },
        });
        await tx.payoutEntry.deleteMany({ where: { payoutId } });
        if (releasedEntries.length > 0) {
          // ⚠️ **只有释放了明细才记** —— 没有明细可释放时不要写空数组，
          //    否则 B 类处置会误判「可复原」（闸 ① 要的是「当初那批」，
          //    空数组意味着「当初就没有明细」→ 与 null 的语义不同）
          await tx.payout.updateMany({
            where: { id: payoutId },
            data: {
              releasedEntryIds: JSON.stringify(
                releasedEntries.map((e) => e.entryId),
              ),
            },
          });
        }
        return true;
      });

      this.logger.warn(
        `出款失败（已达重试上限）：${payoutId} —— ${input.reason}`,
      );
      return result;
    });
  }

  /**
   * B 类人工处置：`FAILED → PAID`（阶段 5m）。
   *
   * ⚠️ **必须复原明细** —— `markFailed` 释放了 `payout_entries`，
   *    不复原的话这批流水在出款维度上**凭空消失**（商家少拿、账上无出款记录）。
   * ⚠️ **不能用「重算」复原** —— 补差单的纳入范围依赖 `payout_entries` 本身，
   *    明细已释放 → 重算失真 → 复原不出「当初那批」。只能用 `releasedEntryIds`。
   *
   * ## 四道闸（缺一不可）
   *
   * | 闸 | 检查 |
   * |---|---|
   * | ① 明细可复原 | `releasedEntryIds` 非空 |
   * | ② 金额与笔数 | **带符号**金额之和 == `receiptAmount` 且笔数 == `entryCount`；另校验 `netAmount == receiptAmount − commissionAmount` |
   * | ③ 明细未被他人占用 | 那些 `entryId` 是否已被**别的**出款单占用 |
   * | ④ 渠道核实 + 结算单状态 | 渠道说 SUCCESS？结算单状态允许联动？ |
   *
   * ## ⚠️ **核实对象与结算单一律从库里读到的 `payout` 取**（阶段 5m 审查修正）
   *
   * ⚠️ **不能由调用方指定** —— 核实对象（`payoutNo`）与结算单（`statementId`）
   *    一旦允许调用方传入，闸 ④ 就形同虚设：
   *    传别的单的 `payoutNo` → 核实的是**别的单**，
   *    渠道说「那单打了」 → 闸放行 → 把**这张**单改成已付款 → 重复付款。
   *    传别的单的 `statementId` → 结算单状态检查看的不是**这张单**的结算单。
   *    → 这两个字段已从方法签名里**删除**，调用方无法再影响闸 ④。
   *
   * @throws ConflictException 闸没过时抛（业务错误，不冒成 500）
   */
  async confirmPaidAfterReconciliation(
    payoutId: string,
    input: {
      /** 人工确认的原因（会进留痕） */
      reason: string;
      /** 操作人（平台超管的用户 id） */
      operatorId: string;
      /** 关联的对账任务 id */
      reconciliationId?: string;
    },
  ): Promise<boolean> {
    const trimmed = input.reason?.trim() ?? '';
    if (!trimmed) {
      throw new BadRequestException('操作原因不能为空');
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
          `出款单状态已变（当前是 ${payout.status}），只有记成失败的出款单能确认已付款`,
        );
      }

      // ---- 闸 ①：明细可复原 ----
      const releasedEntryIds = this.parseReleasedEntryIds(
        payout.releasedEntryIds,
      );
      if (releasedEntryIds.length === 0) {
        throw new ConflictException(
          '这张出款单的明细无法复原（没有记录被释放的流水），需人工处理',
        );
      }

      // ---- 闸 ②：金额与笔数对得上 ----
      //
      // ⚠️ **必须显式带 `tenantId`**（阶段 5m 审查修正）——
      //    `MerchantReceipt` **在租户白名单里**，但本方法跑在**平台作用域**
      //    （`tenantContext.run(platformScope(), ...)`）→
      //    租户扩展对平台作用域**不附加任何过滤**（`resolveScope` 返回
      //    `{ kind: 'platform' }`，见 `tenant-prisma.service.ts`）。
      //    → 不显式带 `tenantId` 就是**跨租户读**：
      //    别的租户恰好有同 id 的流水时，会被算进本单的金额合计里
      //    → 闸 ② 拿错数据算账（补差单的明细校验尤其致命）。
      //    显式带上是**纵深防御**：即使将来作用域判定变了，这里仍然安全。
      const receipts = await this.prisma.merchantReceipt.findMany({
        where: { id: { in: releasedEntryIds }, tenantId: payout.tenantId },
        select: { id: true, amount: true },
      });
      if (receipts.length !== releasedEntryIds.length) {
        throw new ConflictException(
          '被释放的货款流水已被删除，明细无法复原，需人工处理',
        );
      }
      // ⚠️ **带符号求和** —— `merchant_receipts.amount` 的冲回是负数，
      //    取绝对值会把「退了一笔」算成「多了一笔」。
      const sum = receipts.reduce((acc, r) => acc + r.amount, 0);
      if (sum !== payout.receiptAmount) {
        throw new ConflictException(
          `明细金额与出款单对不上（明细合计 ${sum} 分，出款单 ${payout.receiptAmount} 分），账已漂移，需人工账务处理`,
        );
      }
      if (receipts.length !== payout.entryCount) {
        throw new ConflictException(
          `明细笔数与出款单对不上（明细 ${receipts.length} 笔，出款单 ${payout.entryCount} 笔），需人工账务处理`,
        );
      }
      if (payout.netAmount !== payout.receiptAmount - payout.commissionAmount) {
        throw new ConflictException(
          '出款单的金额不自洽（净额 ≠ 货款 − 佣金），需人工账务处理',
        );
      }

      // ---- 闸 ③：明细未被他人占用 ----
      // ⚠️ **`payout_entries` 不在租户白名单** → 扩展不附加任何过滤 →
      //    这次查询会**跨租户读到全平台**的行。
      //    ⚠️ **读到不等于泄露**：结果只用于「有没有被占用」的布尔判断，
      //    不返回给调用方、不写进响应、不进留痕。
      //    ⚠️ **判定条件是「同租户 + 同期」** —— 而 `payout_entries` 自己
      //    没有 `tenantId`、没有 `periodStart`（只有 `payoutId` 与 `entryId`）
      //    → 只能 join `payout` 拿到这两个值，再在应用层比对。
      //    （写进 `where` 的嵌套过滤也等价，但要先取到 `payout.periodStart`
      //    这个具体时刻，写起来更绕。）
      const occupied = await this.prisma.payoutEntry.findMany({
        where: {
          entryId: { in: releasedEntryIds },
          // ⚠️ **排除本单自己**（本单的明细已被释放，理论上查不到，
          //    但别的出款单占用时要能查出来）
          NOT: { payoutId },
        },
        select: {
          entryId: true,
          payout: { select: { tenantId: true, periodStart: true } },
        },
      });
      const conflicting = occupied.filter(
        (e) =>
          e.payout.tenantId === payout.tenantId &&
          e.payout.periodStart.getTime() === payout.periodStart.getTime(),
      );
      if (conflicting.length > 0) {
        throw new ConflictException(
          '这批流水已被同期的另一个出款单占用，疑似重复付款，需人工退款处理',
        );
      }

      // ---- 闸 ④：渠道核实 + 结算单状态 ----
      //
      // ⚠️ **核实对象一律取自库里读到的 `payout`**（阶段 5m 审查修正）——
      //    之前这里是 `input.payoutNo ?? payout.payoutNo`，而 `input.payoutNo`
      //    由调用方传入 → 传别的单的号就能核实别的单 → **闸 ④ 被完全绕过**
      //    （渠道说「那单打了」→ 放行 → 这张单被改成已付款 → 重复付款）。
      //    → `input.payoutNo` 已从签名删除，核实对象不再受调用方影响。
      const verdict = await this.verification.verify({
        id: payout.id,
        payoutNo: payout.payoutNo,
        payoutTxnId: payout.payoutTxnId,
      });
      if (verdict.verdict !== 'PAID') {
        throw new ConflictException(
          '渠道核实没有确认这笔已打款，无法标记为已付款（请先执行渠道对账）',
        );
      }

      // ⚠️ **结算单一律取自库里读到的 `payout`**（同上）——
      //    `input.statementId` 已从签名删除 → 闸 ④ 看的结算单
      //    永远是**这张单自己的**结算单。
      const statementId = payout.statementId;
      if (statementId) {
        //
        // ⚠️ **必须显式带 `tenantId`**（阶段 5m 审查修正）——
        //    `SettlementStatement` **在租户白名单里**，但本方法跑在
        //    **平台作用域** → 租户扩展**不附加任何过滤**
        //    （`resolveScope` 在平台作用域返回 `{ kind: 'platform' }`）。
        //    → 不显式带就是**跨租户读**：查到的可能是别的租户的结算单
        //    → 拿它的状态当闸 ④ 的判据 → 闸 ④ 形同虚设。
        const statement = await this.prisma.settlementStatement.findFirst({
          where: { id: statementId, tenantId: payout.tenantId },
          select: { status: true },
        });
        // ⚠️ **`statementId` 为 null 是常态**（零额抽佣的商家该期没有结算单）
        //    → 跳过联动，不算异常。
        if (statement) {
          if (
            statement.status !== SettlementStatus.CONFIRMED &&
            statement.status !== SettlementStatus.PAID
          ) {
            throw new ConflictException(
              '关联的结算单状态不允许联动（只有已确认或已付款的可以），需人工处理',
            );
          }
        }
      }

      // ---- 通过四闸：执行 ----
      const paidAt = await this.prisma.databaseNow();
      try {
        await this.prisma.$transaction(async (tx) => {
          // 1. 还原明细
          await tx.payoutEntry.createMany({
            data: releasedEntryIds.map((entryId) => ({ payoutId, entryId })),
            skipDuplicates: false,
          });

          // 2. 转 PAID
          //
          // ⚠️ **必须看 `affected.count`**（阶段 5m 审查修正）——
          //    条件更新 `status: FAILED` 没命中，说明状态**已被别人改了**
          //    （worker 先落了 `PAID`，或另一路人工处置已经改过）。
          //    之前这里无视返回值 → 事务照样提交 → 下面第 4 步写一条留痕
          //    说「从 FAILED 改到 PAID」，**但状态根本没改** → 留痕会说谎，
          //    而留痕是事后追责的唯一凭据。
          //    → 没命中就抛出去，让整个事务回滚（不留痕、不改结算单）。
          const paidAffected = await tx.payout.updateMany({
            where: { id: payoutId, status: PayoutStatus.FAILED },
            data: {
              status: PayoutStatus.PAID,
              paidAt,
              payoutChannel: payout.payoutChannel ?? 'fake-payout',
              payoutTxnId: verdict.providerTxnId ?? payout.payoutTxnId,
              failureReason: null,
              // ⚠️ **要清空** —— 它们记的是「落 FAILED 那一刻」的判断，
              //    现在是 PAID 了，留着会误导
              failedAt: null,
              failedBeforePayout: false,
              // ⚠️ **attemptCount 不重置** —— 钱已经打了，次数是历史事实
            },
          });
          if (paidAffected.count === 0) {
            throw new ConflictException(
              '出款单状态已变（可能已被对账纠正或人工处理过），无法标记为已付款',
            );
          }

          // 3. 结算单联动（`statementId` 为 null 时跳过）
          //
          // ⚠️ **只有正常单才联动结算单**（护栏 X6）——
          //    补差单（`kind === 'SUPPLEMENT'`）**不改结算单状态**：
          //    结算单在正常单 `PAID` 时已经转过了，补差单再转一次就是重复联动。
          //    （与 `markPaid` 里的同一道护栏保持一致。）
          if (statementId && payout.kind === 'NORMAL') {
            const statementAffected = await tx.settlementStatement.updateMany({
              where: { id: statementId, status: SettlementStatus.CONFIRMED },
              data: { status: SettlementStatus.PAID, paidAt },
            });
            // ⚠️ **这里没命中是正常的，不抛错** —— 结算单可能已经是 `PAID`
            //    （另一张单先联动过了）→ 幂等，不是异常。
            //    但**要记日志**：count === 0 且结算单确实存在时，
            //    说明它处于一个「既不是 CONFIRMED 也不是 PAID」的中间态
            //    （闸 ④ 允许的是 CONFIRMED / PAID）→ 值得留痕排查。
            if (statementAffected.count === 0) {
              this.logger.warn(
                `出款 ${payoutId} 的结算单 ${statementId} 联动未命中` +
                  '（状态不是 CONFIRMED —— 可能已被其他单联动，或处于中间态）',
              );
            }
          }

          // 4. 留痕
          await tx.payoutOperation.create({
            data: {
              payoutId,
              action: 'MANUAL_CONFIRM_PAID',
              operatorId: input.operatorId,
              reason: trimmed,
              fromStatus: PayoutStatus.FAILED,
              toStatus: PayoutStatus.PAID,
              attemptCountBefore: payout.attemptCount,
              reconciliationId: input.reconciliationId ?? null,
            },
          });
        });
      } catch (error) {
        // ⚠️ **数据库是最后一道兜底** —— 撞部分唯一索引
        //    `payouts_tenantId_period_kind_active_uniq` 说明商家已经重新申请过
        //    同一期 → **必须翻成业务错误**，不能让它冒成 500。
        if (this.isUniqueViolation(error)) {
          throw new ConflictException(
            '出款单状态已变（商家可能已重新申请同一期），无法标记为已付款',
          );
        }
        throw error;
      }

      this.logger.log(
        `对账人工确认已付款：${payoutId}（操作人 ${input.operatorId}）`,
      );
      return true;
    });
  }

  /** 解析 `releasedEntryIds`（JSON 数组字符串）；解析不出就当「不可复原」 */
  private parseReleasedEntryIds(raw: string | null): string[] {
    if (!raw) {
      return [];
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter((v): v is string => typeof v === 'string');
    } catch {
      return [];
    }
  }

  /** 判断是不是 Prisma 的唯一约束冲突（P2002） */
  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: string }).code === 'P2002'
    );
  }

  /**
   * 退回 `APPROVED` 等下一次重试。
   *
   * ⚠️ **必须清 `processingAt`**：不清的话，兜底扫描会把这些
   *    「正在等重试」的单当成「卡住的单」重复捞出来（噪声 + 平台端误标红）。
   *
   * ⚠️ **不重置 `attemptCount`**：重置了就不会收敛到 `FAILED`（护栏 X7）。
   *
   * ⚠️ **不刷新 `approvedAt`** —— 它的语义是「审批时间」，刷新它会让
   *    平台端显示的审批时间变成假的。
   *
   * @returns 新的 `attemptCount`（供调用方拼下一次入队的 jobId）；
   *          `null` = **不重试**（状态已被改掉，或读不到行）
   */
  async scheduleRetry(
    payoutId: string,
    input: ScheduleRetryInput,
  ): Promise<number | null> {
    return tenantContext.run(platformScope(), async () => {
      return this.prisma.$transaction(async (tx) => {
        const affected = await tx.payout.updateMany({
          where: { id: payoutId, status: PayoutStatus.PROCESSING },
          data: {
            status: PayoutStatus.APPROVED,
            processingAt: null,
            failureReason: input.reason ?? null,
          },
        });
        if (affected.count === 0) {
          return null;
        }
        const payout = await tx.payout.findFirst({
          where: { id: payoutId },
          select: { attemptCount: true },
        });
        // ⚠️ **读不到行就返回 `null`（不重试）**，不能返回 `0` ——
        //    调用方会拿 `0` 算出 `delay = 0` 并入队 `payout-{id}-0`
        //    → **立即重投**（绕过退避），抢跑重试预算。
        if (!payout) {
          return null;
        }
        return payout.attemptCount;
      });
    });
  }

  /**
   * 记「已告警过卡死」—— **只写 `stuckLoggedAt`，不改状态、不入队**。
   *
   * ⚠️ **绝不能在这里重试**：卡在 `PROCESSING` 的单最可能的成因是
   *    「请求发出去了、回包丢了」—— 钱**可能已经打到商家账上**。
   *    退回 `APPROVED` 再入队 = **确定性地重复打款**（设计 §九·R3）。
   *
   * ⚠️ **`stuckLoggedAt` 是「告警去重」，不是「已处理」**：
   *    写了它不代表有人处理了，只代表「已经告警过了」。
   *    「它还在卡」由平台端列表实时标红暴露（前端按 `processingAt` 判定）。
   */
  async markStuckLogged(payoutIds: string[], now: Date): Promise<number> {
    if (payoutIds.length === 0) {
      return 0;
    }
    return tenantContext.run(platformScope(), async () => {
      const affected = await this.prisma.payout.updateMany({
        where: { id: { in: payoutIds }, status: PayoutStatus.PROCESSING },
        data: { stuckLoggedAt: now },
      });
      return affected.count;
    });
  }

  /**
   * 扫描卡住的出款单。
   *
   * ## 两类「卡住」，处理方式**完全相反**
   *
   * | 状态 | 含义 | 处理 |
   * |------|------|------|
   * | `PROCESSING` | 请求**可能已经打出去了**，只是回包丢了 | **只告警，绝不重试** |
   * | `APPROVED` | **确定还没打**（还没进 `PROCESSING`） | **重新入队**（安全） |
   *
   * ⚠️ **`PROCESSING` 绝不自动重试**（设计 §九·R3）：
   *    卡在 `PROCESSING` 最可能的成因是「请求发出去了、回包丢了」——
   *    钱**可能已经打到商家账上**。退回 `APPROVED` 再入队 =
   *    **确定性地重复打款**。所以只标出来给人看。
   *
   * ⚠️ **`APPROVED` 必须救援**：审批后要入队，入队可能失败（Redis 抖动）。
   *    没有兜底的话，那张单会永远停在 `APPROVED` ——
   *    商家看到「已审批」、平台看到「已审批」，**没有任何一方知道它没打出去**，
   *    流水还被占着（商家重新申请撞 `payout_entries` 唯一索引 → 500）。
   *    `APPROVED` 状态**确定没打出去**（还没进 `PROCESSING`），重新入队是安全的。
   *
   * ⚠️ **但只救「从未被执行过」的单**（`attemptCount = 0`）——
   *    正在退避等待重试的单状态也是 `APPROVED`，捞进来会与重试 job 抢跑。
   *
   * @param now 数据库时钟
   * @param stuckThresholdMs 卡住多久算卡住（默认 10 分钟）
   * @returns 需要重新入队的出款单 id 与其尝试次数（`APPROVED` 且超时的）
   */
  async scanStuck(
    now: Date,
    stuckThresholdMs = 10 * 60 * 1000,
  ): Promise<Array<{ id: string; attemptCount: number }>> {
    return tenantContext.run(platformScope(), async () => {
      const threshold = new Date(now.getTime() - stuckThresholdMs);

      // ---- ① PROCESSING 卡死：只告警，不改状态 ----
      const stuck = await this.prisma.payout.findMany({
        where: {
          status: PayoutStatus.PROCESSING,
          processingAt: { lt: threshold },
          // ⚠️ **只捞还没告警过的** —— 不写 `stuckLoggedAt` 的话，
          //    每 5 分钟就把同一张单捞出来再打一遍日志
          stuckLoggedAt: null,
        },
        select: { id: true, payoutNo: true, attemptCount: true },
      });
      if (stuck.length > 0) {
        await this.markStuckLogged(
          stuck.map((p) => p.id),
          now,
        );
        this.logger.warn(
          `出款卡在 PROCESSING：${stuck.length} 张` +
            `（${stuck.map((p) => p.payoutNo).join('、')}）——` +
            '⚠️ 可能已打款，需人工核对，**不要自动重试**',
        );
      }

      // ---- ② APPROVED 卡死：重新入队 ----
      //
      // ⚠️⚠️ **必须加「从未被执行过」（`attemptCount = 0`）**：
      //    `scheduleRetry` 退回 `APPROVED` 时**不刷新 `approvedAt`** ——
      //    一张两小时前审批的单，在重试退避期内（状态是 `APPROVED`、
      //    `approvedAt` 很旧）会被这里捞出来 → **额外入队一个救援 job**。
      //    救援 jobId（`payout-{id}-rescue-{n}`）与重试 jobId（`payout-{id}-{n}`）
      //    **不同命名空间**，BullMQ 不去重 → 两个 job 抢同一张单 →
      //    本该按 30s / 60s 退避打完的 3 次预算**几秒内被烧完**，
      //    渠道还没恢复就落了 `FAILED`。
      //
      // ⚠️ **`attemptCount = 0` 正好区分两种情况**：
      // - 「审批后入队失败」→ 从未被 worker 抢过 → `0` → **会被救援** ✅
      // - 「正在退避等待重试」→ 已被抢过 → `≥ 1` → **不会被救援** ✅
      // - 「入队成功但 job 被 BullMQ 丢了」→ 也没被抢过 → `0` → **会被救援** ✅
      //
      // ⚠️ **不要改成「刷新 `approvedAt`」** —— `approvedAt` 的语义是
      //    「审批时间」，刷新它会让平台端显示的审批时间变成假的。
      const stuckApproved = await this.prisma.payout.findMany({
        where: {
          status: PayoutStatus.APPROVED,
          approvedAt: { lt: threshold },
          attemptCount: 0,
        },
        select: { id: true, attemptCount: true },
      });
      if (stuckApproved.length > 0) {
        this.logger.warn(
          `出款卡在 APPROVED（审批后入队失败？）：${stuckApproved.length} 张 —— 重新入队`,
        );
      }
      return stuckApproved.map((p) => ({
        id: p.id,
        attemptCount: p.attemptCount,
      }));
    });
  }
}
