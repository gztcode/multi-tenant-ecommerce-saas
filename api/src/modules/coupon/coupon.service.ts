import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Coupon,
  CouponRedemptionStatus,
  CouponScope,
  CouponStatus,
  CouponType,
  Promotion,
  PromotionStatus,
  UserRole,
} from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import {
  getTenantContext,
  platformScope,
  tenantContext,
} from '../../common/tenant/tenant-context';
import { rethrowIfUniqueViolation } from '../../common/errors/unique-constraint';
import type { PrismaTransaction } from '../../common/prisma/prisma-transaction';
import {
  computeDiscount,
  isWithinWindow,
  type CouponCandidate,
  type DiscountContext,
  type OrderDiscount,
} from './discount-engine';
import { CreateCouponDto } from './dto/create-coupon.dto';
import { UpdateCouponDto } from './dto/update-coupon.dto';
import { ClaimCouponDto } from './dto/claim-coupon.dto';

/**
 * 领取时撞 `coupon_claims_coupon_customer_uniq` 的重试次数。
 *
 * ⚠️ **重试必须在事务外**：唯一约束冲突让 PostgreSQL 事务进入 aborted 状态，
 * 在同一个事务里继续查会报 `current transaction is aborted`。
 * 所以外层 catch P2002 → **在事务外**重开一个事务。
 * 这与 `order.service.ts` 的订单号重试完全同款。
 *
 * 三次就够：第一次撞的是「并发下另一个请求先插进去了」，
 * 第二次走的就是「查到已有行 → 累加」的分支；
 * 第三次是留给「多个请求同时首抢」的余量。
 */
const CLAIM_MAX_ATTEMPTS = 3;

/**
 * 「我持有的券」列表里的每一项。
 *
 * ⚠️ **在 Prisma 生成的 `Coupon` 上加了两个字段**：
 * 原始行是「券本身」的信息（面额、门槛、计数快照），
 * 而前端要显示的是**这个用户**与这张券的关系——
 * 「我有没有用掉过它」「我领了几张」。这两个信息不在 `coupons` 表里，
 * 只在 `coupon_claims` / `coupon_redemptions` 里。
 *
 * ⚠️ **不去改 Prisma 生成的类型**：`Coupon` 是 `@prisma/client` 生成的，
 * 改了会被 `prisma generate` 冲掉。所以在这里定义交叉类型。
 */
export type MyCoupon = Coupon & {
  /** 这个用户是否已经核销过这张券（RESERVED 或 USED 都算） */
  used: boolean;
  /** 这个用户领取这张券的张数 */
  claimedQuantity: number;
};

/**
 * 优惠预览的响应形状。
 *
 * ⚠️ **全部是整数分**：与全局约定一致，绝不出现浮点。
 */
export interface CouponPreview {
  /** 回显传入的原价（整数分） */
  originalAmount: number;
  /** 满减活动减免（整数分） */
  promotionDiscountAmount: number;
  /** 命中的活动名（没有生效的活动就是 null） */
  promotionName: string | null;
  /** 每张候选券在当前原价下能减多少 */
  coupons: Array<{
    id: string;
    code: string;
    name: string;
    type: CouponType;
    /** 面额（整数分） */
    value: number;
    /** 门槛（整数分） */
    minAmount: number;
    /** 这张券在当前原价下能减多少（整数分）；门槛不满足就是 0 */
    discountAmount: number;
    /** 用这张券之后的实付（整数分） */
    payableAmount: number;
  }>;
  /** 自动取最优时的券 id */
  bestCouponId: string | null;
  /** 自动取最优时减了多少（整数分） */
  bestCouponDiscountAmount: number;
  /** 自动取最优时的实付（整数分） */
  payableAmount: number;
}

/**
 * 优惠券服务（阶段 5a Task 3）。
 *
 * 负责券的 CRUD、领取、列表。
 *
 * ## 租户隔离
 *
 * 读写都走 `TenantPrismaService`，扩展自动附加 tenantId 条件——
 * **不要**在这里手写重复的 where（全局约定）。
 * 跨租户的平台券只在 `createPlatformCoupon` 一处显式写 tenantId，
 * 因为平台作用域的写入要求显式指定租户。
 */
@Injectable()
export class CouponService {
  constructor(private readonly prisma: TenantPrismaService) {}

  /**
   * 当前租户 ID。
   *
   * 租户**从上下文读**，不当参数传——与 `OrderService.currentTenantId()`
   * 的既有写法一致。
   */
  private currentTenantId(): string {
    const context = getTenantContext();
    if (!context.tenantId) {
      throw new ForbiddenException('无法确定店铺');
    }
    return context.tenantId;
  }

  // ============================================================
  // 创建 / 修改 / 删除（商家侧）
  // ============================================================

