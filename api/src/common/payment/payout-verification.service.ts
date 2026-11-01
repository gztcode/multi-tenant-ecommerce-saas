import { Inject, Injectable, Logger } from '@nestjs/common';
import { ReconciliationDiffType } from '@prisma/client';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { platformScope, tenantContext } from '../tenant/tenant-context';
import { PAYOUT_PROVIDERS } from './payout.constants';
import type { PayoutProvider } from './payout-provider.interface';
import {
  PayoutVerification,
  PayoutVerificationTarget,
  PayoutVerificationVerdict,
} from './payout-verification';

/**
 * 第 2 层（查对账结果）**认可的差异类型白名单**。
 *
 * ## 为什么要有白名单
 *
 * ⚠️ **本层唯一的放行依据是「渠道说 FAILED」** —— 它直接决定「能不能解卡重打」。
 *    而对账项的 `channelStatus` 是从渠道记录抄来的**开放字符串**，
 *    `type` 才是「这条差异是怎么来的」的权威说明。
 *    不看 `type` 就信 `channelStatus`，等于把「这条差异说的是不是这回事」这个判断
 *    完全押在引擎的口径上 —— 而引擎口径一改，这里会**静默放行**（= 重复打款风险）。
 *
 *    当前引擎（`modules/payment/payout-reconcile.engine.ts`）的口径是：
 *    F 类（`STATUS_MISMATCH`）**只在「渠道 FAILED 且本地是 PAID」时产出**，
 *    而核实闸的对象是 `PROCESSING` 的单 → `PROCESSING` 的单不可能带出 F 类项。
 *    **这条跨 Task 的隐式耦合一旦被打破（引擎改口径让 `PROCESSING` 也产 F 类），
 *    核实层就会静默放行。** 白名单就是把这条隐式耦合**变成显式**。
 *
 * ## 白名单里放哪几个、为什么排除其余的
 *
 * 引擎实际会产出的六种差异类型（`ReconciliationDiffType`）：
 *
 * | type | 引擎口径 | `channelStatus` | 纳入？ | 理由 |
 * | --- | --- | --- | --- | --- |
 * | `CHANNEL_PENDING_LOCAL`（A） | 渠道 SUCCESS、本地 PROCESSING | `SUCCESS` | ✅ | 「渠道说钱打了」是**明确的成功结论**，与核实闸需要的语义一致 |
 * | `CHANNEL_SUCCESS_LOCAL_FAILED`（B） | 渠道 SUCCESS、本地 FAILED | `SUCCESS` | ✅ | 同上。⚠️ 这类正是「解卡闸」要靠它拦住的场景（渠道说打了，本地却记失败） |
 * | `AMOUNT_MISMATCH`（C） | 渠道 SUCCESS、本地 PAID、金额不符 | `SUCCESS` | ✅ | 渠道结论仍是「钱打了」（只是金额对不上）→ 本层只认「渠道说没打没打」，不判金额 |
 * | `CHANNEL_ONLY`（D） | 渠道有、本地没有这张单 | 渠道原值 | ❌ | **本表 D 类的 `payoutId` 为 `null`** → 根本不会被 `payoutId` 查询命中 |
 * | `LOCAL_PAID_CHANNEL_ABSENT`（E） | 本地 PAID、渠道查不到 | `null` | ❌ | **`channelStatus` 恒为 `null`** → 本层问不出渠道结论 → 必须 fail-closed。⚠️ 特别危险：「渠道查不到」≠「渠道说没打」 |
 * | `STATUS_MISMATCH`（F） | 渠道 FAILED、本地 PAID | `FAILED` | ❌ | **渠道说 FAILED 却是「本地已付」的差异** —— 它说明「渠道与本地记录互相矛盾」，**不能**据此断定「这笔钱没打出去」。若采信，一条被本地误记为已付的单会被当成「渠道明确拒付」→ **放行解卡 → 重复打款**。这类要人工处置（Task 6），不由核实层自动放行 |
 *
 * ⚠️ **排除 ≠ 放行** —— 不在白名单里的项**一律当作「问不出结论」**，
 *    最终落到第 3 层 fail-closed → `UNKNOWN` → 拒绝解卡（保守方向）。
 *
 * ⚠️ **白名单不能太窄** —— 窄了会让**本该放行**的单变成 `UNKNOWN`（误拒）→ 运营被卡住。
 *    上面三个纳入的类型恰好覆盖了引擎产出的**全部「渠道明确说 SUCCESS」**的情况，
 *    即「渠道明确说没打（FAILED）」这一路**在引擎里根本没有对应项**
 *    （引擎只在本地已 PAID 时才产 F 类差异）→ 渠道说 FAILED 且本地 PROCESSING
 *    这张单**不会有任何对账项** → 本层对它返回 `null` → 落到第 3 层 `UNKNOWN`。
 *    **这是保守且正确的**：本地 PROCESSING + 渠道 FAILED 属于「正常的失败重试流程」，
 *    不是「需要解卡重打」的场景；真正的解卡对象由第 1 层（实时渠道核实）覆盖。
 */
