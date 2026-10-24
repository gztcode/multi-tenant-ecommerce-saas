import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  Order,
  OrderItem,
  OrderStatus,
  Prisma,
  ProductStatus,
  SkuStatus,
} from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { getTenantContext } from '../../common/tenant/tenant-context';
import { clampPagination } from '../../common/http/pagination';
import type { PrismaTransaction } from '../../common/prisma/prisma-transaction';
import { PAYMENT_TIMEOUT_QUEUE } from '../../common/queue/queue.constants';
import { QueueService } from '../queue/queue.service';
import { OrderInventoryService } from './inventory.service';
import { canTransition } from './order-status';
import {
  MAX_ORDER_LINES,
  MAX_ORDER_QUANTITY,
  PlaceOrderDto,
} from './dto/place-order.dto';

/**
 * 支付超时窗口：15 分钟（设计 §九）。
 */
const PAYMENT_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * 订单号撞号时最多重试几次（每次重开一个事务）。
 *
 * ⚠️ 重试**必须**在事务外：唯一约束冲突让 PostgreSQL 事务进入 aborted
 * 状态，在同一个事务里重试必然失败。碰撞概率是 36^10 的量级（约 3.6e15），
 * 正常情况下一次就够；给三次是为了「生成器有 bug」时也不至于把 500 抛给用户。
 */
const ORDER_NO_MAX_ATTEMPTS = 3;

/**
 * 订单服务（阶段 3 Task 4）。
 *
 * 负责下单、订单状态流转、订单查询。
 *
 * ## 模块依赖方向：`payment` → `order`（单向）
 *
 * 刻意**不**在 order 模块里 import payment 模块：
 * - payment 的 webhook 消费端要把订单转 `PAID` → 需要 order
 * - payment 的退款端点要转 `REFUNDED` → 需要 order
 * - order 不需要 payment：下单只锁 SKU、只算金额，
 *   发起支付是「建支付单 + 调 createPayment」，那件事放在 payment 模块
 *
 * 反过来（order import payment）会造成循环依赖：
 * 退款端点若放 order，order 要 import payment，而 payment 又要 import order
 * （流转订单）→ **循环依赖**。所以退款端点归 payment 模块，
 * order 只提供状态流转能力。
 */