  /**
   * 创建优惠券（商家侧）。
   *
   * ⚠️ **M7：`scope` 由服务端决定，不由客户端传入**。
   *
   * - 商家账号（MERCHANT_OWNER / MERCHANT_STAFF）→ 一律 `SHOP`
   * - 平台超管（PLATFORM_ADMIN）→ `PLATFORM`（走 `createPlatformCoupon`）
   *
   * 客户端传 `scope` 会被 `forbidNonWhitelisted` 直接 400（DTO 里没这个字段）。
   * 但**服务端也不能盲信 DTO**——DTO 只是第一道闸，
   * 这里显式从**登录身份**推导才是真正的兑现点。
   */
  async createCoupon(dto: CreateCouponDto): Promise<Coupon> {
    const context = getTenantContext();
    const tenantId = this.currentTenantId();

    // ⚠️ 商家账号创建的一律 SHOP。平台超管不该走到这里——
    // 平台超管走的是 createPlatformCoupon（scope = PLATFORM）。
    if (context.role === UserRole.PLATFORM_ADMIN) {
      throw new ForbiddenException('平台超管请使用平台券接口创建平台券');
    }

    const { startsAt, endsAt } = this.parseWindow(dto.startsAt, dto.endsAt);

    try {
      return await this.prisma.coupon.create({
        data: {
          tenantId,
          code: dto.code,
          name: dto.name,
          description: dto.description ?? null,
          // ⚠️ **type 固定 FIXED**：本阶段只实现满减券。
          type: CouponType.FIXED,
          value: dto.value,
          minAmount: dto.minAmount,
          perUserLimit: dto.perUserLimit ?? null,
          totalLimit: dto.totalLimit ?? null,
          scope: CouponScope.SHOP,
          status: CouponStatus.ACTIVE,
          startsAt,
          endsAt,
        },
      });
    } catch (error) {
      // ⚠️ **P2002 在事务外处理**：这里没有开事务，但 catch 里也不要做查询。
      // rethrowIfUniqueViolation 只把 P2002 转成 409，其它错误原样抛出。
      rethrowIfUniqueViolation(error, '券码');
    }
  }

  /**
   * 创建平台券（平台超管）。
   *
   * ⚠️ **M7 的兑现点之二**：这里的 `scope` 是硬编码的 `PLATFORM`，
   * 与登录身份绑定——只有能走到这个方法的角色（平台超管）才拿得到平台券。
   *
   * ⚠️ **平台作用域的写入必须显式带 tenantId**
   * （`tenant-prisma.service.ts` 的 create 扩展会拒绝少带的写入），
   * 所以这里直接 `create`，让扩展的「平台作用域」分支放行。
   */
  async createPlatformCoupon(
    dto: CreateCouponDto & { tenantId: string },
  ): Promise<Coupon> {
    const { startsAt, endsAt } = this.parseWindow(dto.startsAt, dto.endsAt);

    try {
      return await this.prisma.coupon.create({
        data: {
          tenantId: dto.tenantId,
          code: dto.code,
          name: dto.name,
          description: dto.description ?? null,
          type: CouponType.FIXED,
          value: dto.value,
          minAmount: dto.minAmount,
          perUserLimit: dto.perUserLimit ?? null,
          totalLimit: dto.totalLimit ?? null,
          scope: CouponScope.PLATFORM,
          status: CouponStatus.ACTIVE,
          startsAt,
          endsAt,
        },
      });
    } catch (error) {
      rethrowIfUniqueViolation(error, '券码');
    }
  }

