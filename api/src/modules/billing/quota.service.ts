import {
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Plan } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';

/** 功能开关的键（**用常量，不写字面量**） */
export const FEATURE_MARKETING = 'marketing';

/** 额度检查的种类 */
export type QuotaKind = 'PRODUCT' | 'SKU' | 'STORE';

const QUOTA_LABEL: Record<QuotaKind, string> = {
  PRODUCT: '商品',
  SKU: 'SKU',
  STORE: '店铺',
};

/**
 * 额度与功能权限。
 *
 * ⚠️ **检查点在 service 层**（护栏 M16）：只在 controller 层拦的话，
 * 绕过 controller 直接调 service 就拦不住。
 *
 * ⚠️ **额度与功能开关实时读当前套餐**（护栏 M8）：商家在页面上看到什么，
 * 就是什么。套餐改了额度，已订阅的商家立刻按新额度判。
 * （**费率不一样** —— 它影响已成交的钱，所以下单时快照在订单上。）
 *
 * ⚠️ **本模块不 import `order` / `product` / `coupon` / `tenants`** ——
 * 那几个模块要 import 本模块（单向），反过来就成环了。
 */
@Injectable()
export class QuotaService {
  constructor(private readonly prisma: TenantPrismaService) {}

  /** 当前租户的套餐（没有订阅就没有套餐） */
  async currentPlan(tenantId: string): Promise<Plan | null> {
    const subscription = await this.prisma.subscription.findFirst({
      where: { tenantId },
    });
    if (!subscription) {
      return null;
    }
    return this.prisma.plan.findFirst({ where: { id: subscription.planId } });
  }

  /**
   * 这个功能**有没有被限制**。
   *
   * ⚠️ **没有套餐 → 不限制**（返回 true）：额度与功能开关都是「套餐给的」，
   * 没套餐就没有限制。⚠️ 这与「套餐明确不给」是**两件事** ——
   * 前者是不设限，后者是禁止。混为一谈会把「还没订阅」的商家
   * 整个功能都禁掉（阶段 5a 的商家就是这么被误伤的）。
   *
   * ⚠️ **套餐里缺这个键 → 视为不给**（保守）：功能开关是「白名单」语义 ——
   * 套餐没显式打开的功能，就当它没有。
   */
  async hasFeature(tenantId: string, feature: string): Promise<boolean> {
    const plan = await this.currentPlan(tenantId);
    if (!plan) {
      return true;
    }
    const features = (plan.features ?? {}) as Record<string, unknown>;
    return features[feature] === true;
  }

  /**
   * 额度检查：超了就拒绝。
   *
   * ⚠️ **没有套餐 → 不限制**：额度是套餐给的，没套餐就没有上限。
   * ⚠️ **上限为 null → 不限制**（与阶段 5a 的 `totalLimit: null` 同款）。
   */
  async assertWithinQuota(tenantId: string, kind: QuotaKind): Promise<void> {
    const plan = await this.currentPlan(tenantId);
    if (!plan) {
      return;
    }
    const limit =
      kind === 'PRODUCT'
        ? plan.maxProducts
        : kind === 'SKU'
          ? plan.maxSkus
          : plan.maxStores;
    if (limit === null || limit === undefined) {
      return;
    }
    const current = await this.countUsage(tenantId, kind);
    if (current >= limit) {
      throw new ConflictException(
        `当前套餐最多 ${limit} 个${QUOTA_LABEL[kind]}，请升级套餐`,
      );
    }
  }

  /**
   * 计数。
   *
   * ⚠️ **用租户作用域的 `count()`** —— 扩展自动附加 tenantId 条件，
   * 软删过滤也自动生效（已软删的商品不占额度）。
   */
  private async countUsage(tenantId: string, kind: QuotaKind): Promise<number> {
    if (kind === 'PRODUCT') {
      return this.prisma.product.count({ where: { tenantId } });
    }
    if (kind === 'SKU') {
      return this.prisma.sku.count({ where: { tenantId } });
    }
    return this.prisma.store.count({ where: { tenantId } });
  }

  /**
   * 功能开关检查：没有这个功能就拒绝。
   *
   * ⚠️ **拒绝的文案要说清是套餐的问题**（护栏 M14）：
   * 「当前套餐不包含该功能，请升级套餐」——
   * 商家看到这句话才知道下一步做什么。
   */
  async assertHasFeature(tenantId: string, feature: string): Promise<void> {
    if (await this.hasFeature(tenantId, feature)) {
      return;
    }
    throw new ForbiddenException('当前套餐不包含该功能，请升级套餐');
  }
}
