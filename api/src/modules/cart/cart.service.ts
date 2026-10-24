import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Cart, CartItem, ProductStatus, SkuStatus } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { MAX_CART_QUANTITY } from './dto/add-cart-item.dto';

/** 游客购物车 cookie 的名字 */
export const CART_COOKIE = 'cart_token';

/**
 * 购物车条目（含展示用的 SKU 信息）。
 *
 * ⚠️ 购物车**不是订单**，不需要快照——下单时的快照写在 order_items 里。
 * 这里带的只是**展示**信息：商品名与单价，供购物车页显示、算合计金额。
 *
 * 金额一律整数分（阶段 0.4 的全局约定）。
 */
export interface CartItemWithSku extends CartItem {
  sku: {
    id: string;
    /** 单价，整数分 */
    price: number;
    product: {
      id: string;
      name: string;
    };
  };
}

/** 游客购物车 cookie 的有效期：30 天 */
const CART_COOKIE_MAX_AGE = 30 * 24 * 3600;

/** 购物车里同一 SKU 的数量上限 */
export { MAX_CART_QUANTITY };

/**
 * 单次合并最多处理多少条游客条目。
 *
 * ⚠️ 设计 §4.2：「一个游客车可能有几百个条目（每条都带 skuId），
 * 合并时要限制单次处理的条目数，避免恶意构造超大 cookie + 大购物车拖垮服务。」
 * 超出的部分直接丢弃，不报错——合并是个尽力而为的动作。
 */
const MAX_MERGE_ITEMS = 200;

/**
 * 购物车服务。
 *
 * ⚠️ **跨店会员不支持**（设计 §十三 遗留项 1）：
 * 消费者在店铺 A 注册后，他在店铺 B 带 token 的请求拿到的仍是 **A 的租户上下文**
 * （租户上下文的来源是「JWT 优先，匿名才看子域名」）。于是 B 店的 SKU 不属于 A，
 * B 店的购物车也访问不到。**这不是 bug，是本阶段明确的能力边界**——
 * 要让登录用户在当前店铺的上下文以子域名为准，得改 TenantContextInterceptor
 * 的优先级，那会波及阶段 1、2 的所有接口，远超本阶段范围。
 */
@Injectable()
export class CartService {
  constructor(private readonly prisma: TenantPrismaService) {}

  /**
   * 取当前请求的购物车（游客或登录），没有就建一个。
   *
   * 购物车**按店铺分**（订单属于一个店铺），所以定位条件是
   * (tenantId, guestToken) 或 (tenantId, customerId)。
   *
   * ⚠️ 并发建购物车可能撞部分唯一索引（设计 §十三 遗留项 9）：
   * 两个并发请求都为同一消费者建购物车，第二个会拿到 P2002。
   * 这里的处理是**捕获 P2002 后重查复用**，而不是把 500 抛给用户——
   * 「购物车已存在」是正常状态，不是错误。
   */
  async currentCart(
    tenantId: string,
    customerId: string | null,
    guestToken: string | null,
  ): Promise<Cart> {
    const existing = await this.findCart(tenantId, customerId, guestToken);
    if (existing) {
      return existing;
    }

    try {
      return await this.prisma.cart.create({
        data: {
          tenantId,
          ...(customerId ? { customerId } : { guestToken }),
        },
      });
    } catch (error) {
      if (!this.isUniqueViolation(error)) {
        throw error;
      }
      // 并发下另一个请求已经把车建好了 → 复用它
      const raced = await this.findCart(tenantId, customerId, guestToken);
      if (!raced) {
        throw error;
      }
      return raced;
    }
  }

  /**
   * 按 (租户, 游客 token / 消费者) 找购物车。
   *
   * 用 findFirst 而不是 findUnique：后者在租户作用域模型上被扩展直接拒绝
   * （唯一字段无法附加 tenantId 条件，会造成跨租户越权）。
   */
  private async findCart(
    tenantId: string,
    customerId: string | null,
    guestToken: string | null,
  ): Promise<Cart | null> {
    if (customerId) {
      return this.prisma.cart.findFirst({
        where: { tenantId, customerId },
      });
    }
    if (guestToken) {
      return this.prisma.cart.findFirst({
        where: { tenantId, guestToken },
      });
    }
    // 两者都没有 → 没有任何可定位购物车的依据
    return null;
  }