@Injectable()
export class OrderService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly inventory: OrderInventoryService,
    private readonly queue: QueueService,
  ) {}

  /**
   * 当前租户 ID。
   *
   * 租户**从上下文读**，不当参数传——与 `OrderInventoryService` /
   * `AddressService` 的既有写法一致。
   */
  private currentTenantId(): string {
    const context = getTenantContext();
    if (!context.tenantId) {
      throw new ForbiddenException('无法确定店铺');
    }
    return context.tenantId;
  }

  // ============================================================
  // 下单
  // ============================================================

  /**
   * 下单。
   *
   * ## 幂等键的三段式处理（计划 §4.4b 第 1 条）
   *
   * 两个并发请求带**同一个** `idempotencyKey`：都会查到「不存在」，
   * 然后都去插入 → 一个撞 `orders_tenant_idempotency_uniq` 的 P2002。
   *
   * 正确做法：
   * 1. **事务外**先查一次（快路径，命中直接返回已有订单，不重新扣库存）
   * 2. 未命中 → 进事务创建
   * 3. 事务里撞 P2002 → 事务回滚 → **在事务外**重查并返回那笔已有订单
   *
   * ⚠️ 「在同一个事务里 catch P2002 然后查」是错的：PostgreSQL 里唯一约束
   * 冲突会让整个事务变成 aborted，后续查询全部报
   * `current transaction is aborted`。P2002 必须在**事务外**处理。
   */
  async placeOrder(
    customerId: string | null,
    dto: PlaceOrderDto,
    guestToken: string | null = null,
  ): Promise<Order & { items: OrderItem[] }> {
    const tenantId = this.currentTenantId();
    // ⚠️ 下单也必须登录（本阶段不支持游客订单，设计 §十三 遗留项 8）
    const owner = this.requireCustomerId(customerId);

    if (dto.items.length > MAX_ORDER_LINES) {
      throw new BadRequestException(`订单条目不能超过 ${MAX_ORDER_LINES} 行`);
    }
    for (const item of dto.items) {
      if (item.quantity < 1 || item.quantity > MAX_ORDER_QUANTITY) {
        throw new BadRequestException(
          `购买数量必须在 1 到 ${MAX_ORDER_QUANTITY} 之间`,
        );
      }
    }

    // ---- 1. 幂等键快路径（事务外）----
    if (dto.idempotencyKey) {
      const existing = await this.findByIdempotencyKey(
        tenantId,
        dto.idempotencyKey,
      );
      if (existing) {
        return this.readOrder(existing.id);
      }
    }

    // ---- 2. 地址快照（事务外读，只读不写）----
    // ⚠️ 地址必须属于当前租户**且**属于当前消费者。
    // Address 刻意不声明 tenant 关系（外键不带 tenantId，数据库挡不住跨租户挂载），
    // 这里显式校验归属（设计 §3.3 / 护栏 20）。
    const address = await this.resolveAddress(tenantId, owner, dto.addressId);

    // ---- 3. 事务：锁 SKU → 校验 → 建单 → 扣库存 → 清购物车 ----
    //
    // ⚠️ **整个事务包在循环里**：订单号唯一冲突（P2002）时，
    // 事务必须**整体回滚**、换个订单号**重开**一个事务——
    // P2002 让 PostgreSQL 事务进入 aborted 状态，在同一个事务里重试
    // 必然失败（报 `current transaction is aborted`）。
    let orderId: string | null = null;
    for (let attempt = 0; attempt < ORDER_NO_MAX_ATTEMPTS; attempt++) {
      try {
        orderId = await this.prisma.$transaction(
          async (tx) => {
            const created = await this.createOrderInTx(
              tx,
              tenantId,
              owner,
              dto,
              address,
            );
            await this.clearCartItemsInTx(
              tx,
              tenantId,
              owner,
              guestToken,
              dto.items,
            );
            return created.id;
          },
          // ⚠️ 事务超时设成 10 秒（Prisma 默认只有 5 秒）：行锁等待会占掉这个预算。
          { maxWait: 10_000, timeout: 10_000 },
        );
        break;
      } catch (error) {
        // ---- 3b. 订单号撞了 → 整个事务已回滚，换个号重开事务 ----
        //
        // ⚠️ 必须先判它：订单号冲突也是 P2002，与幂等键冲突同一种错误码。
        if (this.isOrderNoViolation(error)) {
          continue;
        }

        // ---- 3c. 幂等键并发：撞唯一索引 → 事务外重查 ----
        //
        // ⚠️ 必须在事务**外**处理：P2002 让 PostgreSQL 事务进入 aborted 状态，
        // 在同一个事务里 catch 之后继续查会报
        // `current transaction is aborted`。
        if (dto.idempotencyKey && this.isUniqueViolation(error)) {
          const raced = await this.findByIdempotencyKey(
            tenantId,
            dto.idempotencyKey,
          );
          if (raced) {
            return this.readOrder(raced.id);
          }
        }
        throw error;
      }
    }
    if (orderId === null) {
      // 连续几次都撞号：订单号生成器有问题，但不该把 500 抛给用户
      throw new ConflictException('订单号生成失败，请重试');
    }

    // ---- 4. 投超时释放的 delayed job（**事务提交之后**）----
    //
    // ⚠️ 必须等事务提交后才投：任务一入队就可能被消费，
    // 而消费端要按 orderId 查订单——事务还没提交时查不到。
    // 「任务跑早了，订单还不存在」会让释放静默失败。
    //
    // jobId = `timeout-${orderId}`：同一个订单只会有一个超时任务，
    // 不会因为重试下单而排多个（设计 §九）。
    //
    // ⚠️ **分隔符用 `-` 而不是 `:`**：设计 §九 写的是 `timeout:${orderId}`，
    // 但 BullMQ v6 的 jobId 校验会拒绝含 `:` 的自定义 id
    // （`Custom Id cannot contain :`——只有恰好三段的形式被放行，
    // 那是 repeatable job 专用的）。照抄设计文档会直接抛错。
    // 订单 id 是 uuid，含 `-` 不含 `:`，拼出来的 jobId 合法。
    //
    // ⚠️ **任务里必须带 `tenantId`**：队列消费是跨进程边界的，
    // 消费端要靠它重建租户上下文（AsyncLocalStorage 的上下文不跟着走），
    // 不带就查不到订单、也碰不到库存。
    // 这里的 tenantId 来自**已认证的请求上下文**（可信源），
    // 绝不能取自客户端提交的内容——否则「重建上下文」本身就成了越权通道。
    await this.queue.addDelayed(
      PAYMENT_TIMEOUT_QUEUE,
      'release',
      { tenantId, orderId },
      PAYMENT_TIMEOUT_MS,
      `timeout-${orderId}`,
    );

    return this.readOrder(orderId);
  }

  /**
   * 在事务内建订单 + 订单项 + 预占库存。
   *
   * ⚠️ **扣库存与建单必须同生共死**：库存预占了但订单没建（或反过来）
   * 就是「有库存没订单」或「有订单没库存」，两种都要出事故。
   */
  private async createOrderInTx(
    tx: PrismaTransaction,
    tenantId: string,
    customerId: string | null,
    dto: PlaceOrderDto,
    address: {
      receiver: string;
      phone: string;
      province: string;
      city: string;
      district: string;
      detail: string;
    },
  ): Promise<Order> {
    // 合并同 skuId 的条目：同一个 SKU 买两行应该合并成一行，
    // 否则锁 SKU 时会对同一个 id 执行两次 FOR UPDATE（见 inventory.service.ts）。
    const merged = mergeItems(dto.items);

    // ---- 4a. 锁 SKU ----
    //
    // ⚠️ **锁必须先于「读价格」**（设计 §5.1 的顺序：锁 → 校验 → 建单）。
    // 不先锁就读价格的话，商家此刻改价并提交，
    // 我们记下来的单价就是**改价前**的旧值——
    // 订单里的金额与实际付款金额对不上。
    //
    // 锁本身顺带做了「存在性 + 租户归属」的过滤：
    // 锁不到的行（不存在 / 别的租户）不在返回结果里。
    await this.inventory.lockSkusInTx(
      tx,
      merged.map((item) => item.skuId),
    );

    // ---- 4b. 读单价与快照（此时行锁在握，读到的是最新值）----
    //
    // ⚠️ **单价只从 SKU 读**（护栏 8）：请求体里的价格字段
    // 被 `forbidNonWhitelisted` 拒掉，服务里也只认 SKU 的 price。
    const skuDetails = await this.readSkuDetails(
      tx,
      merged.map((item) => item.skuId),
    );

    // ---- 4c. 建订单 ----
    //
    // ⚠️ **订单号唯一冲突的重试在事务外做**（见 placeOrder 的循环）：
    // P2002 让 PostgreSQL 事务进入 aborted 状态，事务内重试必然失败。
    // 订单号是「日期 + 10 位随机」，全小写字母数字，**不含租户信息**
    // ——它会出现在支付回调、商家后台搜索框、日志里。
    const order = await this.createOrderAndItems(tx, {
      tenantId,
      customerId,
      address,
      remark: dto.remark,
      idempotencyKey: dto.idempotencyKey,
      merged,
      skuDetails,
    });

    // ---- 4d. 扣库存 + 记 RESERVE 流水 ----
    //
    // 校验、扣库存、记流水都在 `reserveInTx` 里（Task 3 写的）：
    // 行锁、排序加锁、stockVersion 条件、以及「未冲抵预占量」的校验都在那边。
    // 它内部会再锁一次——同一事务重复 `FOR UPDATE` 是安全的。
    await this.inventory.reserveInTx(
      tx,
      order.id,
      merged.map((item) => ({ skuId: item.skuId, quantity: item.quantity })),
    );

    return order;
  }

  /**
   * 建订单（含订单项）。
   *
   * ⚠️ **这里不做任何重试**。订单号唯一冲突（P2002）时**不能**在这个事务里
   * 重试——唯一约束冲突会让 PostgreSQL 事务进入 aborted 状态，
   * 紧接着的插入必然失败（报 `current transaction is aborted`）。
   *
   * 重试由调用方（`placeOrder`）在**事务外**重新开一个事务来做：
   * 事务回滚 → 换个订单号 → 重开事务。
   */
  private async createOrderAndItems(
    tx: PrismaTransaction,
    input: {
      tenantId: string;
      customerId: string | null;
      address: {
        receiver: string;
        phone: string;
        province: string;
        city: string;
        district: string;
        detail: string;
      };
      remark?: string;
      idempotencyKey?: string;
      merged: Array<{ skuId: string; quantity: number }>;
      skuDetails: Map<string, SkuDetail>;
    },
  ): Promise<Order> {
    const { merged, skuDetails, ...rest } = input;

    const totalAmount = merged.reduce((sum, item) => {
      const detail = skuDetails.get(item.skuId);
      // 读不到详情说明 SKU 不存在或跨租户 —— 前面已经查过并抛错了，
      // 这里必然拿得到。⚠️ 用显式抛错而不是 `?? 0`：静默按 0 计价
      // 会让订单金额变成 0，比报错难查得多。
      if (!detail) {
        throw new NotFoundException('SKU 不存在或不可售');
      }
      return sum + detail.price * item.quantity;
    }, 0);
    const itemCount = merged.reduce((sum, item) => sum + item.quantity, 0);

    const order = await tx.order.create({
      data: {
        tenantId: rest.tenantId,
        orderNo: generateOrderNo(),
        customerId: rest.customerId,
        status: OrderStatus.PENDING_PAYMENT,
        totalAmount,
        itemCount,
        // ⚠️ **支付期限与队列的延迟窗口一致**（15 分钟，设计 §九）。
        //
        // 队列的 delayed job **不保证准时**，所以超时释放不能只看队列的调度，
        // 订单自己也得记住期限——两处都要判。
        payExpiresAt: new Date(Date.now() + PAYMENT_TIMEOUT_MS),
        receiverName: rest.address.receiver,
        receiverPhone: rest.address.phone,
        province: rest.address.province,
        city: rest.address.city,
        district: rest.address.district,
        detail: rest.address.detail,
        remark: rest.remark ?? null,
        idempotencyKey: rest.idempotencyKey ?? null,
      },
    });

    // 建订单项：快照商品名与规格
    await tx.orderItem.createMany({
      data: merged.map((item) => {
        const detail = skuDetails.get(item.skuId);
        if (!detail) {
          throw new NotFoundException('SKU 不存在或不可售');
        }
        return {
          tenantId: rest.tenantId,
          orderId: order.id,
          skuId: item.skuId,
          productId: detail.productId,
          productName: detail.productName,
          skuSnapshot: detail.skuSnapshot,
          quantity: item.quantity,
          unitPrice: detail.price,
          subtotal: detail.price * item.quantity,
        };
      }),
    });

    return order;
  }

  /**
   * 读 SKU 的下单所需信息：单价 + 商品名 + 规格快照。
   *
   * ⚠️ **关联读取必须显式写 where**：扩展的软删过滤只作用于顶层，
   * 嵌套关联不会被自动过滤。这里显式带上商品、规格、规格值的软删条件，
   // 让「已软删的商品」不能被下单。
   *
   * ⚠️ **价格只从 SKU 读**，绝不从请求体读（护栏 8）。
   */
  private async readSkuDetails(
    tx: PrismaTransaction,
    skuIds: string[],
  ): Promise<Map<string, SkuDetail>> {
    if (skuIds.length === 0) {
      return new Map();
    }

    const skus = await tx.sku.findMany({
      where: {
        id: { in: skuIds },
        status: SkuStatus.ACTIVE,
        deletedAt: null,
        // to-one 关系用关系条件：商品必须上架且未软删
        product: { status: ProductStatus.PUBLISHED, deletedAt: null },
      },
      select: {
        id: true,
        price: true,
        productId: true,
        product: { select: { name: true } },
        specValues: {
          where: {
            // ⚠️ 显式过滤软删：扩展的软删过滤只作用于顶层，
            // 这里的 include 不会被自动过滤
            value: { deletedAt: null, spec: { deletedAt: null } },
          },
          // ⚠️ **显式排序**：快照是写进订单的 JSON，不排序的话
          // 同一笔订单每次存下来的规格顺序可能不同（PostgreSQL 不保证
          // 无 ORDER BY 的行序），对账时看着像两次不同的快照。
          // 按规格的 sort 排，同一个 sort 内按规格值的 sort 排。
          orderBy: { value: { spec: { sort: 'asc' } } },
          select: {
            value: {
              select: {
                value: true,
                spec: { select: { name: true } },
              },
            },
          },
        },
      },
    });

    const byId = new Map<string, SkuDetail>();
    for (const sku of skus) {
      byId.set(sku.id, {
        price: sku.price,
        productId: sku.productId,
        productName: sku.product.name,
        skuSnapshot: {
          specs: sku.specValues.map((sv) => ({
            name: sv.value.spec.name,
            value: sv.value.value,
          })),
        },
      });
    }

    // ⚠️ 查不到的 SKU 一律报错（不存在 / 跨租户 / 不可售 / 商品未上架）。
    // 不区分是哪一种——区分了等于告诉攻击者「这个 id 存在但不属于你」。
    for (const skuId of skuIds) {
      if (!byId.has(skuId)) {
        throw new NotFoundException('SKU 不存在或不可售');
      }
    }

    return byId;
  }

  /**
   * 清掉购物车里已下单的条目。
   *
   * 只清**下单里出现过的 SKU**，其余条目保留——
   * 用户可能一次下单只买一部分。
   */
  private async clearCartItemsInTx(
    tx: PrismaTransaction,
    tenantId: string,
    customerId: string | null,
    guestToken: string | null,
    items: Array<{ skuId: string }>,
  ): Promise<void> {
    const skuIds = [...new Set(items.map((item) => item.skuId))];
    if (skuIds.length === 0) {
      return;
    }

    // 定位当前请求的购物车：登录用户按 customerId，游客按 guestToken
    const cart = customerId
      ? await tx.cart.findFirst({ where: { tenantId, customerId } })
      : guestToken
        ? await tx.cart.findFirst({ where: { tenantId, guestToken } })
        : null;
    if (!cart) {
      // 没有购物车（直接调接口下单，没加过购）——没什么要清的
      return;
    }

    await tx.cartItem.deleteMany({
      where: { cartId: cart.id, skuId: { in: skuIds } },
    });
  }

  /** 按幂等键找订单（租户内） */
  private async findByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<Order | null> {
    return this.prisma.order.findFirst({
      where: { tenantId, idempotencyKey },
    });
  }

  /**
   * 校验地址归属并取快照。
   *
   * ⚠️ 必须同时校验「属于当前租户」与「属于当前消费者」：
   * Address 刻意不声明 tenant 关系（外键不带 tenantId，数据库挡不住跨租户挂载），
   * 只能由 service 层显式校验归属（设计 §3.3 / 护栏 20）。
   */
  private async resolveAddress(
    tenantId: string,
    customerId: string | null,
    addressId: string,
  ): Promise<{
    receiver: string;
    phone: string;
    province: string;
    city: string;
    district: string;
    detail: string;
  }> {
    if (!customerId) {
      // ⚠️ 游客没有地址簿。设计 §十三 遗留项 8 明确了游客下单的已知限制：
      // 游客下完单只能靠下单响应里的订单号继续支付，
      // 消费者侧按 customerId 查订单查不到游客的订单。
      // 本阶段**不实现**「按联系方式查最近订单」——那是另一套流程。
      throw new BadRequestException('下单需要先登录并选择收货地址');
    }

    const address = await this.prisma.address.findFirst({
      where: { id: addressId, tenantId, customerId },
    });
    if (!address) {
      throw new NotFoundException('收货地址不存在');
    }

    return {
      receiver: address.receiver,
      phone: address.phone,
      province: address.province,
      city: address.city,
      district: address.district,
      detail: address.detail,
    };
  }

  // ============================================================
  // 状态流转
  // ============================================================

  /**
   * 条件更新订单状态。
   *
   * ⚠️ **绝不能「先 findFirst 查状态，再 update」**——两个并发事务会都读到
   * 同一个旧状态然后都往下走。必须把状态放进 where 里，靠受影响行数
   * 判定谁赢了。这是阶段 3 最关键的并发正确性（护栏 10）。
   *
   * 具体的失效场景：支付回调与超时释放并发时，两者都读到
   * `PENDING_PAYMENT` 就会都往下走——结果是**已支付但库存被还回去**
   * （超卖）。两处更新用同一个 `status = 'PENDING_PAYMENT'` 条件，
   * 数据库保证只有一方能赢。
   *
   * @param extra 附带要更新的字段（如 `paidAt`、`trackingNo`）
   * @returns 是否生效（false = 期间已被别人改过，本次不生效）
   */
  async transition(
    orderId: string,
    from: OrderStatus,
    to: OrderStatus,
    extra: Record<string, unknown> = {},
  ): Promise<boolean> {
    return this.prisma.$transaction(
      (tx) => this.transitionInTx(tx, orderId, from, to, extra),
      { maxWait: 10_000, timeout: 10_000 },
    );
  }

  /**
   * 在**调用方的事务内**做状态流转。
   *
   * ⚠️ **需要「改状态 + 动库存」在同一事务里时，必须用这个**：
   * - Task 5 的支付回调：条件更新转 `PAID` + 记 `DEDUCT` 流水
   * - Task 6 的超时释放：条件更新转 `CLOSED` + 释放预占
   * - 消费者取消订单：条件更新转 `CANCELLED` + 释放预占
   *
   * 分成两个事务的话，释放失败时订单已经是终态而库存没还回去——
   * 而超时释放任务看到状态不是 `PENDING_PAYMENT` 也不会再管它，
   * 那批库存就**永久卡在预占里**。
   */
  async transitionInTx(
    tx: PrismaTransaction,
    orderId: string,
    from: OrderStatus,
    to: OrderStatus,
    extra: Record<string, unknown> = {},
  ): Promise<boolean> {
    if (!canTransition(from, to)) {
      throw new ConflictException(`订单状态不能从 ${from} 变为 ${to}`);
    }
    const affected = await tx.order.updateMany({
      where: { id: orderId, status: from },
      data: { status: to, ...extra },
    });
    // count === 0 → 期间已被别人改过，本次不生效
    return affected.count === 1;
  }

  /**
   * 消费者取消订单（仅 `PENDING_PAYMENT` 可取消）。
   *
   * ⚠️ **与超时释放走同一个释放函数**（设计 §5.4）：两处各写一套
   * 「释放库存 + 记流水 + 改状态」，迟早会漂移——
   * 比如改了取消却忘了改超时释放，就会出现「取消的订单库存没还回去」。
   *
   * ⚠️ **改状态与释放预占必须在同一个事务里**：
   * 分成两个事务的话，释放失败（预占量对不上、锁超时）时，
   * 订单已经是 `CANCELLED` 但库存没还回去——
   * 而超时释放任务看到状态不是 `PENDING_PAYMENT` 也不会再管它，
   * 那批库存就**永久卡在预占里**，再也回不到可售库存。
   */
  async cancelOrder(orderNo: string, customerId: string | null): Promise<void> {
    const order = await this.findConsumerOrder(orderNo, customerId);

    await this.prisma.$transaction(
      async (tx) => {
        // 条件更新：只有还在 PENDING_PAYMENT 才会成功。
        // ⚠️ 这一步同时挡住了「已支付的订单被取消」与「两个取消并发时释放两次库存」。
        const won = await this.transitionInTx(
          tx,
          order.id,
          OrderStatus.PENDING_PAYMENT,
          OrderStatus.CANCELLED,
          { cancelledAt: new Date() },
        );
        if (!won) {
          throw new ConflictException('订单当前状态不允许取消');
        }

        // 释放预占：库存还回去 + 记 RELEASE 流水
        await this.releaseReservationInTx(tx, order.id);
      },
      { maxWait: 10_000, timeout: 10_000 },
    );
  }

  /**
   * 释放订单的预占（库存还回去 + 记 RELEASE 流水）。
   *
   * ⚠️ **取消订单与支付超时释放共用这个函数**（设计 §5.4）。
   * 两处各写一套逻辑必然漂移——这是「同一件事只有一处实现」的最朴素的应用。
   *
   * ⚠️ **刻意不提供「自己开事务」的版本**：调用方必须在自己的事务里
   * 组合「条件更新状态 + 释放预占」。分成两个事务的话，
   * 订单会先变成终态而库存没还回去——而超时释放任务看到状态不是
   * `PENDING_PAYMENT` 也不会再管它，那批库存就**永久卡在预占里**。
   */

  /**
   * 在**调用方的事务内**释放订单的预占。
   */
  async releaseReservationInTx(
    tx: PrismaTransaction,
    orderId: string,
  ): Promise<void> {
    const items = await tx.orderItem.findMany({
      where: { orderId },
      select: { skuId: true, quantity: true },
    });
    if (items.length === 0) {
      return;
    }
    await this.inventory.releaseInTx(tx, orderId, items);
  }

  /**
   * 商家发货（`PAID` → `SHIPPED`）。
   */
  async shipOrder(orderNo: string, trackingNo: string): Promise<void> {
    const order = await this.findOrderByNo(orderNo);
    const affected = await this.transition(
      order.id,
      OrderStatus.PAID,
      OrderStatus.SHIPPED,
      { shippedAt: new Date(), trackingNo },
    );
    if (!affected) {
      throw new ConflictException('订单当前状态不允许发货');
    }
  }

  /**
   * 消费者确认收货（`SHIPPED` → `COMPLETED`）。
   */
  async confirmReceipt(
    orderNo: string,
    customerId: string | null,
  ): Promise<void> {
    const order = await this.findConsumerOrder(orderNo, customerId);
    const affected = await this.transition(
      order.id,
      OrderStatus.SHIPPED,
      OrderStatus.COMPLETED,
      { completedAt: new Date() },
    );
    if (!affected) {
      throw new ConflictException('订单当前状态不允许确认收货');
    }
  }

  // ============================================================
  // 查询
  // ============================================================

  /**
   * 消费者侧的订单列表。
   *
   * ⚠️ **游客的订单查不到**（设计 §十三 遗留项 8）：`orders.customerId` 为空时，
   * 消费者侧按 `customerId` 查订单**查不到**——游客下完单只能靠下单响应里的
   * 订单号继续支付。**本阶段不实现「按联系方式查最近订单」**，
   * 这是明确的能力边界，不是漏了。
   */
  async listConsumerOrders(
    customerId: string | null,
    params: { status?: OrderStatus; page?: number; pageSize?: number } = {},
  ): Promise<{ items: Order[]; total: number }> {
    if (!customerId) {
      return { items: [], total: 0 };
    }
    // ⚠️ 分页参数要夹上下限：pageSize=999999 能把整个租户的订单拖出去，
    // page=0 会算出负的 skip 让 Prisma 报错（500）。
    const { page, pageSize } = clampPagination(params.page, params.pageSize);
    const where = {
      customerId,
      ...(params.status ? { status: params.status } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.order.count({ where }),
    ]);
    return { items, total };
  }

  /**
   * 商家侧的订单列表（按状态 / 时间筛选）。
   */
  async listMerchantOrders(
    params: {
      status?: OrderStatus;
      from?: Date;
      to?: Date;
      page?: number;
      pageSize?: number;
    } = {},
  ): Promise<{ items: Order[]; total: number }> {
    // ⚠️ 分页参数要夹上下限（见 listConsumerOrders 的说明）
    const { page, pageSize } = clampPagination(params.page, params.pageSize);
    const where = {
      ...(params.status ? { status: params.status } : {}),
      ...(params.from || params.to
        ? {
            createdAt: {
              ...(params.from ? { gte: params.from } : {}),
              ...(params.to ? { lte: params.to } : {}),
            },
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.order.count({ where }),
    ]);
    return { items, total };
  }

  /** 读订单 + 订单项 */
  async readOrder(orderId: string): Promise<Order & { items: OrderItem[] }> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) {
      throw new NotFoundException('订单不存在');
    }
    return order;
  }

  /** 按订单号读订单 + 订单项 */
  async readOrderByNo(
    orderNo: string,
  ): Promise<Order & { items: OrderItem[] }> {
    const order = await this.prisma.order.findFirst({
      where: { orderNo },
      include: { items: true },
    });
    if (!order) {
      throw new NotFoundException('订单不存在');
    }
    return order;
  }

  /**
   * 读消费者的订单（含订单项）。
   *
   * ⚠️ 必须带 `customerId` 条件：不然换个消费者拿订单号就能看别人的订单
   * （订单号会出现在支付回调、商家后台的搜索框里，不是秘密）。
   */
  async readConsumerOrder(
    orderNo: string,
    customerId: string | null,
  ): Promise<Order & { items: OrderItem[] }> {
    const owner = this.requireCustomerId(customerId);
    const order = await this.prisma.order.findFirst({
      where: { orderNo, customerId: owner },
      include: { items: true },
    });
    if (!order) {
      throw new NotFoundException('订单不存在');
    }
    return order;
  }

  /**
   * 定位消费者的订单。
   *
   * ⚠️ 必须带 `customerId` 条件：不然换个消费者拿订单号就能取消别人的订单。
   */
  private async findConsumerOrder(
    orderNo: string,
    customerId: string | null,
  ): Promise<Order> {
    const owner = this.requireCustomerId(customerId);
    const order = await this.prisma.order.findFirst({
      where: { orderNo, customerId: owner },
    });
    if (!order) {
      throw new NotFoundException('订单不存在');
    }
    return order;
  }

  /**
   * 消费者身份校验：订单相关操作**必须登录**。
   *
   * ⚠️ **本阶段不支持游客订单**（设计 §十三 遗留项 8 的取舍之一：
   * 「本阶段就要求游客下单前登录」）。所以 `customerId` 一定非空。
   *
   * ⚠️ **这里必须显式拒绝，不能靠「customerId 为空就不加过滤条件」**：
   * 那种写法会让 `where` 退化成「本租户的任意订单」——匿名请求就能
   * 读到别人的姓名、手机号、详细地址，甚至把别人的订单取消掉。
   * 订单号不是秘密（它出现在支付回调、商家后台搜索框、日志里）。
   *
   * 纵深防御：入口层的守卫是约定，数据层的守门人是这里。
   */
  private requireCustomerId(customerId: string | null): string {
    if (!customerId) {
      throw new UnauthorizedException('订单操作需要登录');
    }
    return customerId;
  }

  /** 按订单号找订单（商家侧 / 内部用） */
  private async findOrderByNo(orderNo: string): Promise<Order> {
    const order = await this.prisma.order.findFirst({ where: { orderNo } });
    if (!order) {
      throw new NotFoundException('订单不存在');
    }
    return order;
  }

  // ============================================================
  // 小工具
  // ============================================================

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

  /**
   * 这次 P2002 是不是**订单号**冲突。
   *
   * 订单号撞了 → 换一号重试；
   * 幂等键撞了 → 语义是「返回已有订单」，不能重试（重试会再建一单）。
   *
   * ⚠️ Prisma 的 P2002 错误对象里 `meta.target` 可能是数组也可能是字符串，
   * 这里逐项判断，不做 `String(target)`——
   * 那会把未知类型悄悄转成 `"[object Object]"`，判断结果不可信。
   */
  private isOrderNoViolation(error: unknown): boolean {
    if (!this.isUniqueViolation(error)) {
      return false;
    }
    const meta = (error as { meta?: { target?: unknown } }).meta;
    const target = meta?.target;
    if (Array.isArray(target)) {
      return target.some(
        (part) => typeof part === 'string' && part.includes('orderNo'),
      );
    }
    return typeof target === 'string' && target.includes('orderNo');
  }
}

