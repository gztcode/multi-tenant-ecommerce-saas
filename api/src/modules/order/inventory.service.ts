import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InventoryMovement, InventoryMovementType } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { getTenantContext } from '../../common/tenant/tenant-context';
import type { PrismaTransaction } from '../../common/prisma/prisma-transaction';

/**
 * 交易链路的库存服务（阶段 3 Task 3）。
 *
 * 负责「预占 / 确认售出 / 释放」三个阶段的库存变动与流水记账。
 *
 * ## 为什么走行锁而不是阶段 2 的乐观锁
 *
 * 阶段 2 的库存调整（管理端手工加减）用 `stockVersion` 乐观锁：
 * 冲突了就返回 409 让商家重试。这对**低频人工操作**是合适的。
 *
 * 但下单是**高频**操作，两个并发下单撞上同一个 SKU 是常态，
 * 乐观锁会大量返回 409。所以下单走 `SELECT ... FOR UPDATE` 行锁——
 * 串行化同一 SKU 的扣减，不需要重试循环。
 *
 * 行锁与 `stockVersion` **两者都要**（设计 §5.1）：
 * - 行锁保证「并发下单之间」不丢更新——这是**主力**；
 * - `stockVersion` 保证「管理端的人工调整」与下单不互相覆盖——
 *   在行锁还在的前提下它是冗余的（详见扣库存那处的注释），
 *   留着是纵深防御。
 *
 * ## 流水的两个语义别混（设计 §5.2）
 *
 * | 字段 | 语义 |
 * |------|------|
 * | `quantity` | **业务量**与方向：预占 5 件记 `-5`，释放记 `+5`，确认售出记 `-5` |
 * | `stockBefore` / `stockAfter` | **实际库存**的数值变化 |
 *
 * | 阶段 | quantity | stock 变化 | 含义 |
 * |------|----------|------------|------|
 * | `RESERVE` | `-qty` | `stock -= qty` | 预占：可售库存减少，货还没卖出去 |
 * | `DEDUCT` | `-qty` | **不变** | 确认售出：预占时已经扣过了，这里只标记成交 |
 * | `RELEASE` | `+qty` | `stock += qty` | 释放：超时未支付或取消，把可售库存还回去 |
 *
 * ⚠️ `DEDUCT` 的 `stock` 不变是这套模型里最容易看错的地方。
 * ⚠️ **销量不要从流水统计**——流水里 `RESERVE` 与 `DEDUCT` 都是负数，会重复计数。
 * 销量看 `order_items.quantity` 求和。
 *
 * ## 流水与订单的关联（`orderId` 字段）
 *
 * 流水与订单之间**必须**有数据层的关联，不能只靠自由文本的 reason。
 * 理由很实在：释放与扣减要能回答「这些条目**确实被预占过**吗」。
 * 只有 reason 时这个问题没法在数据层回答，于是
 * 「对一个从未预占过的 SKU 释放 5 件」会让库存凭空 +5，
 * 而流水与库存的净变化**是自洽的**——对账时看不出问题。
 *
 * 所以 `InventoryMovement.orderId` 记订单的 uuid，
 * 释放与扣减都按它汇总「尚未被冲抵的预占量」并以此为上限校验。
 */
@Injectable()
export class OrderInventoryService {
  constructor(private readonly prisma: TenantPrismaService) {}

  /**
   * 当前租户 ID。
   *
   * 租户**从上下文读**，不当参数传——与 `InventoryService` /
   * `AddressService` 的既有写法一致。
   *
   * ⚠️ 之前把它当参数传，会有**两个来源**：原生 SQL 的 `FOR UPDATE`
   * 按参数找 SKU，随后的 `tx.sku.updateMany` 走扩展、用的是上下文——
   * 两者不一致时租户错配表现为 409「库存已被他人修改，请重试」，
   * 错误信息完全误导（读起来像并发冲突，实际是租户错配）。
   *
   * ⚠️ 在 `$transaction(async (tx) => ...)` 的回调里读上下文是安全的：
   * `AsyncLocalStorage` 沿 Promise 链传播，事务回调仍在同一条链上。
   */
  private currentTenantId(): string {
    const context = getTenantContext();
    if (!context.tenantId) {
      throw new NotFoundException('无法确定店铺');
    }
    return context.tenantId;
  }