  /**
   * 合并游客购物车到账号购物车。
   *
   * 三条要点（对应护栏 1 / 2 / 3）：
   * 1. **数量取 max 而不是累加**（护栏 1）：游客数和账号数很可能本来就是
   *    同一批意图，累加会翻倍超卖。
   * 2. **搬进来的每一条都重新校验**（护栏 2）：游客车里的陈旧内容
   *    （已下架、已软删、已停用的 SKU）不该带进正式订单。
   *    不合格的**直接丢弃**，不报错——合并是个尽力而为的动作，
   *    游客车的陈旧内容不该让登录失败。
   * 3. **幂等**（护栏 3）：游客车不存在时直接返回账号车，不报错。
   *    前端在登录后会调一次这个接口，网络重试或用户手快点两次都很常见。
   */
  async merge(
    tenantId: string,
    customerId: string,
    guestToken: string | null,
  ): Promise<Cart> {
    const accountCart = await this.currentCart(tenantId, customerId, null);

    // 护栏 3：游客车不存在 → 账号车就是最终结果（幂等）
    const guestCart = guestToken
      ? await this.findCart(tenantId, null, guestToken)
      : null;

    // ⚠️ 这里必须**直接返回**，不做任何清理。
    //
    // 合并是幂等操作：重复调用（网络重试、用户手快点两次）的结果
    // 必须与第一次相同。若在这里清理账号车里的陈旧条目，
    // 「重试一次合并」就变成了破坏性操作——它会物理删除用户正常加购、
    // 只是恰好被商家下架了的商品（CartItem 不走软删，删了就没了）。
    if (!guestCart) {
      return accountCart;
    }

    const [guestItems, accountItems] = await Promise.all([
      this.prisma.cartItem.findMany({ where: { cartId: guestCart.id } }),
      this.prisma.cartItem.findMany({ where: { cartId: accountCart.id } }),
    ]);

    const accountQuantityBySku = new Map<string, number>();
    for (const item of accountItems) {
      accountQuantityBySku.set(item.skuId, item.quantity);
    }

    // ⚠️ 单次合并处理的条目数有上限（设计 §4.2）：一个游客车可能有几百条，
    // 不限条数的话恶意构造的大购物车会拖垮服务。超出的直接丢弃，不报错。
    const itemsToMerge = guestItems.slice(0, MAX_MERGE_ITEMS);

    // 一次性把涉及的 SKU 全查出来，不要逐条查——逐条查是 N+1，
    // 几百条就是几百次数据库往返。
    const sellableSkuIds = await this.findSellableSkuIds(
      itemsToMerge.map((item) => item.skuId),
    );

    for (const guestItem of itemsToMerge) {
      // 护栏 2：搬进来的每一条都重新校验，不合格的直接丢弃（不报错）
      if (!sellableSkuIds.has(guestItem.skuId)) {
        continue;
      }

      // 游客这一条**自己**的数量也要在上限内。
      //
      // ⚠️ 当前不可达——游客条目只能由 addItem 产生，那里已经限了上限。
      // 但不可达不等于可以不写：将来若加了「导入购物车」「后台加购」
      // 之类的入口，这条就是唯一的防线。
      if (guestItem.quantity < 1 || guestItem.quantity > MAX_CART_QUANTITY) {
        continue;
      }

      // 护栏 1：两边都有 → 取 max
      const accountQuantity = accountQuantityBySku.get(guestItem.skuId);
      const mergedQuantity = accountQuantity
        ? Math.max(accountQuantity, guestItem.quantity)
        : guestItem.quantity;

      // 合并后的总数量也不能超上限
      if (mergedQuantity > MAX_CART_QUANTITY) {
        continue;
      }

      if (accountQuantity === undefined) {
        // 只有游客车里有 → 搬过来
        await this.prisma.cartItem.create({
          data: {
            tenantId,
            cartId: accountCart.id,
            skuId: guestItem.skuId,
            quantity: mergedQuantity,
          },
        });
      } else if (mergedQuantity !== accountQuantity) {
        // 两边都有且游客那边更多 → 调成 max
        await this.prisma.cartItem.updateMany({
          where: { cartId: accountCart.id, skuId: guestItem.skuId },
          data: { quantity: mergedQuantity },
        });
      }
    }

    // 账号车里**原本就有**、但现在已经不可售的条目，在这次**真的发生了合并**时
    // 一并清掉——合并的产出是「一个干净的账号购物车」。
    //
    // ⚠️ 只在合并发生时做。幂等重试（上面已 return）不动账号车。
    await this.removeUnsellableItems(accountCart);

    // 游客车整体删掉：条目已合并过去，留着会让「游客车还在」与实际状态不符，
    // 也会让下一次合并重复处理。CartItem 是 cascade 删的。
    await this.prisma.cart.deleteMany({ where: { id: guestCart.id } });

    return accountCart;
  }

