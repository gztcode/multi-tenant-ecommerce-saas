import {
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Plan } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import type { PrismaTransaction } from '../../common/prisma/prisma-transaction';

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

  /**
   * 当前租户的套餐（没有订阅就没有套餐）。
   *
   * ⚠️ **事务内必须传 `tx`**：交互事务会独占一条连接，
   *    回调内再用 `this.prisma` 会再借一条 → 小连接池上死等（P2024）。
   *    阶段 10 修的就是这个。
   */
  async currentPlan(
    tenantId: string,
    client: PrismaTransaction | TenantPrismaService = this.prisma,
  ): Promise<Plan | null> {
    const subscription = await client.subscription.findFirst({
      where: { tenantId },
    });
    if (!subscription) {
      return null;
    }
    return client.plan.findFirst({ where: { id: subscription.planId } });
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
   * 额度检查：超过上限就拒绝。
   *
   * ⚠️ **没有套餐 → 不限制**：额度是套餐给的，没套餐就没有上限。
   * ⚠️ **上限为 null → 不限制**（与阶段 5a 的 `totalLimit: null` 同款）。
   *
   * ⚠️ **必须在事务内调用，并显式传入 `tx`**（审计 P2-10）。
   *    原来的写法是「先查后判」：`count` 与随后的写入分处两地，
   *    并发请求之间谁也看不见谁 —— 实测上限 1 的套餐、10 个并发创建请求
   *    **建出 6 个商品**。光把检查搬进事务**还不够**：PostgreSQL 默认的
   *    READ COMMITTED 下，两个并发事务各自 `count` 会拿到同一个旧快照，
   *    于是双双放行。所以下面还要**先锁住本租户的订阅行**，
   *    让同一租户的额度检查真正排队。
   *
   * ⚠️ **参数是「净增量」而不是「当前数必须小于上限」**：
   *    规格矩阵替换的判定口径是「替换完成后的 SKU 数」，而它只有写完之后
   *    才数得准（见 `spec-matrix.service.ts`），所以那里传 `delta = 0`；
   *    缩小矩阵时 `delta` 甚至是负数（释放额度），必须放行。
   *
   * @param delta 本次操作带来的**净增量**。默认 1（新建一条）。
   */
  async assertWithinQuota(
    tenantId: string,
    kind: QuotaKind,
    client: PrismaTransaction,
    delta = 1,
  ): Promise<void> {
    const limit = await this.limitOf(tenantId, kind, client);
    if (limit === null) {
      return;
    }

    // ⚠️ **顺序必须是「先锁、后数」**：READ COMMITTED 下每条语句取新快照，
    //    等锁期间前一个事务已经提交，锁到手之后的 `count` 才看得到它写进去的行。
    //    反过来（先数、后锁）等于没锁。
    await this.lockQuota(tenantId, client);

    const current = await this.countUsage(tenantId, kind, client);
    if (current + delta > limit) {
      throw new ConflictException(
        `当前套餐最多 ${limit} 个${QUOTA_LABEL[kind]}，请升级套餐`,
      );
    }
  }

  /**
   * 当前套餐给这个种类的上限。没有套餐、或上限为 null，都返回 null（= 不限制）。
   */
  private async limitOf(
    tenantId: string,
    kind: QuotaKind,
    client: PrismaTransaction | TenantPrismaService,
  ): Promise<number | null> {
    const plan = await this.currentPlan(tenantId, client);
    if (!plan) {
      return null;
    }
    const limit =
      kind === 'PRODUCT'
        ? plan.maxProducts
        : kind === 'SKU'
          ? plan.maxSkus
          : plan.maxStores;
    return limit === null || limit === undefined ? null : limit;
  }

  /**
   * 锁住本租户的订阅行，把同租户的额度检查串行化。
   *
   * ⚠️ **为什么锁订阅行，而不是 `tenants` 里的租户行**：租户行会被
   *    「插入任何带 tenantId 的表」时的外键校验隐式加上 `FOR KEY SHARE` 锁，
   *    而它与 `FOR UPDATE` 冲突。规格替换是「先持租户行锁、再写 SKU」，
   *    下单是「先锁 SKU、再插订单（要租户行的 KEY SHARE）」——
   *    两条路径方向相反，正好凑成一个死锁环。订阅行没有任何外键引用它，
   *    只被本处与「改订阅」碰，不存在这条环。
   *
   * ⚠️ **`subscriptions` 是租户作用域模型，而原生 SQL 绕过租户扩展** ——
   *    `"tenantId" = ${tenantId}` 必须手写，否则锁的是全平台的订阅行。
   *    表名按 `@@map` 是 `subscriptions`；列名没有 `@map`，驼峰必须加双引号
   *    （不加会被折叠成小写，报「列不存在」）。
   *
   * ⚠️ **走原生 SQL 是因为 Prisma 表达不了 `FOR UPDATE`**，
   *    与 `inventory.service.ts` 的 `lockSkus` 同款写法。
   */
  private async lockQuota(
    tenantId: string,
    client: PrismaTransaction,
  ): Promise<void> {
    await client.$queryRaw`SELECT id FROM subscriptions WHERE "tenantId" = ${tenantId} FOR UPDATE`;
  }

  /**
   * 计数。
   *
   * ⚠️ **用租户作用域的 `count()`** —— 扩展自动附加 tenantId 条件，
   * 软删过滤也自动生效（已软删的商品不占额度）。
   *
   * ⚠️ **SKU 只数 ACTIVE 的**（审计 P2-9b）：规格矩阵替换会把多余的 SKU
   * 置 `INACTIVE` 而不是软删（理由见 `spec-matrix.service.ts` 步骤 6），
   * 这些行仍然活在库里。若把它们算进额度，商家每改一次规格就白吃一批额度，
   * 改几次之后一个 SKU 都加不了 —— 这是用户可见的功能性阻塞。
   * 置 INACTIVE 的 SKU 既不参与最低价计算、也不算可售，本来就不该占额度。
   */
  private async countUsage(
    tenantId: string,
    kind: QuotaKind,
    client: PrismaTransaction | TenantPrismaService,
  ): Promise<number> {
    if (kind === 'PRODUCT') {
      return client.product.count({ where: { tenantId } });
    }
    if (kind === 'SKU') {
      return client.sku.count({ where: { tenantId, status: 'ACTIVE' } });
    }
    return client.store.count({ where: { tenantId } });
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
