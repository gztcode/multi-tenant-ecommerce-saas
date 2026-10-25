import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CouponRedemptionStatus } from '@prisma/client';
import type { PrismaTransaction } from '../../common/prisma/prisma-transaction';
import {
  platformScope,
  tenantContext,
} from '../../common/tenant/tenant-context';

/**
 * 券的核销服务（阶段 5a Task 4 / Task 5）。
 *
 * ## 与阶段 3 的「库存预占/释放」完全同构
 *
 * | 阶段 | 库存 | 券 |
 * |------|------|-----|
 * | 下单 | `RESERVE` 流水 + 扣 `stock` | 核销 `RESERVED` + `reservedCount` 加 1 |
 * | 支付成功 | `DEDUCT` 流水（库存不变） | 核销 `USED` + `reservedCount` 减 1、`usedCount` 加 1 |
 * | 取消/超时 | `RELEASE` 流水 + 加回 `stock` | 核销 `RELEASED` + `reservedCount` 减 1 |
 *
 * 同样的「条件更新 + 受影响行数判赢家 + 与订单状态同事务」三件套。
 */
@Injectable()
export class CouponRedemptionService {
  /**
   * 预占核销（在下单事务内调用）。
   *
   * ⚠️ **必须与建单在同一个事务里**：券的额度被占住与订单被创建必须同生共死。
   * 分成两个事务的话，订单失败而券被占住，用户的券就白占了。
   *
   * ⚠️ **并发闸门是那条部分唯一索引**
   * （`coupon_redemptions_coupon_active_uniq ON ("couponId")
   * WHERE "status" IN ('RESERVED','USED')`）：
   * 并发下单抢同一张券时，一个成功、一个撞唯一索引 → 转 409「该券已被使用」。
   *
   * ⚠️ **`reservedCount` 只是计数快照，不是闸门**（勘误表第 5 条）：
   * 本阶段的券是「一张券一个实例」——`coupon_claims` 记的是「这个用户领了这张券
   * 多少张」，而核销按 **couponId** 唯一（部分唯一索引保证一张券只能被一个订单
   * 预占）。所以 `reservedCount` 没有「上限」可判，它只用来核对
   * 「计数 = 核销记录数」（M14）。
   *
   * ⚠️ **P2002 必须在事务外处理**——但这里的冲突发生在**下单事务内**。
   * 处理方式是**在事务内 catch 后抛业务异常**（不是原始的 P2002）：
   * `ConflictException` 会让事务回滚，而它**不是** P2002，
   * 所以外层的 P2002 重试逻辑（重试订单号）不会误判它。
   */
  async reserveInTx(
    tx: PrismaTransaction,
    input: {
      tenantId: string;
      couponId: string;
      customerId: string;
      orderId: string;
      discountAmount: number;
      /** 券的作用域：SHOP = 本店券；PLATFORM = 平台券 */
      scope: 'SHOP' | 'PLATFORM';
    },
  ): Promise<void> {
    // 1. 计数快照加 1。
    //
    // ⚠️ 这里**不是**并发闸门（真正的闸门是下面那条部分唯一索引），
    // 所以不需要「预留一个上限」的 where 条件。
    // 受影响行数为 0 只说明「这张券不存在（或不在当前租户下）」。
    //
    // ⚠️ **平台券的计数在「平台租户」的那一行上**：
    // 租户作用域的 `updateMany` 看不到它，受影响行数会是 0。
    // 所以平台券要显式切到平台作用域去改——where 里**必须带
    // `scope: PLATFORM`**，平台作用域下扩展不附加 tenantId 条件，
    // 不加这个限定就等于「按 id 改全库任意租户的券」。
    if (input.scope === 'PLATFORM') {
      const platformAffected = await tenantContext.run(
        platformScope(),
        async () =>
          tx.coupon.updateMany({
            where: { id: input.couponId, scope: 'PLATFORM' },
            data: { reservedCount: { increment: 1 } },
          }),
      );
      if (platformAffected.count === 0) {
        throw new NotFoundException('优惠券不存在');
      }
    } else {
      const affected = await tx.coupon.updateMany({
        where: { id: input.couponId },
        data: { reservedCount: { increment: 1 } },
      });
      if (affected.count === 0) {
        throw new NotFoundException('优惠券不存在');
      }
    }

    // 2. 插核销记录（RESERVED）。
    //
    // ⚠️ **核销记录的 tenantId 是「下单的那家店」**，不是券的租户：
    // 平台券在多家店被核销时，每家店都要能在自己的租户里查到这笔核销。
    // 券的计数快照在券自己的那一行上（见上面第 1 步），两者是不同的事。
    //
    // ⚠️ **撞部分唯一索引就是「这张券已被别的订单预占了」**（M5）。
    // 抛 `ConflictException` 而不是原始 P2002：前者会让事务回滚，
    // 且外层的 P2002 重试逻辑不会误判它。
    try {
      await tx.couponRedemption.create({
        data: {
          tenantId: input.tenantId,
          couponId: input.couponId,
          customerId: input.customerId,
          orderId: input.orderId,
          status: CouponRedemptionStatus.RESERVED,
          discountAmount: input.discountAmount,
        },
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new ConflictException('该券已被使用');
      }
      throw error;
    }
  }

  /**
   * 释放核销（订单取消 / 超时关闭时调用）。
   *
   * ⚠️ **必须与改订单状态在同一个事务里**（M8 / M9，设计文档 §5.1）：
   * 否则订单已取消而券还占着，用户的券就再也用不了。
   *
   * ⚠️ **用条件更新**：`updateMany({ where: { id, status: 'RESERVED' },
   * data: { status: 'RELEASED' } })`——
   * 受影响行数为 0 说明这条核销不是 RESERVED（已 USED 或已 RELEASED），
   * 什么都不做。**重复释放是安全的**（不会把 reservedCount 减成 -1）。
   *
   * ⚠️ **计数与核销记录要同步**（M14）：条件更新命中之后，
   * 才去改券的 `reservedCount`。顺序反了的话，
   * 计数会与核销记录对不上。
   */
  async releaseInTx(tx: PrismaTransaction, orderId: string): Promise<void> {
    const redemptions = await this.findReservedInTx(tx, orderId);
    for (const redemption of redemptions) {
      const affected = await tx.couponRedemption.updateMany({
        where: { id: redemption.id, status: CouponRedemptionStatus.RESERVED },
        data: { status: CouponRedemptionStatus.RELEASED },
      });
      if (affected.count === 0) {
        // 已经被别人处理过了（重复释放）——什么都不做。
        continue;
      }
      await this.adjustCouponCountInTx(tx, redemption.couponId, {
        reservedCount: { decrement: 1 },
      });
    }
  }

  /**
   * 确认核销（支付成功时调用）。
   *
   * ⚠️ **必须与订单转 PAID 在同一个事务里**（设计文档 §5.3）：
   * 分成两个事务的话，订单已支付而券还停在 RESERVED——
   * 券的额度被占着，用户看到「我的券」里它还在却用不了。
   *
   * ⚠️ **与取消路径互斥**：支付成功后订单不再是 PENDING_PAYMENT，
   * 取消路径的条件更新会拦住它。两条路径都靠「核销状态的条件更新」
   * 保证只生效一次。
   */
  async markUsedInTx(tx: PrismaTransaction, orderId: string): Promise<void> {
    const redemptions = await this.findReservedInTx(tx, orderId);
    for (const redemption of redemptions) {
      const affected = await tx.couponRedemption.updateMany({
        where: { id: redemption.id, status: CouponRedemptionStatus.RESERVED },
        data: { status: CouponRedemptionStatus.USED },
      });
      if (affected.count === 0) {
        continue;
      }
      await this.adjustCouponCountInTx(tx, redemption.couponId, {
        reservedCount: { decrement: 1 },
        usedCount: { increment: 1 },
      });
    }
  }

  /**
   * 查这个订单下**还没释放**的核销记录。
   *
   * ⚠️ **核销记录的 tenantId 是「下单的那家店」**，所以这里的查询在
   * 租户作用域内做（扩展自动附加 tenantId 条件）。
   */
  private async findReservedInTx(
    tx: PrismaTransaction,
    orderId: string,
  ): Promise<Array<{ id: string; couponId: string }>> {
    return tx.couponRedemption.findMany({
      where: { orderId, status: CouponRedemptionStatus.RESERVED },
      select: { id: true, couponId: true },
    });
  }

  /**
   * 改券的计数快照，**按券的作用域分流**。
   *
   * ⚠️ **平台券的计数在「平台租户」的那一行上**：
   * 租户作用域的 `updateMany` 看不到它（受影响行数会是 0），
   * 所以平台券要显式切到平台作用域去改——where 里**必须带
   * `scope: PLATFORM`**，平台作用域下扩展不附加 tenantId 条件，
   * 不加这个限定就等于「按 id 改全库任意租户的券」。
   *
   * ⚠️ **释放路径与预占路径必须同样分流**：预占时按作用域分流了，
   * 释放时不分流的话，平台券的 `reservedCount` 永远减不回去——
   * 券被永久占住，用户再也用不了。
   */
  private async adjustCouponCountInTx(
    tx: PrismaTransaction,
    couponId: string,
    data: {
      reservedCount: { decrement: number };
      usedCount?: { increment: number };
    },
  ): Promise<void> {
    const scope = await this.readScope(tx, couponId);

    if (scope === 'PLATFORM') {
      await tenantContext.run(platformScope(), async () =>
        tx.coupon.updateMany({
          where: { id: couponId, scope: 'PLATFORM' },
          data,
        }),
      );
      return;
    }

    await tx.coupon.updateMany({ where: { id: couponId }, data });
  }

  /**
   * 读这张券的作用域。
   *
   * ⚠️ **用平台作用域读**：券可能属于平台租户（平台券），
   * 租户作用域的读根本看不到它。where 里**必须带 `scope: PLATFORM`**——
   * 不加的话就会把别家店的券也算成平台券。
   */
  private async readScope(
    tx: PrismaTransaction,
    couponId: string,
  ): Promise<'SHOP' | 'PLATFORM'> {
    const rows = await tenantContext.run(platformScope(), async () =>
      tx.coupon.findMany({
        where: { id: couponId, scope: 'PLATFORM' },
        select: { id: true },
      }),
    );
    return rows.length > 0 ? 'PLATFORM' : 'SHOP';
  }

  /**
   * 是不是 Prisma 的唯一约束冲突（P2002）。
   *
   * 用 `error.code === 'P2002'` 而不是 `instanceof PrismaClientKnownRequestError`：
   * `@prisma/client` 在 CJS/ESM 混载或多处 require 时会得到不同的模块实例，
   * instanceof 于是恒为 false（与 common/errors/unique-constraint.ts 同一理由）。
   */
  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'P2002'
    );
  }
}