  /** 清掉购物车里已经不可售的条目 */
  private async removeUnsellableItems(cart: Cart): Promise<void> {
    const items = await this.prisma.cartItem.findMany({
      where: { cartId: cart.id },
    });
    if (items.length === 0) {
      return;
    }

    const sellableSkuIds = await this.findSellableSkuIds(
      items.map((item) => item.skuId),
    );
    const unsellableItemIds = items
      .filter((item) => !sellableSkuIds.has(item.skuId))
      .map((item) => item.id);
    if (unsellableItemIds.length === 0) {
      return;
    }

    // where 里带上 cartId：条目必须属于这个购物车
    await this.prisma.cartItem.deleteMany({
      where: { id: { in: unsellableItemIds }, cartId: cart.id },
    });
  }

  /**
   * 哪些 SKU 现在还能卖。
   *
   * 校验项（护栏 2）：
   * - SKU 存在、属于当前租户（扩展自动附加 tenantId 条件）
   * - SKU 未被软删（Sku 是软删模型，扩展的软删过滤只作用于顶层，
   *   这里查的是顶层，所以自动带上 deletedAt: null）
   * - SKU 状态 ACTIVE
   * - 所属商品已上架（Product.status === 'PUBLISHED'）
   *
   * 一次查完返回 id 集合，调用方在内存里判断——
   * 逐条查是 N+1，条目一多就是几百次往返。
   */
  private async findSellableSkuIds(skuIds: string[]): Promise<Set<string>> {
    const unique = [...new Set(skuIds)];
    if (unique.length === 0) {
      return new Set();
    }

    const skus = await this.prisma.sku.findMany({
      where: {
        id: { in: unique },
        status: SkuStatus.ACTIVE,
        // to-one 关系用关系条件过滤：商品的软删状态也要排除
        product: { status: ProductStatus.PUBLISHED, deletedAt: null },
      },
      select: { id: true },
    });
    return new Set(skus.map((sku) => sku.id));
  }

  /**
   * 加购。
   *
   * 校验（设计 §4.3）：
   * - SKU 存在、属于当前租户、状态 ACTIVE、未软删
   * - 商品已上架
   * - 数量 > 0 且不超上限（DTO 的 class-validator 已经拦了，这里再拦一次
   *   是因为合并等内部路径也会走到加购逻辑）
   */
  async addItem(cart: Cart, skuId: string, quantity: number): Promise<void> {
    if (quantity < 1 || quantity > MAX_CART_QUANTITY) {
      throw new BadRequestException(
        `加购数量必须在 1 到 ${MAX_CART_QUANTITY} 之间`,
      );
    }

    const sku = await this.prisma.sku.findFirst({
      where: {
        id: skuId,
        status: SkuStatus.ACTIVE,
        product: { status: ProductStatus.PUBLISHED, deletedAt: null },
      },
    });
    if (!sku) {
      throw new BadRequestException('商品不可售或不存在');
    }

    // 同一个 SKU 已经在车里 → 累加数量（但不超过上限）
    const existing = await this.prisma.cartItem.findFirst({
      where: { cartId: cart.id, skuId },
    });
    if (existing) {
      const next = existing.quantity + quantity;
      if (next > MAX_CART_QUANTITY) {
        throw new BadRequestException(
          `同一商品的加购总量不能超过 ${MAX_CART_QUANTITY}`,
        );
      }
      await this.prisma.cartItem.updateMany({
        where: { id: existing.id },
        data: { quantity: next },
      });
      return;
    }

    await this.prisma.cartItem.create({
      data: { tenantId: cart.tenantId, cartId: cart.id, skuId, quantity },
    });
  }