  /**
   * 预占库存。
   *
   * 在一个事务里完成「扣库存 + 记 RESERVE 流水」，两者必须同生共死——
   * 只扣不记会让台账与实际对不上。
   *
   * ⚠️ **事务超时设成 10 秒**（Prisma 默认只有 5 秒）：行锁等待会占掉这个预算——
   * 两个订单抢同一个 SKU 时，后一个要等前一个提交。超时了症状看起来像
   * 「行锁实现有 bug」，其实只是预算不够。
   *
   * @param orderId 订单 id（记进流水的 orderId 与 reason，便于对账时按订单找流水）
   * @param items   要预占的条目
   */
  async reserve(
    orderId: string,
    items: Array<{ skuId: string; quantity: number }>,
  ): Promise<InventoryMovement[]> {
    return this.prisma.$transaction(
      async (tx) => this.reserveInTx(tx, orderId, items),
      { maxWait: 10_000, timeout: 10_000 },
    );
  }

  /**
   * 在**调用方的事务内**预占库存。
   *
   * Task 4 的下单流程要在一个事务里完成「建订单 + 建订单项 + 扣库存 + 记流水」，
   * 所以这里必须能接受外部的 tx，而不是自己开事务。
   */
  async reserveInTx(
    tx: PrismaTransaction,
    orderId: string,
    items: Array<{ skuId: string; quantity: number }>,
  ): Promise<InventoryMovement[]> {
    if (items.length === 0) {
      throw new BadRequestException('预占条目不能为空');
    }

    const tenantId = this.currentTenantId();

    // ⚠️ **先合并同 skuId 的条目**（见 mergeItems 的注释）。
    // 合并必须在加锁之前：合并后自然没有重复 skuId，
    // lockSkus 也不会对同一个 id 执行两次 FOR UPDATE。
    const merged = mergeItems(items);

    // 1. 按 id 排序加锁并读出当前值
    const locked = await this.lockSkus(
      tx,
      tenantId,
      merged.map((item) => item.skuId),
    );

    // 2. 校验：每个 SKU 都要在锁到的结果里（数量对不上说明 id 不存在或跨租户）
    const lockedById = new Map(locked.map((sku) => [sku.id, sku]));
    for (const item of merged) {
      const sku = lockedById.get(item.skuId);
      if (!sku) {
        // 查不到可能是「不存在」也可能是「别的租户的」。
        // 两种都回同一个错，不给攻击者「这个 id 存在但不属于你」的信息。
        throw new NotFoundException('SKU 不存在或不可售');
      }
      if (sku.status !== 'ACTIVE') {
        throw new BadRequestException('SKU 已停用');
      }
      if (sku.deletedAt !== null) {
        throw new BadRequestException('SKU 已删除');
      }
      if (item.quantity < 1) {
        throw new BadRequestException('预占数量必须大于 0');
      }
      if (sku.stock < item.quantity) {
        throw new ConflictException(
          `库存不足：${sku.id} 当前 ${sku.stock}，要预占 ${item.quantity}`,
        );
      }
    }

    // 3 & 4. 逐个扣库存 + 记 RESERVE 流水
    const movements: InventoryMovement[] = [];
    for (const item of merged) {
      const sku = lockedById.get(item.skuId);
      // 上面已经逐个校验过存在性，这里必然拿到。TS 不知道，用非空断言收口。
      if (!sku) {
        throw new NotFoundException('SKU 不存在或不可售');
      }

      // 扣库存（带 stockVersion 条件）
      //
      // ⚠️ 行锁与 stockVersion **各管一段**（设计 §5.1）：
      // - 行锁管「并发下单之间」：同一 SKU 的扣减被串行化，不会丢更新。
      //   这条是**主力**——没有它两个并发下单会各读到同一个旧库存。
      // - stockVersion 管「管理端的人工调整」：管理端在阶段 2 用同一套
      //   版本号约定，两边都不会静默覆盖对方。
      //
      // ⚠️ 更准确地说：这两个检查是**互为对称保护**的。
      // 实测做过交错测试（管理端的无行锁调整与预占交错）：
      // 最终 stock 正确、没有丢更新——但**挡住它的是管理端自己那个
      // `stockVersion` where**，不是预占这边的。
      // 也就是说任何一边单独失效仍然安全，只有**两边同时失效**才会丢更新。
      //
      // ⚠️ 诚实地说：在**当前**的实现里，这个条件在「行锁还在」的前提下
      // 是冗余的——预占事务读到的 stockVersion 永远是最新的，
      // 实测删掉它用例也不会失败（这条冗余条件目前零测试覆盖；
      // 本项目的原则是「不为不可能发生的场景造测试」，不为它硬造一条假用例）。
      // 留着它是**纵深防御**：一旦将来有人把加锁换成普通读（或者
      // 出现了一条不持有行锁的写库存路径），这一行就是拦住
      // 「丢失更新」的闸门。代价只有一次索引查找，不值得省。
      //
      // 受影响行数为 0 说明在本事务读出 stock 到写入之间有人改过它，
      // 整个事务回滚并让调用方重试。
      //
      // `updateMany` 走 Prisma 扩展，**会自动附加 tenantId 条件** ✓。
      const affected = await tx.sku.updateMany({
        where: { id: sku.id, stockVersion: sku.stockVersion },
        data: {
          stock: sku.stock - item.quantity,
          stockVersion: { increment: 1 },
        },
      });
      if (affected.count === 0) {
        throw new ConflictException('库存已被他人修改，请重试');
      }

      // 记 RESERVE 流水
      movements.push(
        await tx.inventoryMovement.create({
          data: {
            // tenantId 显式写出：租户扩展在运行时会把它注入 data，
            // 但 TypeScript 只认 Prisma 生成的类型，不看运行时行为，
            // 漏掉会在 tsc --noEmit 处报错。
            tenantId,
            skuId: sku.id,
            type: InventoryMovementType.RESERVE,
            // quantity 是**业务量与方向**：预占 5 件记 -5（与流水类型无关的通用约定）。
            quantity: -item.quantity,
            // stockBefore/After 是**实际库存**的数值变化：预占真的把库存扣掉了。
            stockBefore: sku.stock,
            stockAfter: sku.stock - item.quantity,
            // orderId 让「这个订单预占了多少」可以被查出来，
            // 而不用去解析 reason 文本。
            orderId,
            reason: `订单 ${orderId} 预占`,
            // operatorId 留空：预占是系统行为，没有人工操作人。
            // 游客下单时连 customerId 都是空的，填假值会让「谁动了库存」失真。
          },
        }),
      );
    }

    return movements;
  }