const RECONCILIATION_TRUSTED_TYPES: ReconciliationDiffType[] = [
  ReconciliationDiffType.CHANNEL_PENDING_LOCAL,
  ReconciliationDiffType.CHANNEL_SUCCESS_LOCAL_FAILED,
  ReconciliationDiffType.AMOUNT_MISMATCH,
];

/**
 * 出款核实服务（阶段 5m）。
 *
 * ## 三层核实（设计 §六·6.3）
 *
 * ```
 * 第 1 层：实时渠道核实
 *   → provider.queryPayout({ referenceNo: payout.payoutNo })
 *   → 渠道说 SUCCESS → 拒绝解卡（并纠正为 PAID）
 *   → 渠道说 FAILED  → 允许解卡（渠道明确说没打）
 *   → 核实不可用 → 第 2 层
 *
 * 第 2 层：查该单最近一次对账结果
 *   → 渠道结论 SUCCESS → 同上
 *   → 渠道结论 FAILED  → 允许解卡
 *   → 没有对账记录 → 第 3 层
 *
 * 第 3 层：fail-closed
 *   → UNKNOWN，调用方拒绝解卡
 * ```
 *
 * ⚠️ **这套逻辑有且只有一处实现** —— 解卡闸与 B 类人工处置的闸 ④ 都调它，
 *    不各写一遍。
 *
 * ⚠️ **「渠道查不到这条」不等于「渠道说没打」** —— 只有渠道**明确说 FAILED**
 *    才放行。其余一律 fail-closed。
 */
@Injectable()
export class PayoutVerificationService implements PayoutVerification {
  private readonly logger = new Logger(PayoutVerificationService.name);

  constructor(
    @Inject(PAYOUT_PROVIDERS)
    private readonly providers: Map<string, PayoutProvider>,
    private readonly prisma: TenantPrismaService,
  ) {}

  async verify(
    target: PayoutVerificationTarget,
  ): Promise<PayoutVerificationVerdict> {
    const realtime = await this.verifyRealtime(target);
    if (realtime) {
      return realtime;
    }
    const fromReconciliation = await this.verifyFromReconciliation(target);
    if (fromReconciliation) {
      return fromReconciliation;
    }
    return { verdict: 'UNKNOWN', source: 'NONE' };
  }

