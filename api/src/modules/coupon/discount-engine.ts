/**
 * 优惠引擎（阶段 5a Task 2）。
 *
 * ⚠️ **本文件是纯函数**：不碰数据库、不读上下文、不读 `Date.now()`。
 * 时间由调用方通过 `context.now` 传进来（这是 M15 的落点——
 * 过期判定用数据库的 `now()`，不用应用进程的时钟）。
 *
 * 为什么必须纯函数：优惠引擎的每一条分支都要能被完整断言。
 * 引擎读数据库的话，测它就要起数据库 + 造数据 + 起租户上下文，
 * 测试会变成「构造场景」而不是「断言行为」。
 * 阶段 3 的「库存流水双语义」就是靠把逻辑做成可测的纯函数才抓住 bug 的。
 *
 * ## 算法（顺序不可换，设计文档 §4.2）
 *
 * ```
 * 1. promotionDiscount = 0
 *    若 promotion 存在且 未过期 且 originalAmount >= promotion.minAmount：
 *        promotionDiscount = min(promotion.discountAmount, originalAmount)
 *    afterPromotion = originalAmount - promotionDiscount
 *
 * 2. 对每张候选券：
 *        若券已过期 → 不可用
 *        若 afterPromotion < coupon.minAmount → 该券不可用
 *        else：
 *            discount = min(coupon.value, afterPromotion)
 *            该券的折后总价 = afterPromotion - discount
 *    取「折后总价最小」的那张券；并列时取先到的
 *
 * 3. couponDiscount = 选中券的 discount（没选中则 0）
 * 4. payable = afterPromotion - couponDiscount     ← 恒 >= 0
 * ```
 *
 * ⚠️ **门槛按「活动后金额」判定，优惠额也按「活动后金额」封顶。**
 * 用户视角：应付多少，就按多少判门槛、减多少。
 *
 * ⚠️ **满减额不能把金额减成负数**：`min(discount, 金额)` 这个封顶是硬要求。
 * 没有它，一张 100 元的满减券用在 30 元的订单上会让 payable 变成 -70。
 */

/** 候选券的输入形状（由 service 层从库里读出来） */
export interface CouponCandidate {
  id: string;
  code: string;
  name: string;
  /** FIXED：满减券（本阶段唯一实现）；PERCENT：折扣券（预留） */
  type: 'FIXED' | 'PERCENT';
  /** FIXED 时是面额（整数分）；PERCENT 时是折扣数（85 = 85 折） */
  value: number;
  /** 使用门槛（整数分）。0 = 无门槛 */
  minAmount: number;
  /** 生效起始时间 */
  startsAt: Date;
  /** 生效截止时间 */
  endsAt: Date;
}

/** 满减活动的输入形状 */
export interface PromotionCandidate {
  id: string;
  name: string;
  /** 门槛（整数分）：订单商品原价小计 >= minAmount 才享受 */
  minAmount: number;
  /** 减免金额（整数分） */
  discountAmount: number;
  /**
   * 生效起始时间。
   *
   * ⚠️ 设计文档 §4.1 的 `PromotionCandidate` 只列了
   * `id / name / minAmount / discountAmount`，但 §4.2 的算法说
   * 「若 promotion 存在且 **未过期**」——
   * 「未过期」这个判据在输入形状里必须有对应字段，否则引擎没法实现它。
   * 活动与券的有效期判定逻辑相同（都是 `startsAt <= now < endsAt`），
   * 所以两个 candidate 都带上这两个字段。
   */
  startsAt: Date;
  /** 生效截止时间 */
  endsAt: Date;
}

/** 引擎的输入 */
export interface DiscountContext {
  tenantId: string;
  customerId: string;
  /** 商品原价小计（整数分），已锁定 SKU 的实时价算出来的 */
  originalAmount: number;
  /** 该订单的 SKU 明细，用于判定券的适用范围（本阶段恒为全店） */
  items: Array<{ skuId: string; quantity: number; price: number }>;
  /** 用户持有的候选券 */
  candidateCoupons: CouponCandidate[];
  /** 当前生效的店铺满减活动 */
  promotion: PromotionCandidate | null;
  /**
   * 当前时间。
   *
   * ⚠️ **由调用方传入，引擎自己不读 `Date.now()`**——
   * 这样测试可以确定性地构造「已过期 / 未过期」的场景。
   *
   * ⚠️ 生产上这个值应当来自**数据库的 `now()`**（M15）：
   * 用应用进程的时钟，多副本部署时各机器的时钟有偏差，
   * 边界时刻会出现「这张券在这台机器上过期了、在那台机器上还没过期」。
   */
  now: Date;
}