/** 下单要用的 SKU 信息 */
interface SkuDetail {
  /** 单价（整数分） */
  price: number;
  productId: string;
  productName: string;
  /** 规格快照：形如 `{ specs: [{ name: '颜色', value: '黑色' }] }` */
  skuSnapshot: Prisma.InputJsonValue;
}

/**
 * 订单号随机部分的字符表：**小写字母 + 数字**。
 *
 * ⚠️ 刻意不用 base64url：它的字母表含 `-` 与 `_`，
 * 而订单号的要求是「全小写字母数字」（设计 §3.4）。
 * `_` 混进去会让订单号在别处（Excel、URL、SQL 标识符）里变得难用。
 */
const ORDER_NO_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * 生成订单号：日期 + 10 位随机，全小写字母数字。
 *
 * ⚠️ **不含租户信息**：订单号会出现在支付回调、商家后台的搜索框、日志里。
 * 带上租户标识等于把「这是哪家店的订单」写进了一个会被外部看到的字段。
 * 租户归属从订单表本身查，不从订单号里解析。
 *
 * 随机部分 10 位（36 进制，约 51 bit）足够：即使每天 10 万单，
 * 碰撞概率也在 1e-7 量级；而且生成后仍会处理唯一冲突（重试一次）。
 */
function generateOrderNo(): string {
  const date = new Date();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');

  // ⚠️ 不用 `randomBytes(...).toString('hex')`：hex 只有 16 个字符，
  // 10 位 hex 只有 40 bit，碰撞概率不够低。
  // 逐字符从 36 进制字母表里取，10 位 = 36^10 ≈ 3.6e15 种组合。
  //
  // ⚠️ **用拒绝采样而不是 `byte % 36`**：256 不是 36 的整数倍，
  // 取模会让前 4 个字母各多一点概率（模偏差）。
  // 拒绝采样把 >= 252 的字节丢掉重取，得到**均匀**分布。
  const length = 10;
  const limit = 256 - (256 % ORDER_NO_ALPHABET.length); // 252
  let random = '';
  while (random.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte >= limit) {
        continue; // 丢掉重取
      }
      random += ORDER_NO_ALPHABET[byte % ORDER_NO_ALPHABET.length];
      if (random.length === length) {
        break;
      }
    }
  }
  return `${y}${m}${d}-${random}`;
}

/**
 * 把条目按 skuId 合并（同 skuId 的数量相加）。
 *
 * ⚠️ **为什么必须合并**：重复的 skuId 会让 `lockSkus` 对同一个 id 执行两次
 * `SELECT ... FOR UPDATE`，拿到的两次是**同一份快照**；
 * 写循环遍历的是条目而不是 Map，第二轮拿旧 stockVersion 去 where →
 * 受影响行数 0 → 抛 409「库存已被他人修改，请重试」。
 *
 * 合并后自然没有重复。合并后的语义是对的：
 * 同 SKU 两条各 1 件 = 要 2 件；若库存只有 1 件 → 409「库存不足」。
 */
function mergeItems(
  items: Array<{ skuId: string; quantity: number }>,
): Array<{ skuId: string; quantity: number }> {
  const totals = new Map<string, number>();
  for (const item of items) {
    totals.set(item.skuId, (totals.get(item.skuId) ?? 0) + item.quantity);
  }
  return [...totals].map(([skuId, quantity]) => ({ skuId, quantity }));
}
