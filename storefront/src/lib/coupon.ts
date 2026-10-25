/**
 * 优惠券的前端类型 + 纯函数。
 *
 * 单独成文件而不是散在各个组件里：
 * - **类型**在服务端页面（领券中心、结算页）与客户端组件之间共享，
 *   两边各写一份必然漂移（后端返回的字段名一变，编译期才发现）；
 * - **纯函数**（金额拆分、可用判定、状态判定）要在单元测试里断言，
 *   塞在组件里就没法单独测了。
 *
 * ⚠️ **本文件不负责算券能减多少**——那是后端优惠引擎的活
 * （`api/src/modules/coupon/discount-engine.ts`）。前端只**展示**引擎算好的数，
 * 以及做「能不能用」这种**只读**判断，绝不自己复制一份门槛/封顶逻辑。
 *
 * ⚠️ 金额一律整数分（阶段 0.4 的全局约定）。前端**只做展示用的换算**
 * （`formatPrice`），真实金额永远由后端在下单时算——
 * 下单请求体里连面额、门槛都不许带（护栏 M1 / M2）。
 */

/** 券的类型：FIXED = 满减券（面额减固定金额）；PERCENT = 折扣券（预留） */
export type CouponType = 'FIXED' | 'PERCENT';

/**
 * 预览里的**候选券**（后端 `GET /coupons/preview` 的 `coupons` 每一项）。
 *
 * ⚠️ `discountAmount` 是**后端引擎算好的**：门槛按「活动后金额」判、
 * 减免额按「活动后金额」封顶（`min(value, afterPromotion)`），
 * 前端拿到的就是最终值。
 */
export interface PreviewCoupon {
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
}

/**
 * 优惠预览（后端 `GET /coupons/preview` 的返回）。
 *
 * ⚠️ **全部是估算值**（护栏 M17）：`originalAmount` 由客户端按购物车里
 * SKU 的价格算出来，只用于预览；下单时服务端会按**实时价**重算。
 * 页面要提示「以提交时为准」。
 */
export interface CouponPreview {
  /** 商品原价小计（整数分，客户端估算值） */
  originalAmount: number;
  /** 满减活动减免（整数分） */
  promotionDiscountAmount: number;
  /** 命中的活动名（没有生效的活动就是 null） */
  promotionName: string | null;
  /** 候选券（含门槛不满足的——前端要显示它「不可用」，不能悄悄去掉） */
  coupons: PreviewCoupon[];
  /** 自动取最优时的券 id */
  bestCouponId: string | null;
  /** 自动取最优时减了多少（整数分） */
  bestCouponDiscountAmount: number;
  /** 自动取最优时的实付（整数分） */
  payableAmount: number;
}

/**
 * 可领取的券（后端 `GET /coupons/available` 的每一项）。
 *
 * ⚠️ 这是**原始的 Coupon 行**：不含「这个用户用没用过」——
 * 那个信息在 `GET /coupons/mine` 里。
 */
export interface AvailableCoupon {
  id: string;
  code: string;
  name: string;
  description: string | null;
  type: CouponType;
  /** 面额（整数分） */
  value: number;
  /** 门槛（整数分） */
  minAmount: number;
  /** 发放总量上限；null = 不限量 */
  totalLimit: number | null;
  /** 已发放张数 */
  claimedCount: number;
  /** 作用域：SHOP = 本店券；PLATFORM = 平台券（全店可用） */
  scope: 'SHOP' | 'PLATFORM';
  /** 券状态（ACTIVE / DISABLED / …） */
  status: string;
  /** 生效起始时间（ISO 字符串） */
  startsAt: string;
  /** 生效截止时间（ISO 字符串） */
  endsAt: string;
}

/**
 * 我持有的券（后端 `GET /coupons/mine` 的每一项）。
 *
 * ⚠️ 比 `AvailableCoupon` 多两个字段，是**这个用户与这张券的关系**：
 * 「我有没有核销过」「我领了几张」。这两个信息不在券本身里，
 * 而在领取记录与核销记录里。
 */
export interface MyCoupon extends AvailableCoupon {
  /** 这个用户有没有核销过这张券 */
  used: boolean;
  /** 这个用户领了几张 */
  claimedQuantity: number;
}

/**
 * 四行金额的拆分结果。
 *
 * ⚠️ 全部是**整数分**。
 */
export interface DiscountBreakdown {
  /** 原价 */
  originalAmount: number;
  /** 满减活动减免 */
  promotionDiscountAmount: number;
  /** 优惠券减免 */
  couponDiscountAmount: number;
  /** 优惠合计（活动 + 券），已封顶到原价 */
  totalDiscount: number;
  /** 实付，恒 >= 0 */
  payableAmount: number;
}

/**
 * 把「原价 / 活动减 / 券减」算成四行金额。
 *
 * ⚠️ **全程整数域**：绝不除以 100，绝不出现浮点。
 * 换算成「元」只在展示层做（`formatPrice`）——计算层一旦出现浮点，
 * 「10000 - 2000 - 1000」就会变成 6999.999999999999。
 *
 * ⚠️ **优惠额封顶到原价**：活动减与券减的合计超过原价时截断到原价，
 * 实付恒 >= 0。没有这个封顶，一张 1000 元的券用在 300 元的单上，
 * 页面会显示「实付 -700」，而服务端算出来的是 0——界面和实付对不上。
 *
 * ⚠️ 这个结果是**展示用的估算值**（护栏 M17）：真实金额由后端在下单时
 * 按实时价重算。
 */