/** 引擎的输出 */
export interface DiscountResult {
  /** 用了哪张券（没就是 null） */
  appliedCoupon: {
    id: string;
    code: string;
    name: string;
    discountAmount: number;
  } | null;
  /** 满减活动减免（整数分） */
  promotionDiscountAmount: number;
  /** 券减免（整数分） */
  couponDiscountAmount: number;
  /** 最终应付（整数分）。恒 >= 0 */
  payableAmount: number;
}

/**
 * 计算优惠。
 *
 * ⚠️ **全程整数域**：`min` / 加减都不涉及浮点。
 * 将来做折扣券（PERCENT）时，折扣额必须用整数域算：
 * `Math.round(原价 * (100 - 折扣) / 100)`，绝不能 `原价 * (1 - 折扣/100)`
 * ——后者会引入浮点尾数（M11）。
 */
export function computeDiscount(context: DiscountContext): DiscountResult {
  const { originalAmount, candidateCoupons, promotion, now } = context;

  // ---- 1. 满减活动 ----
  //
  // ⚠️ 活动的过期判定用**调用方传入的 now**（生产上是数据库的 now()），
  // 不用应用进程的时钟（M15）。
  let promotionDiscountAmount = 0;
  if (
    promotion &&
    isWithinWindow(promotion.startsAt, promotion.endsAt, now) &&
    originalAmount >= promotion.minAmount
  ) {
    // ⚠️ 封顶：活动减免不能超过原价，否则 payable 会变负（M10）。
    promotionDiscountAmount = Math.min(
      promotion.discountAmount,
      originalAmount,
    );
  }
  const afterPromotion = originalAmount - promotionDiscountAmount;

  // ---- 2. 券：逐张算折后总价，取最优 ----
  //
  // ⚠️ 「最优」的判据是**折后总价最小**（设计文档 §4.2），
  // 不是「优惠额最大」——两者在金额被封顶时不等价：
  // 一张面额 10000 的券用在 3000 的单上，优惠额被封顶成 3000，
  // 折后 0；另一张面额 2000 的券优惠 2000，折后 1000。前者更优。
  let best: {
    coupon: CouponCandidate;
    discount: number;
    payable: number;
  } | null = null;

  for (const coupon of candidateCoupons) {
    // ⚠️ PERCENT 本阶段不实现：静默跳过（不抛异常）。
    // 抛异常的话，库里存了一张 PERCENT 券就会让整个下单流程挂掉——
    // 那比「这张券不生效」糟糕得多。
    if (coupon.type !== 'FIXED') {
      continue;
    }
    // 券的有效期判定与活动同款（M15：时间由调用方传入）
    if (!isWithinWindow(coupon.startsAt, coupon.endsAt, now)) {
      continue;
    }
    // 门槛按**活动后金额**判定
    if (afterPromotion < coupon.minAmount) {
      continue;
    }
    // ⚠️ 优惠额按**活动后金额**封顶（M10）
    const discount = Math.min(coupon.value, afterPromotion);
    const payable = afterPromotion - discount;

    if (best === null || payable < best.payable) {
      best = { coupon, discount, payable };
    }
    // ⚠️ **并列时取先到的**：上面的比较是严格小于（`<`），
    // 所以优惠额相等（折后总价相等）时保留先遍历到的那张。
    // 候选券的顺序由 service 层按 `claimedAt` 升序给出，
    // 保证「并列取先到的」是确定的、可测的。
  }

  const couponDiscountAmount = best?.discount ?? 0;

  // ---- 3 & 4. 实付 ----
  //
  // ⚠️ 恒 >= 0：步骤 2 的 `min` 保证了 discount <= afterPromotion，
  // 而 afterPromotion >= 0（活动减免也被封顶了）。
  const payableAmount = afterPromotion - couponDiscountAmount;

  return {
    appliedCoupon: best
      ? {
          id: best.coupon.id,
          code: best.coupon.code,
          name: best.coupon.name,
          discountAmount: best.discount,
        }
      : null,
    promotionDiscountAmount,
    couponDiscountAmount,
    payableAmount,
  };
}

/**
 * 当前时刻是否落在有效期内。
 *
 * ⚠️ 边界是**左闭右开**（`startsAt <= now < endsAt`）：
 * `startsAt === endsAt` 意味着「有效期内长度为 0」，永远不生效。
 */
export function isWithinWindow(
  startsAt: Date | null | undefined,
  endsAt: Date | null | undefined,
  now: Date,
): boolean {
  if (startsAt && now.getTime() < startsAt.getTime()) {
    return false;
  }
  if (endsAt && now.getTime() >= endsAt.getTime()) {
    return false;
  }
  return true;
}