  /** 改购物车条目的数量 */
  async updateItemQuantity(
    cart: Cart,
    itemId: string,
    quantity: number,
  ): Promise<void> {
    if (quantity < 1 || quantity > MAX_CART_QUANTITY) {
      throw new BadRequestException(
        `数量必须在 1 到 ${MAX_CART_QUANTITY} 之间`,
      );
    }

    // where 里带上 cartId：条目必须属于当前这个购物车，
    // 否则换个 itemId 就能改别人的车（跨游客车 / 跨账号车）。
    const updated = await this.prisma.cartItem.updateMany({
      where: { id: itemId, cartId: cart.id },
      data: { quantity },
    });
    if (updated.count === 0) {
      throw new NotFoundException('购物车条目不存在');
    }
  }

  /** 删除购物车条目 */
  async removeItem(cart: Cart, itemId: string): Promise<void> {
    const deleted = await this.prisma.cartItem.deleteMany({
      where: { id: itemId, cartId: cart.id },
    });
    if (deleted.count === 0) {
      throw new NotFoundException('购物车条目不存在');
    }
  }

  /** 清空购物车 */
  async clear(cart: Cart): Promise<void> {
    await this.prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
  }

  /**
   * 读购物车（连同条目）。
   *
   * ⚠️ 关联读取必须显式写 where：扩展的软删过滤只作用于顶层，
   * 嵌套关联不会被自动过滤。这里显式带上商品与 SKU 的软删与上架条件，
   * 让「已下架的商品」不出现在购物车展示里。
   *
   * 条目里带上 SKU 的单价与商品名：购物车页要显示它们，也要算合计金额。
   * 购物车**不是订单**，不需要快照（快照在下单时写进 order_items），
   * 但**展示**需要商品名与价格。
   */
  async read(cart: Cart): Promise<Cart & { items: CartItemWithSku[] }> {
    const items = await this.prisma.cartItem.findMany({
      where: {
        cartId: cart.id,
        sku: {
          status: SkuStatus.ACTIVE,
          deletedAt: null,
          product: { status: ProductStatus.PUBLISHED, deletedAt: null },
        },
      },
      orderBy: { createdAt: 'asc' },
      // ⚠️ include 与 where 的配合：where.sku 已经把「不可售 / 已软删 /
      // 商品未上架」的条目挡在外面了，这里的 include 只是把**同一条**
      // SKU 的展示字段带出来，不重复过滤（过滤条件写两遍必然漂移）。
      include: {
        sku: {
          select: {
            id: true,
            price: true,
            product: { select: { id: true, name: true } },
          },
        },
      },
    });
    return { ...cart, items };
  }

  /** 生成游客 token：32 字节随机，足够不可枚举 */
  newGuestToken(): string {
    return randomBytes(32).toString('base64url');
  }

  /** cookie 的写入参数集中在这里，避免各处漂移 */
  cookieOptions() {
    return {
      httpOnly: true,
      // ⚠️ SameSite=Lax 的含义：跨站的 POST 不带 cookie（写操作安全），
      // 但顶级导航的 GET 会带。我们的写操作全是 POST ✓
      sameSite: 'lax' as const,
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: CART_COOKIE_MAX_AGE,
    };
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