  /**
   * 修改优惠券（商家侧）。
   *
   * ⚠️ **更新用 `updateMany` 而不是 `update`**：租户作用域模型上
   * `update` 的 where 只接受唯一字段，扩展会直接拒绝。
   *
   * ⚠️ **`scope` 与计数不在更新范围内**：作用域是创建时定下的身份属性（M7），
   * 计数是服务端的账。
   */
  async updateCoupon(id: string, dto: UpdateCouponDto): Promise<Coupon> {
    const tenantId = this.currentTenantId();

    const data: Record<string, unknown> = {};
    if (dto.code !== undefined) data.code = dto.code;
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.value !== undefined) data.value = dto.value;
    if (dto.minAmount !== undefined) data.minAmount = dto.minAmount;
    if (dto.perUserLimit !== undefined) data.perUserLimit = dto.perUserLimit;
    if (dto.totalLimit !== undefined) data.totalLimit = dto.totalLimit;
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.startsAt !== undefined && dto.endsAt !== undefined) {
      const { startsAt, endsAt } = this.parseWindow(dto.startsAt, dto.endsAt);
      data.startsAt = startsAt;
      data.endsAt = endsAt;
    }

    const affected = await this.prisma.coupon.updateMany({
      where: { id, tenantId },
      data,
    });
    if (affected.count === 0) {
      throw new NotFoundException('优惠券不存在');
    }

    return this.requireCoupon(id, tenantId);
  }

  /**
   * 删除优惠券（软删）。
   *
   * ⚠️ **软删而非物理删**：券是营销配置，商家可能想「下架」但保留
   * 历史核销记录的可追溯性。`coupons` 登记在 `SOFT_DELETE_MODELS` 里，
   * 扩展会自动在查询里带上 `deletedAt: null`，
   * 并且**禁止** `updateMany` 把 deletedAt 置回 null（不许复活）。
   */
  async deleteCoupon(id: string): Promise<void> {
    const tenantId = this.currentTenantId();
    const affected = await this.prisma.coupon.updateMany({
      where: { id, tenantId },
      data: { deletedAt: new Date() },
    });
    if (affected.count === 0) {
      throw new NotFoundException('优惠券不存在');
    }
  }

  /** 券列表（商家侧） */
  async listCoupons(): Promise<{ items: Coupon[]; total: number }> {
    const tenantId = this.currentTenantId();
    const items = await this.prisma.coupon.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
    return { items, total: items.length };
  }

  // ============================================================
  // 领取（消费者侧）
  // ============================================================

  /**
   * 领取优惠券。
   *
   * ## M4：限额不被并发超发
   *
   * ⚠️ **必须用条件更新，不能「先查后改」**。
   *
   * 「先查 claimedCount 再写」的话，两个并发请求会都读到同一个旧值
   * （比如 0），都判定「还有额度」，然后都写 1 —— **结果是 1，但发出去了 2 张**
   * （`coupon_claims` 里两行，用户的券多了一张，商家亏一张）。
   *
   * 正确做法（与阶段 3 的状态流转同款）：
   * ```
   * updateMany({ where: { id, claimedCount: { lt: totalLimit } },
   *              data: { claimedCount: { increment: quantity } } })
   * ```
   * 受影响行数为 0 就是「额度已满」→ 409。
   * 数据库保证只有一个并发请求能拿到额度。
   *
   * ⚠️ **两件事必须在同一个事务里**：
   * 1. `coupons.claimedCount` 的条件更新
   * 2. `coupon_claims` 那一行的数量累计
   * 分成两个事务的话，计数加了而领取记录没加 → 用户的券凭空消失。
   *
   * ⚠️ **每用户限领也用条件更新**：先 `updateMany` 扣 `coupon_claims`
   * 那一行的 quantity（where 带 `quantity <= perUserLimit - 本次领取量`），
   * 受影响行数为 0 就是超限。
   */
  async claim(
    dto: ClaimCouponDto,
    customerId: string,
  ): Promise<{ couponId: string; quantity: number }> {
    const tenantId = this.currentTenantId();
    const quantity = dto.quantity ?? 1;

    if (!dto.couponId && !dto.code) {
      throw new BadRequestException('必须提供 couponId 或 code');
    }

    // ⚠️ **整个领取流程包在循环里**：并发下两个请求都 `findFirst` 查不到
    // 领取记录 → 都去 create → 一个撞 `coupon_claims_coupon_customer_uniq`
    // 的 P2002。P2002 让 PostgreSQL 事务进入 aborted 状态，
    // 在同一个事务里重试必然失败，所以必须**在事务外**重开一个事务。
    for (let attempt = 0; attempt < CLAIM_MAX_ATTEMPTS; attempt++) {
      try {
        return await this.prisma.$transaction(
          async (tx) => this.claimInTx(tx, tenantId, dto, customerId, quantity),
          { maxWait: 10_000, timeout: 10_000 },
        );
      } catch (error) {
        // ⚠️ P2002 必须在**事务外**处理：唯一约束冲突让事务 aborted，
        // 在同一个事务里 catch 之后继续查会报 `current transaction is aborted`。
        if (this.isUniqueViolation(error)) {
          continue;
        }
        throw error;
      }
    }
    throw new ConflictException('领取失败，请重试');
  }

  /** 领取的事务体 */
  private async claimInTx(
    tx: PrismaTransaction,
    tenantId: string,
    dto: ClaimCouponDto,
    customerId: string,
    quantity: number,
  ): Promise<{ couponId: string; quantity: number }> {
    // 1. 找券
    //
    // ⚠️ **两条路径**（Task 5 补上的功能缺口）：
    // - 店铺券：租户作用域内查 —— 扩展自动附加 tenantId 条件，
    //   软删过滤也自动生效。别家店的券根本查不到。
    // - 平台券：租户作用域内**查不到**（它的 tenantId 指向平台租户），
    //   必须显式走一次 `platformScope()`，**where 里必须带
    //   `scope: PLATFORM`**——不加的话就是「拿别家店的券来领」。
    const coupon = await this.findClaimableCoupon(tx, dto);
    if (!coupon) {
      throw new NotFoundException('优惠券不存在');
    }
    const isPlatform = coupon.scope === CouponScope.PLATFORM;

    // 2. 状态与有效期判定
    //
    // ⚠️ **有效期判定用数据库的 now()**（M15），不用应用进程的时钟。
    const dbNow = await this.databaseNow(tx);
    if (coupon.status !== CouponStatus.ACTIVE) {
      throw new ConflictException('该优惠券当前不可领取');
    }
    if (!isWithinWindow(coupon.startsAt, coupon.endsAt, dbNow)) {
      throw new ConflictException('该优惠券不在领取时间内');
    }

    // 3. **条件更新**扣总量（M4）
    //
    // ⚠️ `claimedCount: { lt: totalLimit }` 这个 where 条件只在
    // totalLimit 非空时才有意义 —— totalLimit 为 null（不限量）时，
    // where 条件要省略（`{ lt: null }` 在 Prisma 里恒为 false，
    // 会把不限量的券也拦住）。
    //
    // ⚠️ **平台券的计数在「平台租户」的那一行上**：
    // 租户作用域的 `updateMany` 改不到它（受影响行数会是 0），
    // 所以平台券要显式切到平台作用域去改。
    const affected = await this.incrementClaimedCountInTx(
      tx,
      coupon.id,
      isPlatform,
      quantity,
      coupon.totalLimit,
    );
    if (affected.count === 0) {
      throw new ConflictException('该优惠券已被领完');
    }

    // 4. **条件更新**扣每用户限量
    //
    // ⚠️ `coupon_claims` 上有唯一索引 (couponId, customerId)，
    // 所以一个用户对一张券只有一行。
    //
    // ⚠️ 条件写成 `quantity <= perUserLimit - 本次领取量`：
    // Prisma 的 `lte` 是与**当前行值**比较，不是「比较后再加」，
    // 所以要把「本次领取量」先从限额里减掉。
    //
    // ⚠️ **没有这一行时不能直接 update**——那会更新 0 行、
    // 却被当成「超限」。所以先 findFirst 判有没有这一行：
    // 有 → 条件更新（并发下抢不到就是超限）；
    // 没有 → 走第 5 步的 create（撞唯一索引 → P2002 → 事务外重试）。
    const limit = coupon.perUserLimit;
    const existing = await tx.couponClaim.findFirst({
      where: { couponId: coupon.id, customerId },
      select: { id: true },
    });

    // ⚠️ **首次领取也要卡限额**：本次领取量本身就可能超过 perUserLimit
    // （限额 2、一次领 3 张）。这一条拦不住的话，
    // 「每用户限领」在首次领取上就是个空壳。
    if (limit !== null && quantity > limit) {
      throw new ConflictException('你已达到该优惠券的限领张数');
    }

    if (existing) {
      if (limit !== null) {
        const updated = await tx.couponClaim.updateMany({
          where: {
            id: existing.id,
            // 本次领取后的总量不能超过限额
            quantity: { lte: limit - quantity },
          },
          data: { quantity: { increment: quantity } },
        });
        if (updated.count === 0) {
          // ⚠️ 这里**不能静默放过**：前面第 3 步的 claimedCount 已经加了，
          // 抛异常会让整个事务回滚——那正是我们要的（回滚掉第 3 步的计数）。
          throw new ConflictException('你已达到该优惠券的限领张数');
        }
        return { couponId: coupon.id, quantity };
      }
      // 不限每用户额度：直接累加
      await tx.couponClaim.updateMany({
        where: { id: existing.id },
        data: { quantity: { increment: quantity } },
      });
      return { couponId: coupon.id, quantity };
    }

    // 5. 写领取记录
    //
    // ⚠️ **不能用 upsert**：租户作用域模型上 upsert 被扩展直接拒绝
    // （`assertNotUniqueOnly`：upsert 的 where 只接受唯一字段，
    // 附加不了 tenantId 条件）。所以是「先 findFirst 查，
    // 再分情况 create 或 updateMany」。
    //
    // ⚠️ **create 时 tenantId 要显式写出**：租户扩展在运行时会注入它，
    // 但 TypeScript 只认 Prisma 生成的类型，不看运行时行为，
    // 漏掉会在 `tsc --noEmit` 处报错。
    //
    // ⚠️ 走到这里说明这个用户**还没领过这张券**，所以「每用户限领」
    // 一定满足（本次领取量 <= 限额，限额至少是 1）。
    await tx.couponClaim.create({
      data: { tenantId, couponId: coupon.id, customerId, quantity },
    });

    return { couponId: coupon.id, quantity };
  }

  /**
   * 找一张可领取的券（**店铺券与平台券两条路径**）。
   *
   * ⚠️ **平台券在租户作用域内查不到**：它的 `tenantId` 指向平台租户。
   * 所以先在租户作用域内找（扩展自动附加 tenantId 条件 + 软删过滤），
   * 找不到再走一次 `platformScope()`。
   *
   * ⚠️ **平台作用域的查询必须带 `scope: PLATFORM`**：
   * 平台作用域下扩展**不**附加 tenantId 条件，
   * 不加这个限定就会把别家店的券一起捞出来——那就是「跨租户领券」（M3）。
   */
  private async findClaimableCoupon(
    tx: PrismaTransaction,
    dto: ClaimCouponDto,
  ): Promise<Coupon | null> {
    const where = dto.couponId ? { id: dto.couponId } : { code: dto.code! };

    const shopCoupon = await tx.coupon.findFirst({ where });
    if (shopCoupon) {
      return shopCoupon;
    }

    const platformCoupons = await tenantContext.run(platformScope(), async () =>
      tx.coupon.findMany({ where: { ...where, scope: CouponScope.PLATFORM } }),
    );
    return platformCoupons[0] ?? null;
  }

  /**
   * **条件更新**扣券的发放总量（M4），**按作用域分流**。
   *
   * ⚠️ **平台券的计数在「平台租户」的那一行上**：
   * 租户作用域的 `updateMany` 看不到它（受影响行数会是 0），
   * 于是「不限量的平台券」会被误判成「已被领完」。
   * 所以平台券要显式切到平台作用域去改——where 里**必须带
   * `scope: PLATFORM`**，平台作用域下扩展不附加 tenantId 条件，
   * 不加这个限定就等于「按 id 改全库任意租户的券」。
   *
   * ⚠️ **发放总量与核销计数在同一个作用域里**：领取走哪个作用域，
   * 核销（预占/释放）也要走同一个——否则计数会分叉。
   */
  private async incrementClaimedCountInTx(
    tx: PrismaTransaction,
    couponId: string,
    isPlatform: boolean,
    quantity: number,
    totalLimit: number | null,
  ): Promise<{ count: number }> {
    const where = {
      id: couponId,
      ...(totalLimit !== null ? { claimedCount: { lt: totalLimit } } : {}),
    };

    if (isPlatform) {
      return tenantContext.run(platformScope(), async () =>
        tx.coupon.updateMany({
          where: { ...where, scope: CouponScope.PLATFORM },
          data: { claimedCount: { increment: quantity } },
        }),
      );
    }

    return tx.coupon.updateMany({
      where,
      data: { claimedCount: { increment: quantity } },
    });
  }

  // ============================================================
  // 列表（消费者侧）
  // ============================================================

  /**
   * 当前可领取的券。
   *
   * ⚠️ **时间判定用数据库的 now()**（M15）：
   * `startsAt <= dbNow AND endsAt > dbNow`（左闭右开，
   * 与 `isWithinWindow` 的边界一致）。
   *
   * ⚠️ **平台券也在这里**（Task 5 补上的功能缺口）：
   * 平台券的 tenantId 指向平台租户，租户作用域内查不到它——
   * 但它**对所有店铺生效**，而领取路径已经支持平台券了，
   * 不把它列出来的话，用户在领券中心根本看不到平台券。
   * 所以额外走一次 `platformScope()`，**where 里必须带
   * `scope: PLATFORM`**——不加的话就是「把别家店的券也列出来」（M3）。
   */
  async listAvailable(): Promise<{ items: Coupon[]; total: number }> {
    const tenantId = this.currentTenantId();
    const dbNow = await this.databaseNow(this.prisma);

    const shopCoupons = await this.prisma.coupon.findMany({
      where: {
        tenantId,
        status: CouponStatus.ACTIVE,
        startsAt: { lte: dbNow },
        endsAt: { gt: dbNow },
      },
      orderBy: { createdAt: 'desc' },
    });

    const platformCoupons = await tenantContext.run(platformScope(), async () =>
      this.prisma.coupon.findMany({
        where: {
          scope: CouponScope.PLATFORM,
          status: CouponStatus.ACTIVE,
          startsAt: { lte: dbNow },
          endsAt: { gt: dbNow },
        },
        orderBy: { createdAt: 'desc' },
      }),
    );

    const items = [...shopCoupons, ...platformCoupons];
    return { items, total: items.length };
  }

  /**
   * 我持有的券。
   *
   * ⚠️ **CouponClaim 上没有 coupon 关系**（schema 里刻意只留 tenantId 标量），
   * 所以这里分两步：先查领取记录拿到 couponId，再按 id 批量查券。
   *
   * ⚠️ **平台券也要在列表里**（Task 5 补上的功能缺口）：
   * 领取记录落在**当前租户**下（领取平台券时记的是「这家店的这个用户
   * 领了平台券」），但券本身在平台租户那一行上——
   * 租户作用域的 `coupon.findMany` 查不到它。
   * 所以分两次查：店铺券走租户作用域，平台券走平台作用域。
   *
   * ⚠️ **软删过滤自动生效**：券被软删后，`coupon.findMany` 查不到它，
   * 「我的券」列表里就不会出现——不需要手写 `deletedAt: null`。
   *
   * ## 每用户状态（`used` / `claimedQuantity`）
   *
   * ⚠️ **「这个用户有没有用过」不能从 `coupons.usedCount` 读**——
   * 那是**全店**的计数快照，不是某个用户的。要判「这个用户」，
   * 必须查 `coupon_redemptions` 里**这个 customerId** 的行。
   *
   * ⚠️ **核销记录的 tenantId 是「下单的那家店」，不是券的租户**
   * （见 `coupon-redemption.service.ts` 的注释）：
   * 平台券在多家店被核销时，每家店都有自己的核销记录。
   * 所以**租户作用域内查就能查全**，不需要切平台作用域。
   *
   * ⚠️ **`RELEASED` 不算「用过」**：释放意味着额度已退回，券还能再用。
   * 所以只认 `RESERVED`（预占住）与 `USED`（真的用掉了）。
   */
  async listMine(
    customerId: string,
  ): Promise<{ items: MyCoupon[]; total: number }> {
    const tenantId = this.currentTenantId();
    const claims = await this.prisma.couponClaim.findMany({
      where: { tenantId, customerId },
      orderBy: { createdAt: 'asc' },
      // ⚠️ **quantity 一起 select 出来**：它就是「这个用户领了几张」。
      select: { couponId: true, quantity: true },
    });
    if (claims.length === 0) {
      return { items: [], total: 0 };
    }
    const claimedIds = [...new Set(claims.map((claim) => claim.couponId))];

    const shopCoupons = await this.prisma.coupon.findMany({
      where: { id: { in: claimedIds } },
      orderBy: { createdAt: 'desc' },
    });

    const platformCoupons = await tenantContext.run(platformScope(), async () =>
      this.prisma.coupon.findMany({
        where: { id: { in: claimedIds }, scope: CouponScope.PLATFORM },
        orderBy: { createdAt: 'desc' },
      }),
    );

    // ---- 每用户状态 ----
    //
    // ⚠️ **领取张数**：一个用户对一张券只有一行（唯一索引 (couponId, customerId)），
    // 所以直接取那一行的 quantity 就是张数。
    const quantityByCouponId = new Map<string, number>();
    for (const claim of claims) {
      quantityByCouponId.set(claim.couponId, claim.quantity);
    }

    // ⚠️ **已核销的券**：只查**这个用户**的核销记录。
    // 租户作用域内查（核销记录的 tenantId 是「下单的那家店」），
    // 平台券的核销记录也在当前租户下，不需要切平台作用域。
    const redemptions = await this.prisma.couponRedemption.findMany({
      where: {
        customerId,
        couponId: { in: claimedIds },
        status: {
          in: [CouponRedemptionStatus.RESERVED, CouponRedemptionStatus.USED],
        },
      },
      select: { couponId: true },
    });
    const usedCouponIds = new Set(redemptions.map((row) => row.couponId));

    const items: MyCoupon[] = [...shopCoupons, ...platformCoupons].map(
      (coupon) => ({
        ...coupon,
        used: usedCouponIds.has(coupon.id),
        claimedQuantity: quantityByCouponId.get(coupon.id) ?? 0,
      }),
    );
    return { items, total: items.length };
  }

  // ============================================================
  // 下单时的优惠计算（阶段 5a Task 4）
  // ============================================================

  /**
   * 组装 `DiscountContext` 并调纯函数。
   *
   * ⚠️ **候选券的查询在当前租户作用域内做**（M3）：
   * 租户扩展会自动附加 tenantId 条件，所以「别家店的券」根本查不到。
   *
   * ⚠️ **平台券走平台作用域查询，但只取 `scope = PLATFORM` 的**（M3）：
   * 平台券的 tenantId 指向平台租户，在租户作用域内查不到它。
   * 所以要显式走一次 `platformScope()`，**但 where 里必须带上
   * `scope: PLATFORM`**——不加的话就是「拿别的店的券来用」。
   *
   * ⚠️ **CouponClaim 上没有 coupon 关系**（勘误表第 11 条）：
   * 所以分两步查——先查领取记录拿到 couponId，再按 id 批量查券。
   *
   * ⚠️ **手动指定了券就只用那一张**（M2 / M17）：
   * 用户在结算页手动选了哪张，就该用哪张。否则用户选了 30 元券、
   * 系统偷偷用了 50 元券，界面上显示的和实际扣的不一样。
   * 「自动取最优」只在用户**没选**时兜底。
   */
  async computeForOrder(input: {
    tenantId: string;
    customerId: string;
    /** 商品原价小计（整数分），已锁定 SKU 的实时价算出来的 */
    originalAmount: number;
    items: Array<{ skuId: string; quantity: number; price: number }>;
    /** 客户端指定的券（只传 id，面额与门槛一律从库里读） */
    requestedCouponId?: string;
  }): Promise<OrderDiscount> {
    const { context, found, promotion } = await this.buildDiscountContext({
      tenantId: input.tenantId,
      customerId: input.customerId,
      originalAmount: input.originalAmount,
      items: input.items,
    });

    // ---- 3. 手动指定了券 → 收窄成那一张 ----
    //
    // ⚠️ **M2：客户端只传 couponId，面额与门槛一律从库里读**。
    // 这里把候选列表**收窄成那一张**——不是「客户端传了多少钱就减多少」。
    if (input.requestedCouponId) {
      const requestedId = input.requestedCouponId;

      // ⚠️ **已被占住/已用掉的券 → 409**（M5）：
      // 这与「券根本不能用」是**两回事**——前者是「你来晚了，这张券刚被别人用掉」，
      // 后者是「这张券不适用于这笔订单」。文案必须分开：
      // 用户看到「该券已被使用」知道该换一张，看到「优惠券不可用」知道该去掉它。
      if (found.alreadyUsedIds.has(requestedId)) {
        throw new ConflictException('该券已被使用');
      }

      const picked = found.candidates.find((c) => c.id === requestedId);
      if (!picked) {
        // ⚠️ **不在候选里就报错**，而不是「默默不打折」。
        // 默默不打折的话，用户在结算页看到「已用券 -10 元」，
        // 实际下单金额却没减——那是「界面显示的和实际扣的不一样」（M17）。
        //
        // 这里的文案是**通用**的：券不存在、不是你的、已过期、
        // 属于别家店——一律同一句话，避免变成「探测券是否存在」的通道。
        throw new BadRequestException('优惠券不可用');
      }
      // ⚠️ 收窄后要**重算**，不能沿用上面的多券结果——
      // 客户端明确选了哪张，就用那一张（哪怕另一张更优）。
      const single = computeDiscount({
        ...context,
        candidateCoupons: [picked],
      });
      return {
        ...single,
        appliedCoupon: single.appliedCoupon
          ? { ...single.appliedCoupon, ...picked }
          : null,
        appliedPromotion: promotion,
      };
    }

    // ---- 4. 没指定 → 在候选里取最优 ----
    //
    // ⚠️ 「自动取最优」是**用户没选**时的兜底（结算页默认带上用户选的券提交，
    // 所以实际路径是「手动指定」）。
    const result = computeDiscount(context);
    const picked = result.appliedCoupon
      ? found.candidates.find((c) => c.id === result.appliedCoupon?.id)
      : undefined;
    // ⚠️ 引擎的输出里没有 scope / tenantId——那两个字段从候选里补上
    // （核销时要按它选更新口径）。
    // `picked` 必然找得到：引擎选的券就是候选里的某一张。
    return {
      ...result,
      appliedCoupon:
        result.appliedCoupon && picked
          ? { ...result.appliedCoupon, ...picked }
          : null,
      appliedPromotion: promotion,
    };
  }

  /**
   * 组装 `DiscountContext`（查候选券 + 查生效的活动 + 组 context）。
   *
   * ⚠️ **为什么抽出来**：下单（`computeForOrder`）与预览（`preview`）要算的是
   * **同一件事**——同一套候选券、同一个活动、同一套门槛与封顶语义。
   * 抽出来是为了让两边**永远看到同一份上下文**：
   * 预览显示的金额与下单实际算出的金额必然一致（M17）。
   * 两处各写一遍的话，活动「取哪个」的规则一旦漂移，
   * 就会出现「预览显示减 20，下单只减 0」。
   *
   * ⚠️ **有效期判定用数据库的 `now()`**（M15），不用应用进程的时钟。
   */
  private async buildDiscountContext(input: {
    tenantId: string;
    customerId: string;
    originalAmount: number;
    items: Array<{ skuId: string; quantity: number; price: number }>;
  }): Promise<{
    context: DiscountContext;
    found: { candidates: CouponCandidate[]; alreadyUsedIds: Set<string> };
    promotion: Promotion | null;
  }> {
    // ---- 1. 候选券 ----
    const dbNow = await this.databaseNow(this.prisma);
    const found = await this.findCandidateCoupons(input.customerId, dbNow);

    // ---- 2. 当前生效的满减活动（租户作用域内）----
    const promotion = await this.prisma.promotion.findFirst({
      where: {
        status: PromotionStatus.ACTIVE,
        startsAt: { lte: dbNow },
        endsAt: { gt: dbNow },
        // ⚠️ **门槛先过滤掉没达标的**（这是阶段 5a 验收时发现的真实缺陷）：
        // 原来这里只按「减免额最大」排序取一个，取到门槛没达成的活动时，
        // 引擎会判定「门槛不满足」→ **整单没有活动优惠**，
        // 而同一时间另一个门槛已达、减免额较小的活动被跳过了。
        // 例：同时有「满500减88」与「满200减30」，订单 ¥459 时——
        // 「满500减88」门槛没达到，但「满200减30」达到了，
        // 用户本该减 ¥30，却一分钱没减（只按减免额排序取最大的那个）。
        //
        // ⚠️ **先过滤门槛、再按减免额排序**：达标的活动里挑减免额最大的。
        // 引擎里那道 `originalAmount >= promotion.minAmount` 的判定保留着
        // （纯函数不查库，两边都要有）。
        minAmount: { lte: input.originalAmount },
      },
      // ⚠️ 多个活动同时生效时取**减免额最大**的那个（达标的前提下）。
      orderBy: { discountAmount: 'desc' },
    });

    const context: DiscountContext = {
      tenantId: input.tenantId,
      customerId: input.customerId,
      originalAmount: input.originalAmount,
      items: input.items,
      candidateCoupons: found.candidates,
      promotion: promotion
        ? {
            id: promotion.id,
            name: promotion.name,
            minAmount: promotion.minAmount,
            discountAmount: promotion.discountAmount,
            startsAt: promotion.startsAt,
            endsAt: promotion.endsAt,
          }
        : null,
      now: dbNow,
    };

    return { context, found, promotion };
  }

  // ============================================================
  // 优惠预览（阶段 5a Task 6 的后端部分）
  // ============================================================

  /**
   * 优惠预览：结算页要显示的四行金额（原价 / 活动减 / 券减 / 实付）。
   *
   * ## 为什么预览要放在后端
   *
   * ⚠️ **券的减免额不等于券的面额**：
   * - 面额会被**封顶**（`min(coupon.value, 活动后金额)`）
   * - 门槛也是按**活动后金额**判的（`afterPromotion < coupon.minAmount` 就不满足）
   *
   * 前端自己算就要把引擎的逻辑复制一份，两处必然漂移。
   * 所以预览由后端用**已有的纯函数引擎**算，前端只负责展示。
   *
   * ## M17：预览值是估算值
   *
   * ⚠️ **`originalAmount` 是客户端传的估算值**（前端用购物车里 SKU 的价格算出来的），
   * **只用于预览**。下单时服务端会在锁住 SKU 之后按**实时价**重算，
   * 预览值不参与实付计算。页面上要提示「以提交时为准」。
   *
   * ## 只读
   *
   * ⚠️ **预览不做任何写操作**：不预占券、不核销、不改计数。
   * 预览是给用户看的，不能因为「看一眼」就把券占住。
   *
   * ## 门槛与封顶的语义
   *
   * ⚠️ **一律由引擎决定**：每张券单独调一次 `computeDiscount`，
   * service 层**不另写一套**门槛/封顶判断——那是本阶段最容易出错的地方
   * （设计文档 §4.2）。
   */
  async preview(
    customerId: string,
    originalAmount: number,
  ): Promise<CouponPreview> {
    const { context, found, promotion } = await this.buildDiscountContext({
      tenantId: this.currentTenantId(),
      customerId,
      originalAmount,
      // ⚠️ **items 只用于判定券的适用范围**，本阶段恒为全店，
      // 所以留空数组不影响结果。真正的适用范围判定在候选查询里。
      items: [],
    });

    // ---- 每张候选券单独算一次 ----
    //
    // ⚠️ **候选集里包含「门槛不满足」的券**：前端要显示它「不可用」，
    // 不能把它悄悄去掉（用户会以为券不见了）。
    // 门槛不满足时引擎算出的 `couponDiscountAmount` 恒为 0。
    const coupons = found.candidates.map((coupon) => {
      const single = computeDiscount({
        ...context,
        candidateCoupons: [coupon],
      });
      return {
        id: coupon.id,
        code: coupon.code,
        name: coupon.name,
        type: coupon.type,
        value: coupon.value,
        minAmount: coupon.minAmount,
        discountAmount: single.couponDiscountAmount,
        payableAmount: single.payableAmount,
      };
    });

    // ---- 最优券 ----
    //
    // ⚠️ **一次性把所有候选券交给引擎**取最优，
    // 不自己比较「折后总价」——那个判据由引擎实现（M16）。
    const best = computeDiscount(context);

    return {
      originalAmount,
      promotionDiscountAmount: best.promotionDiscountAmount,
      promotionName: promotion?.name ?? null,
      coupons,
      bestCouponId: best.appliedCoupon?.id ?? null,
      bestCouponDiscountAmount: best.couponDiscountAmount,
      payableAmount: best.payableAmount,
    };
  }

  /**
   * 找出这个用户当前可用的候选券。
   *
   * 「可用」的判定（设计文档 §4.3）：
   * - 用户持有（`coupon_claims` 里有它的领取记录）
   * - 券本身 `status = ACTIVE`
   * - 券在有效期内（`startsAt <= dbNow < endsAt`）
   * - 券没被用过（没有 `status IN (RESERVED, USED)` 的核销记录）
   * - 适用范围匹配（平台券全店可用，店铺券限本店）
   *
   * ⚠️ **返回顺序按领取时间升序**：引擎在「折后总价并列」时取先到的那张，
   * 候选顺序必须确定，否则同一个订单两次下单可能算出不同的券。
   *
   * ⚠️ **「已被占住/已用掉」单独返回**：它不在候选里（不能用），
   * 但要**单独告诉调用方**——客户端指定这张券时该回 409「该券已被使用」，
   * 而不是笼统的 400「优惠券不可用」。
   */
  private async findCandidateCoupons(
    customerId: string,
    dbNow: Date,
  ): Promise<{
    candidates: CouponCandidate[];
    alreadyUsedIds: Set<string>;
  }> {
    // 1. 领取记录（租户作用域内 —— 扩展自动附加 tenantId 条件）
    const claims = await this.prisma.couponClaim.findMany({
      where: { customerId },
      orderBy: { createdAt: 'asc' },
      select: { couponId: true },
    });
    if (claims.length === 0) {
      return { candidates: [], alreadyUsedIds: new Set() };
    }
    const claimedIds = [...new Set(claims.map((claim) => claim.couponId))];

    // 2. 按 id 批量查券 —— **分两步**（勘误表第 11 条：
    //    CouponClaim 上没有 coupon 关系，include 编译不过）。
    //
    //    店铺券：租户作用域内查，扩展自动过滤掉别家店的券（M3）。
    const shopCoupons = await this.prisma.coupon.findMany({
      where: {
        id: { in: claimedIds },
        status: CouponStatus.ACTIVE,
        startsAt: { lte: dbNow },
        endsAt: { gt: dbNow },
      },
    });

    // 3. 平台券：走平台作用域查，**where 里必须显式限定 scope = PLATFORM**。
    //
    // ⚠️ 平台作用域下扩展**不附加** tenantId 条件，
    // 所以不加 `scope: PLATFORM` 就会把别家店的券一起捞出来（M3）。
    const platformCoupons = await tenantContext.run(platformScope(), async () =>
      this.prisma.coupon.findMany({
        where: {
          id: { in: claimedIds },
          scope: CouponScope.PLATFORM,
          status: CouponStatus.ACTIVE,
          startsAt: { lte: dbNow },
          endsAt: { gt: dbNow },
        },
      }),
    );

    const coupons = [...shopCoupons, ...platformCoupons];
    if (coupons.length === 0) {
      return { candidates: [], alreadyUsedIds: new Set() };
    }

    // 4. 已被占住/已用掉的券要排除。
    //
    // ⚠️ **「没被用掉」的判定与部分唯一索引是同一件事的两个面**：
    // 索引保证「不可能同时有两条」，这里的查询保证「只把没被占的拿出来当候选」。
    const used = await this.prisma.couponRedemption.findMany({
      where: {
        couponId: { in: coupons.map((coupon) => coupon.id) },
        status: {
          in: [CouponRedemptionStatus.RESERVED, CouponRedemptionStatus.USED],
        },
      },
      select: { couponId: true },
    });
    const usedIds = new Set(used.map((row) => row.couponId));

    // 5. 按**领取时间升序**排（引擎的「并列取先到」依赖这个顺序）
    const claimedAt = new Map<string, number>();
    for (const claim of claims) {
      if (!claimedAt.has(claim.couponId)) {
        claimedAt.set(claim.couponId, claimedAt.size);
      }
    }
    const ordered = [...coupons].sort(
      (a, b) => (claimedAt.get(a.id) ?? 0) - (claimedAt.get(b.id) ?? 0),
    );

    const candidates: CouponCandidate[] = [];
    const alreadyUsedIds = new Set<string>();
    for (const coupon of ordered) {
      if (usedIds.has(coupon.id)) {
        alreadyUsedIds.add(coupon.id);
        continue;
      }
      candidates.push({
        id: coupon.id,
        code: coupon.code,
        name: coupon.name,
        type: coupon.type,
        value: coupon.value,
        minAmount: coupon.minAmount,
        startsAt: coupon.startsAt,
        endsAt: coupon.endsAt,
        // ⚠️ **带上作用域与所属租户**：核销时要按它选更新口径——
        // 平台券的计数快照在**平台租户**的行上，租户作用域更新不到它。
        scope: coupon.scope,
        tenantId: coupon.tenantId,
      });
    }
    return { candidates, alreadyUsedIds };
  }

  // ============================================================
  // 内部工具
  // ============================================================

  /**
   * 解析并校验有效期。
   *
   * ⚠️ **跨字段校验放在 service 层**：`endsAt > startsAt` 这类规则
   * class-validator 的装饰器做不到。用 `@ValidateIf` 之类的组合技巧
   * 会让校验规则散在两处。
   */
  private parseWindow(
    startsAtRaw: string,
    endsAtRaw: string,
  ): { startsAt: Date; endsAt: Date } {
    const startsAt = new Date(startsAtRaw);
    const endsAt = new Date(endsAtRaw);
    if (endsAt.getTime() <= startsAt.getTime()) {
      throw new BadRequestException('结束时间必须晚于开始时间');
    }
    return { startsAt, endsAt };
  }

  /**
   * 取数据库的当前时间。
   *
   * ⚠️ **M15：过期判定统一用数据库的 `now()`**，不用应用进程的时钟。
   *
   * 为什么：多副本部署时各机器的时钟有偏差，边界时刻会出现
   * 「这张券在这台机器上过期了、在那台机器上还没过期」。
   * 数据库的 `now()` 是**单一事实来源**。
   *
   * ⚠️ 事务内用 `tx.$queryRaw`（事务客户端是真正的扩展 client，
   * 原生 SQL 方法在它上面是有的）；事务外用 `TenantPrismaService.databaseNow()`
   * ——后者是刻意收敛过的唯一原生 SQL 入口（只查 `now()`，不涉及租户数据）。
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

  /** 读一张券，读不到就 404 */
  private async requireCoupon(id: string, tenantId: string): Promise<Coupon> {
    const coupon = await this.prisma.coupon.findFirst({
      where: { id, tenantId },
    });
    if (!coupon) {
      throw new NotFoundException('优惠券不存在');
    }
    return coupon;
  }

  /**
   * 是不是 Prisma 的唯一约束冲突（P2002）。
   *
   * 用 `error.code === 'P2002'` 而不是 `instanceof PrismaClientKnownRequestError`：
   * `@prisma/client` 在 CJS/ESM 混载或多处 require 时会得到不同的模块实例，
   * instanceof 于是恒为 false。
   */
  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'P2002'
    );
  }
}