export function discountBreakdown(input: {
  originalAmount: number;
  promotionDiscountAmount: number;
  couponDiscountAmount: number;
}): DiscountBreakdown {
  const { originalAmount, promotionDiscountAmount, couponDiscountAmount } =
    input;

  // ⚠️ 先把每一项优惠各自截断到原价，再相加：
  // 「活动减 400 + 券减 400、原价 500」如果先加再截断，
  // 合计是 500（截断后），但实付会是 -300。两个都截断才对。
  const promotion = Math.max(0, Math.min(promotionDiscountAmount, originalAmount));
  const coupon = Math.max(0, Math.min(couponDiscountAmount, originalAmount));

  const totalDiscount = Math.min(promotion + coupon, originalAmount);
  const payableAmount = Math.max(0, originalAmount - totalDiscount);

  return {
    originalAmount,
    promotionDiscountAmount: promotion,
    couponDiscountAmount: coupon,
    totalDiscount,
    payableAmount,
  };
}

/**
 * 剩余可领张数。
 *
 * ⚠️ `totalLimit` 为 null = 不限量，返回 null（调用方据此显示「不限量」
 * 而不是「剩余 0 张」）。
 *
 * ⚠️ **下限 0**：领取计数与限量在并发下可能出现短暂的越界，
 * 显示成负数会让用户以为系统算错了。
 */
export function couponRemaining(coupon: {
  totalLimit: number | null;
  claimedCount: number;
}): number | null {
  if (coupon.totalLimit === null) {
    return null;
  }
  return Math.max(0, coupon.totalLimit - coupon.claimedCount);
}

/**
 * 这张券在当前原价下能不能用。
 *
 * ⚠️ **判据是 `discountAmount > 0`**，不是「原价 >= 门槛」。
 *
 * 为什么：门槛是按**活动后金额**判的、减免额按**活动后金额**封顶，
 * 而后端把这两条算完之后才把结果交给前端（`GET /coupons/preview`）。
 * 前端自己拿 `originalAmount >= coupon.minAmount` 去判，
 * 得到的是一个**与服务端不一致**的判据：
 * 有满减活动时，原价 12000、门槛 10000、活动减 3000 —— 服务端按
 * 「活动后 9000 < 10000」判定门槛不满足、这张券不可用，
 * 而前端会显示它可用。用户点下去必然拿到后端的 400「优惠券不可用」。
 *
 * 所以前端只信后端算出来的减免额。
 */
export function couponUsable(coupon: PreviewCoupon): boolean {
  return coupon.discountAmount > 0;
}

/**
 * 我持有的券的状态。
 *
 * - `EXPIRED`：券被下架（status 不是 ACTIVE）或已过有效期
 * - `USED_UP`：这个用户核销过它
 * - `AVAILABLE`：其余
 *
 * ⚠️ **`now` 由调用方传入**，函数内部不读 `Date.now()`——
 * 这样才能确定性地测「刚好过期」这种边界。
 * 有效期窗口是**左闭右开**（`startsAt <= now < endsAt`），
 * 所以 `now === endsAt` 已经是过期。
 *
 * ⚠️ 判定顺序是「先过期、后已用」：一张过期且用掉的券显示成「已用掉」
 * 意义不大，用户更关心「它已经不能用了」。
 */
export function myCouponState(
  coupon: MyCoupon,
  now: Date,
): 'AVAILABLE' | 'USED_UP' | 'EXPIRED' {
  if (coupon.status !== 'ACTIVE') {
    return 'EXPIRED';
  }
  if (now.getTime() >= new Date(coupon.endsAt).getTime()) {
    return 'EXPIRED';
  }
  if (coupon.used) {
    return 'USED_UP';
  }
  return 'AVAILABLE';
}

/**
 * 把「预览 + 用户选的券」算成四行金额。
 *
 * ⚠️ **「没选券」不等于「不用券」**。
 *
 * 后端在没收到 `couponId` 时会**自动取最优券**
 * （`api/src/modules/coupon/coupon.service.ts` 的 `computeForOrder`）。
 * 所以这里的「没选」指的是「用户没有手动指定某一张券」，
 * 此时应显示后端算出的 `bestCouponDiscountAmount`（自动取最优），
 * 而不是把券减免显示成 0。
 *
 * 前端如果显示「不使用优惠券」却让后端自动用了券，
 * 界面上的实付就和真实实付对不上（护栏 M17）。
 *
 * ⚠️ 选了一个**找不到**的券 id → 券减免按 0 算（不猜）：
 * 下单时后端会 400「优惠券不可用」，前端不该在这里编一个减免额。
 */
export function previewBreakdown(
  preview: CouponPreview,
  selectedCouponId: string | null,
): DiscountBreakdown {
  // ⚠️ 空串等价于「没选」：`<select>` 的默认值就是空串。
  const selectedId =
    selectedCouponId === null || selectedCouponId === ''
      ? null
      : selectedCouponId;

  let couponDiscountAmount: number;
  if (selectedId === null) {
    // 没手动指定 → 后端会自动取最优
    couponDiscountAmount = preview.bestCouponDiscountAmount;
  } else {
    const picked = preview.coupons.find((coupon) => coupon.id === selectedId);
    couponDiscountAmount = picked ? picked.discountAmount : 0;
  }

  return discountBreakdown({
    originalAmount: preview.originalAmount,
    promotionDiscountAmount: preview.promotionDiscountAmount,
    couponDiscountAmount,
  });
}