  /**
   * 确认售出（支付成功后调用）。
   *
   * ⚠️ **库存不变**——预占时已经扣过了，这里只是把「预占」转成「已售」。
   * 所以 `quantity = -qty` 但 `stockBefore == stockAfter`（设计 §5.2）。
   *
   * ⚠️ **也要校验预占量**：DEDUCT 的库存不变、只记流水，
   * 但它的 `quantity = -qty` 同样表示「又卖出了 qty 件」——
   * 超过预占量的话流水就自相矛盾了（卖出量大于预占量）。
   */
  async deductInTx(
    tx: PrismaTransaction,
    orderId: string,
    items: Array<{ skuId: string; quantity: number }>,
  ): Promise<InventoryMovement[]> {
    return this.writeMovements(
      tx,
      orderId,
      items,
      InventoryMovementType.DEDUCT,
      // DEDUCT：库存不变（第二个参数用不到）
      (stock) => stock,
      // 但业务量仍然是「又卖出了 qty 件」，方向为负
      (quantity) => -quantity,
      '确认售出',
    );
  }

  /**
   * 释放预占（订单取消或支付超时关闭时调用）。
   *
   * 库存还回去：`stock += qty`，业务量记 `+qty`。
   *
   * ⚠️ **必须校验这些条目确实被预占过**：释放是唯一会让库存**变大**的操作，
   * 没有校验的话对一个从未预占过的 SKU 释放 5 件，库存会凭空 +5——
   * 而且流水与库存的净变化**是自洽的**，对账时看不出问题。
   */
  async releaseInTx(
    tx: PrismaTransaction,
    orderId: string,
    items: Array<{ skuId: string; quantity: number }>,
  ): Promise<InventoryMovement[]> {
    return this.writeMovements(
      tx,
      orderId,
      items,
      InventoryMovementType.RELEASE,
      // RELEASE：库存还回去
      (stock, quantity) => stock + quantity,
      (quantity) => quantity,
      '释放预占',
    );
  }