  /** 第 1 层：实时渠道核实 */
  private async verifyRealtime(
    target: PayoutVerificationTarget,
  ): Promise<PayoutVerificationVerdict | null> {
    const provider = this.pickProvider();
    if (!provider) {
      return null;
    }
    try {
      // ⚠️ **用 referenceNo（payoutNo），不是 providerTxnId** ——
      //    `PROCESSING` 的单**没有** `payoutTxnId`（Task 3 起只有落 `FAILED`
      //    时才写它，落 `PAID` 时由 `markPaid` 写），所以 `referenceNo`
      //    是**唯一对所有状态都成立**的查询键。
      const result = await provider.queryPayout({
        referenceNo: target.payoutNo,
      });
      if (result.status === 'SUCCESS') {
        return {
          verdict: 'PAID',
          source: 'REALTIME',
          amount: result.amount,
          paidAt: result.paidAt,
        };
      }
      if (result.status === 'FAILED') {
        return { verdict: 'FAILED', source: 'REALTIME' };
      }
      // ⚠️ **渠道非终态 → 问不出结论** → 交给下一层
      this.logger.warn(
        `出款 ${target.id} 的渠道核实返回非终态（${result.status}），降级查对账结果`,
      );
      return null;
    } catch (error) {
      // ⚠️ **渠道不可用（抛错）→ 不是「渠道说没打」** → 交给下一层
      this.logger.warn(
        `出款 ${target.id} 的渠道核实失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /** 第 2 层：查该单最近一次对账结果 */
  private async verifyFromReconciliation(
    target: PayoutVerificationTarget,
  ): Promise<PayoutVerificationVerdict | null> {
    // ⚠️ **`payout_reconciliation_items` 不受租户作用域约束**（无 tenantId）
    //    → 裸 delegate，返回的是全平台事实。
    //
    // ⚠️ **这里只按 `payoutId` 查、不带 `reconciliationId`，是「单点取值」才成立的特例** ——
    //    本表**任何列表/详情查询都必须同时按 `reconciliationId` 限定**，
    //    且 `reconciliationId` 只能来自平台超管的权限检查之后
    //    （见 `common/tenant/tenant-models.ts` 的 `PayoutReconciliationItem` 段、
    //    `common/tenant/tenant-prisma.service.ts` 的同名 getter、
    //    `prisma/schema.prisma` 的 model 注释）。
    //    为什么这里安全：
    //      ① `payoutId` 是 uuid（全局唯一），**不是用户输入的裸串** ——
    //         它由调用方自己查库得到（`target.id` 来自它自己查出的 `payout.id`）；
    //      ② 这是**按已知 id 取一行**，不是列表 —— 命中至多一行，没有「列出别人的单」的可能。
    //    ⚠️ **照抄这段去写列表接口就会漏掉 `reconciliationId` → 全平台数据泄露。**
    const items = await tenantContext.run(platformScope(), async () =>
      this.prisma.payoutReconciliationItem.findMany({
        where: {
          payoutId: target.id,
          // ⚠️ **按 `type` 白名单过滤**（见下方 `RECONCILATION_TRUSTED_TYPES` 注释）
          type: { in: RECONCILIATION_TRUSTED_TYPES },
        },
        // ⚠️ **二级排序键** —— 只按 `createdAt` 排的话，同一毫秒内写入的两行
        //    顺序不确定 → 「最近一次」会随机命中其中一行 → 结论不稳定。
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 1,
      }),
    );
    if (items.length === 0) {
      return null;
    }
    const item = items[0];
    // ⚠️ **再查一遍 `type`（纵深防御）** —— 上面的 `where` 已经按白名单过滤了，
    //    这里再判一次是为了**不把安全性全押在数据库过滤上**：
    //    万一白名单被改窄/被绕过、或查询条件被人加花，
    //    这一行仍然拦得住「拿一条 F 类差异当成「渠道说没打」」→ 放行解卡 → 重复打款。
    if (!RECONCILIATION_TRUSTED_TYPES.includes(item.type)) {
      this.logger.warn(
        `出款 ${target.id} 的对账项类型不在白名单内（${item.type}），不据此下结论`,
      );
      return null;
    }
    if (item.channelStatus === 'SUCCESS') {
      return {
        verdict: 'PAID',
        source: 'RECONCILIATION',
        providerTxnId: item.channelTxnId ?? undefined,
        amount: item.channelAmount ?? undefined,
        paidAt: item.channelPaidAt ?? undefined,
      };
    }
    if (item.channelStatus === 'FAILED') {
      return { verdict: 'FAILED', source: 'RECONCILIATION' };
    }
    return null;
  }

  /**
   * 取渠道实现。
   *
   * ⚠️ **本阶段只有一个渠道（本地假网关）→ 取第一个**。
   * ⚠️ **将来接第二家时这里要改成按 `payouts.payoutChannel` 取** ——
   *    取「第一个」的话，加了第二家之后会查错渠道。
   *    ⚠️ 注意 `PROCESSING` 的单**还没有 `payoutChannel`**（那是 markPaid 写的）
   *    → 将来需要用 `payoutNo` 前缀或别的约定来定位渠道。
   *
   * ⚠️⚠️ **解卡核实闸与打款 worker 必须查同一个渠道 —— 两处要一起改**
   *    （打款 worker 见 `modules/payment/payout.worker.ts` 的 `firstProvider`）。
   *    两者若一个改了另一个没改，就会出现
   *    **「钱打到 A 渠道、核实查 B 渠道」** ——
   *    核实从 B 渠道问出「没打」，实际钱已经从 A 渠道打出去了 → **重复打款**。
   *    → 改渠道选择逻辑时，**核实服务与 worker 必须一起改、一起验**。
   */
  private pickProvider(): PayoutProvider | undefined {
    for (const provider of this.providers.values()) {
      return provider;
    }
    return undefined;
  }
}
