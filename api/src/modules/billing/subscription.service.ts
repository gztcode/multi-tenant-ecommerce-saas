import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SubscriptionStatus, type Subscription } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { rethrowIfUniqueViolation } from '../../common/errors/unique-constraint';
import { transactionOptions } from '../../common/db/transaction-options';
import type { PrismaTransaction } from '../../common/prisma/prisma-transaction';
import { PlanService } from './plan.service';
import { hasService } from './subscription-state';
import { requireTenantId } from '../../common/tenant/require-tenant';

/**
 * 订阅。
 *
 * ⚠️ **一个租户只有一条当前订阅**（`@@unique([tenantId])`）。
 * 历史不在这里 —— 历史在账单里（每期一张，带套餐快照）。
 * 订阅是「当前状态」，账单是「历史」。
 */
@Injectable()
export class SubscriptionService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly plans: PlanService,
  ) {}

  /**
   * 当前上下文里的店铺 id。
   *
   * ⚠️ **取不到就响亮地失败**（403），不兜底成空串 ——
   * 空串查库查不到，会「静默」返回 null，看起来像「没订阅」。
   */
  currentTenantId(): string {
    return requireTenantId();
  }

  /**
   * 当前订阅（没有就是 null）。
   *
   * ⚠️ **事务内必须传 `tx`**：交互事务会独占一条连接，
   *    回调内再用 `this.prisma` 会再借一条 → 小连接池上死等（P2024）。
   *    阶段 10 修的就是这个。
   */
  async current(
    tenantId: string,
    client: PrismaTransaction | TenantPrismaService = this.prisma,
  ): Promise<Subscription | null> {
    return client.subscription.findFirst({ where: { tenantId } });
  }

  /**
   * 这个租户现在**能不能接新单**。
   *
   * ⚠️ **「从未订阅」与「订阅已到期」是两件事**：
   * - **从未订阅**（没有订阅行）→ **放行**。商家还没选套餐，
   *   不等于不允许卖货 —— 护栏 M12 要求拦的是「到期后」。
   *   ⚠️ 把两者混为一谈会把阶段 1–5a 的既有行为整个禁掉
   *   （那些商家都没有订阅）。
   * - **有订阅但已到期 / 已取消** → **拒绝**。
   *
   * ⚠️ **判定不依赖定时任务**：即使扫任务的 worker 还没跑到，
   * 判定也是对的（同时看状态**与时间**）。
   * ⚠️ **时间用数据库的时钟**（护栏 M15）—— 多副本部署时各机器的时钟
   * 有偏差，边界时刻会摇摆。
   *
   * ⚠️ **事务内必须传 `tx`**：交互事务会独占一条连接，
   *    回调内再用 `this.prisma` 会再借一条 → 小连接池上死等（P2024）。
   *    阶段 10 修的就是这个。
   */
  async canAcceptOrders(
    tenantId: string,
    client: PrismaTransaction | TenantPrismaService = this.prisma,
  ): Promise<boolean> {
    const subscription = await this.current(tenantId, client);
    if (!subscription) {
      return true;
    }
    const now = await this.databaseNow(client);
    return hasService(subscription, now);
  }

  /**
   * 订阅一个套餐。
   *
   * ⚠️ **只接受 `planId`**（护栏 M1 / M2 / M9）：价格、周期、额度、
   * 费率一律从库里读。
   * ⚠️ **只能订在售的套餐**（护栏 M3）。
   * ⚠️ **重复开通要幂等，不是插两行**（护栏 M4）。
   */
  async subscribe(planId: string): Promise<Subscription> {
    const tenantId = this.currentTenantId();

    const plan = await this.plans.findActiveById(planId);
    if (!plan) {
      throw new NotFoundException('套餐不存在或已下架');
    }

    // ⚠️ **已有订阅就返回现有的**（护栏 M4）：重复点「开通」是常事，
    // 报错会让用户以为出错了。
    const existing = await this.prisma.subscription.findFirst({
      where: { tenantId },
    });
    if (existing) {
      return existing;
    }

    // ⚠️ **时间用数据库的时钟**（护栏 M15）
    const now = await this.prisma.databaseNow();
    const dayMs = 24 * 3600 * 1000;
    const trialEndsAt =
      plan.trialDays > 0
        ? new Date(now.getTime() + plan.trialDays * dayMs)
        : null;

    try {
      return await this.prisma.subscription.create({
        data: {
          tenantId,
          planId: plan.id,
          status: trialEndsAt
            ? SubscriptionStatus.TRIAL
            : SubscriptionStatus.ACTIVE,
          startedAt: now,
          trialEndsAt,
          currentPeriodStart: now,
          currentPeriodEnd:
            trialEndsAt ?? new Date(now.getTime() + plan.periodDays * dayMs),
        },
      });
    } catch (error) {
      // ⚠️ **P2002 在事务外处理**
      rethrowIfUniqueViolation(error, '订阅');
      throw new ConflictException('订阅失败，请重试');
    }
  }

  /**
   * 换套餐：**立即生效**，并重开一个完整的新周期（剩余天数作废）。
   *
   * ⚠️ **业主口径（2026-11-27）**：「升级即刻重开一个完整新周期，剩余天数作废。」
   *    升级与降级同一规则：`planId` 立刻切到新套餐，
   *    `currentPeriodStart` 重置为「现在」，
   *    `currentPeriodEnd = 现在 + 新套餐.periodDays`。
   * ⚠️ **不折算、不退款、不补差价**：剩余天数直接作废，也不生成任何调整账单；
   *    已开出、尚未支付的当前周期账单保持原样可支付。
   * ⚠️ **不改 `status`**：已过期（EXPIRED）的订阅不会因为换套餐而「复活」，
   *    与换套餐之前的行为一致。
   */
  async changePlan(planId: string): Promise<Subscription> {
    const tenantId = this.currentTenantId();
    const plan = await this.plans.findActiveById(planId);
    if (!plan) {
      throw new NotFoundException('套餐不存在或已下架');
    }
    // ⚠️ **非法周期必须拦在这里**：`periodDays <= 0` 会算出
    //    `periodEnd <= periodStart` 的「新周期」（商家付了钱、周期原地不动）。
    //    接口层有 `@Min(1)`，但库是共享的（直连改库 / 历史脏数据 / 种子脚本），
    //    这条会「推进周期」的路径必须自己兜底 —— 与续费扫描同一口径。
    if (plan.periodDays <= 0) {
      throw new BadRequestException('套餐周期不合法，无法切换');
    }
    const existing = await this.prisma.subscription.findFirst({
      where: { tenantId },
    });
    if (!existing) {
      throw new NotFoundException('还没有订阅');
    }

    const dayMs = 24 * 3600 * 1000;
    // ⚠️ **时间用数据库的时钟**（护栏 M15）；事务内必须显式传 `tx` 给
    //    `databaseNow()`，否则会再借一条连接（阶段 10 的 P2024）。
    await this.prisma.$transaction(async (tx) => {
      const now = await this.databaseNow(tx);
      // ⚠️ **用 `updateMany` 而不是 `update`**：租户作用域模型上
      // `update` 的 where 只接受唯一字段，扩展会直接拒绝。
      await tx.subscription.updateMany({
        where: { tenantId },
        data: {
          planId: plan.id,
          pendingPlanId: null,
          currentPeriodStart: now,
          currentPeriodEnd: new Date(now.getTime() + plan.periodDays * dayMs),
        },
      });
    }, transactionOptions());

    const updated = await this.prisma.subscription.findFirst({
      where: { tenantId },
    });
    if (!updated) {
      throw new NotFoundException('还没有订阅');
    }
    return updated;
  }

  /** 到期后不自动续费 */
  async cancelAtPeriodEnd(tenantId: string): Promise<void> {
    await this.prisma.subscription.updateMany({
      where: { tenantId },
      data: { cancelAtPeriodEnd: true },
    });
  }

  /**
   * 数据库时钟（双形态）。
   *
   * ⚠️ **事务内必须传 `tx`**：`this.prisma.databaseNow()` 会借普通连接，
   *    事务已经占住一条，再借一条会在小连接池上死等（P2024）。
   */
  private async databaseNow(
    client: PrismaTransaction | TenantPrismaService,
  ): Promise<Date> {
    if (client instanceof TenantPrismaService) {
      return client.databaseNow();
    }
    const rows = await client.$queryRaw<Array<{ now: Date }>>`
      SELECT now() as now
    `;
    return rows[0].now;
  }
}