  /**
   * DEDUCT / RELEASE 的共用实现。
   *
   * 与 RESERVE 分开写是因为两者的语义确实不同：
   * - RESERVE 要**扣库存**，且走 `stockVersion` 条件；
   * - DEDUCT **不动库存**；
   * - RELEASE 要**还库存**。
   *
   * 三个阶段共用「加锁 → 校验 → 写流水」这条主干的形状。
   */
  private async writeMovements(
    tx: PrismaTransaction,
    orderId: string,
    items: Array<{ skuId: string; quantity: number }>,
    type: InventoryMovementType,
    nextStock: (stock: number, quantity: number) => number,
    businessQuantity: (quantity: number) => number,
    reason: string,
  ): Promise<InventoryMovement[]> {
    if (items.length === 0) {
      return [];
    }

    const tenantId = this.currentTenantId();

    const merged = mergeItems(items);

    const locked = await this.lockSkus(
      tx,
      tenantId,
      merged.map((item) => item.skuId),
    );
    const lockedById = new Map(locked.map((sku) => [sku.id, sku]));

    // ⚠️ 校验「本次操作的量不能超过该订单在该 SKU 上尚未被冲抵的预占量」。
    // 这是本方法存在的**核心**理由：没有它，释放可以凭空造货。
    const reserved = await this.unreservedQuantities(
      tx,
      orderId,
      merged.map((item) => item.skuId),
    );

    const movements: InventoryMovement[] = [];
    for (const item of merged) {
      const sku = lockedById.get(item.skuId);
      if (!sku) {
        throw new NotFoundException('SKU 不存在或不可售');
      }

      // ⚠️ **刻意不校验 status / deletedAt**（reserveInTx 那边会校验，
      // 这里不校验是**有意的**，不是漏了）。
      // 释放一个已停用 / 已软删的 SKU 是**合理的**——释放时 SKU 早就该下架了
      // （用户下单后商家把商品下架、订单超时或取消，货要还回库存）。
      // 拦住反而会卡住退款流程。
      //
      // ⚠️ 所以两处的校验集**不对称是故意的**：
      // 预占要「买得到」→ 校验可售状态；
      // 释放/售出要「还回得去」→ 只校验确实预占过。
      // 别为了「对称」顺手给这里补上 status 检查。

      // ⚠️ 数量必须为正。少了这个检查，`releaseInTx(quantity=-100)` 会把
      // 库存**扣成负数**（nextStock 是 stock + quantity）。
      // reserveInTx 一直有这个检查，writeMovements 之前没有——两边不对称。
      if (item.quantity < 1) {
        throw new BadRequestException('数量必须大于 0');
      }

      const reservedQuantity = reserved.get(item.skuId) ?? 0;
      if (item.quantity > reservedQuantity) {
        throw new ConflictException(
          `预占量不足：${item.skuId} 尚未被冲抵的预占量 ${reservedQuantity}，要${reason} ${item.quantity}`,
        );
      }

      const stockAfter = nextStock(sku.stock, item.quantity);

      // 只有库存真的要变时才走 updateMany：
      // DEDUCT 的库存不变，改了也是白改（还会白白推进 stockVersion，
      // 让管理端的乐观锁无谓地冲突）。
      if (stockAfter !== sku.stock) {
        const affected = await tx.sku.updateMany({
          where: { id: sku.id, stockVersion: sku.stockVersion },
          data: {
            stock: stockAfter,
            stockVersion: { increment: 1 },
          },
        });
        if (affected.count === 0) {
          throw new ConflictException('库存已被他人修改，请重试');
        }
      }

      movements.push(
        await tx.inventoryMovement.create({
          data: {
            tenantId,
            skuId: sku.id,
            type,
            quantity: businessQuantity(item.quantity),
            stockBefore: sku.stock,
            stockAfter,
            // orderId 让「这个订单预占了多少」可以被查出来，
            // 而不用去解析 reason 文本。
            orderId,
            reason: `订单 ${orderId} ${reason}`,
          },
        }),
      );
    }

    return movements;
  }

  /**
   * 某个订单对某些 SKU **尚未被冲抵**的预占量。
   *
   * 未冲抵预占量 = 累计预占 - 累计释放 - 累计售出。
   *
   * ⚠️ **三个符号不能混**——这是本方法最容易写错的地方：
   * - RESERVE 记 `-qty`：占用预占，让未冲抵量**减少**
   * - RELEASE 记 `+qty`：归还预占，让未冲抵量**增加**
   * - DEDUCT  记 `-qty`：确认售出，**消耗**预占，让未冲抵量**减少**
   *
   * RESERVE 与 DEDUCT 的 quantity 同为负数，但语义不同，
   * 所以**不能**把三者的 quantity 一股脑加起来取负——那样 DEDUCT
   * 会被当成「增加预占」，售出后的货又能被释放一次（凭空造货）。
   *
   * 正确公式：**-Σ(RESERVE) - Σ(RELEASE) + Σ(DEDUCT)**
   *
   * | 组合 | 未冲抵量 |
   * |------|---------|
   * | 只有 RESERVE(-5) | 5 ✓ |
   * | RESERVE(-5) + RELEASE(+5) | 0 ✓ |
   * | RESERVE(-5) + DEDUCT(-5) | 0 ✓ |
   * | RESERVE(-5) + RELEASE(+5) + DEDUCT(-5) | -5（超额，应被拒）|
   *
   * ⚠️ **只算这三种类型**——INITIAL / ADJUST_IN / ADJUST_OUT 与订单无关，
   * 它们没有 orderId，混进来会把库存调整算成订单的预占。
   *
   * @returns skuId → 尚未被冲抵的预占量（没有则不出现这个 key）
   */
  private async unreservedQuantities(
    tx: PrismaTransaction,
    orderId: string,
    skuIds: string[],
  ): Promise<Map<string, number>> {
    if (skuIds.length === 0) {
      return new Map();
    }

    const movements = await tx.inventoryMovement.findMany({
      where: {
        orderId,
        skuId: { in: skuIds },
        type: {
          in: [
            InventoryMovementType.RESERVE,
            InventoryMovementType.RELEASE,
            InventoryMovementType.DEDUCT,
          ],
        },
      },
      select: { skuId: true, type: true, quantity: true },
    });

    const totals = new Map<
      string,
      { reserve: number; release: number; deduct: number }
    >();
    for (const movement of movements) {
      const bucket = totals.get(movement.skuId) ?? {
        reserve: 0,
        release: 0,
        deduct: 0,
      };
      if (movement.type === InventoryMovementType.RESERVE) {
        bucket.reserve += movement.quantity;
      } else if (movement.type === InventoryMovementType.RELEASE) {
        bucket.release += movement.quantity;
      } else {
        bucket.deduct += movement.quantity;
      }
      totals.set(movement.skuId, bucket);
    }

    const unreserved = new Map<string, number>();
    for (const [skuId, bucket] of totals) {
      unreserved.set(skuId, -bucket.reserve - bucket.release + bucket.deduct);
    }
    return unreserved;
  }

  /**
   * 在**调用方的事务内**锁定这些 SKU（`SELECT ... FOR UPDATE`）。
   *
   * Task 4 的下单流程要按「锁 → 读价格 → 建单 → 扣库存」的顺序走
   * （设计 §5.1），所以「加锁」这一步要能被调用方单独触发——
   * 不然只能等 `reserveInTx` 里才加锁，那已经晚了一步：
   * 建订单时读到的价格可能是**没锁时**读到的旧值。
   *
   * ⚠️ 事务里对同一行重复 `FOR UPDATE` 是安全的（同一事务自己持有那把锁），
   * 所以下单流程里先调它、后调 `reserveInTx`（它内部还会再锁一次）没问题。
   *
   * @returns 锁到的 SKU 行；查不到的（不存在 / 别的租户）不在结果里
   */
  async lockSkusInTx(
    tx: PrismaTransaction,
    skuIds: string[],
  ): Promise<LockedSku[]> {
    return this.lockSkus(tx, this.currentTenantId(), skuIds);
  }

  /**
   * 锁定并返回这些 SKU。
   *
   * ⚠️ 两条硬性要求：
   * 1. **按 id 排序、逐条加锁**——两个订单含两个 SKU 且顺序相反时会死锁
   *    （A→B vs B→A：各自持有对方要的行锁）。
   *    排序后全局加锁顺序一致，死锁不可能发生。
   * 2. **手写 tenantId 条件**——`$queryRaw` 绕过 Prisma 扩展，
   *    扩展的隔离保护在这里不生效。
   *
   * ⚠️ **为什么逐条加锁而不是一条 `id IN (...)`**：
   * 一条 `IN` 查询的加锁顺序由**查询计划**决定（位图扫描按堆顺序、
   * 索引扫描按索引顺序），**不随 IN 列表的顺序变化**。
   * 也就是说，计划碰巧一致时不排序也不会死锁——但那是运气，
   * 计划一变（统计信息更新、索引增减、读写分离的副本）就可能不再一致。
   * 逐条加锁把「全局一致的加锁顺序」变成**实现的确定性保证**，
   * 不依赖任何计划假设。N 个 SKU 就是 N 条语句，对下单这种低频路径完全够用。
   *
   * ⚠️ 列名是 **camelCase 且必须加双引号**：schema 里只有 `@@map` 把表名映成了
   * `skus`，字段本身没有 `@map`，所以列名就是 `"productId"`、`"tenantId"`、
   * `"deletedAt"`。不加引号 PostgreSQL 会把驼峰折叠成小写，
   * 报的是 `column "productid" does not exist`——字面上完全看不出
   * 「你只是少了一对引号」。
   * `price` / `stock` / `status` 都是小写，不加引号也能匹配。
   *
   * 顺带一提：这条 SQL 里的 `${tenantId}` 是参数化占位符，
   * 值不会被拼进 SQL 文本，所以不存在注入面。
   */
  private async lockSkus(
    tx: PrismaTransaction,
    tenantId: string,
    skuIds: string[],
  ): Promise<LockedSku[]> {
    // 排序是**死锁防护的全部**——去掉它，两个订单按相反顺序加锁就会互相等待。
    const sorted = [...skuIds].sort();

    const locked: LockedSku[] = [];
    for (const skuId of sorted) {
      const rows = await tx.$queryRaw<LockedSku[]>`
        SELECT id, "productId", price, stock, "stockVersion", status, "deletedAt"
        FROM skus
        WHERE id = ${skuId} AND "tenantId" = ${tenantId}
        FOR UPDATE
      `;
      // 查不到（不存在 / 别的租户）就不记，交给调用方校验时统一报「不存在或不可售」
      locked.push(...rows);
    }
    return locked;
  }
}

/** 行锁读出来的 SKU 快照。字段名与数据库里的列名一一对应。 */
export interface LockedSku {
  id: string;
  productId: string;
  price: number;
  stock: number;
  stockVersion: number;
  status: string;
  deletedAt: Date | null;
}

/**
 * 把条目按 skuId 合并（同 skuId 的数量相加）。
 *
 * ⚠️ **为什么必须合并**：重复的 skuId 会让 `lockSkus` 对同一个 id 执行两次
 * `SELECT ... FOR UPDATE`，拿到**同一份快照**（stock=10, version=0）；
 * `lockedById` 是 Map，两次折叠成一条；但写循环遍历的是**条目**而不是 Map——
 * 第一轮把 stock 写成 9、version 推到 1，第二轮仍拿着快照里的 version=0
 * 去 where → 受影响行数 0 → 抛 409「库存已被他人修改，请重试」。
 *
 * 数据上是安全的（整个事务回滚，不会双扣），但对外报的是**误导性的**错误：
 * 调用方按这个提示重试必然再次失败，而且掩盖了真正的输入问题。
 *
 * 合并后自然没有重复，`lockSkus` 也不会重复执行同一条 SQL。
 * 合并后的语义是对的：同 SKU 两条各 1 件 = 要 2 件；
 * 若库存只有 1 件 → 合并后 2 > 1 → 409「库存不足」，错误信号正确。
 *
 * ⚠️ 消费方（Task 4 从 cart 生成条目）受 `CartItem` 的
 * `@@unique([cartId, skuId])` 保护，不会产生重复——但 `reserveInTx` 是公开的
 * service 方法，**契约不该靠调用方自觉**。
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
