import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InventoryMovement, Sku } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { AdjustStockDto } from './dto/adjust-stock.dto';
import { ReturnStockDto } from './dto/return-stock.dto';
import { requireTenantId } from '../../common/tenant/require-tenant';

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: TenantPrismaService) {}

  private currentTenantId(): string {
    return requireTenantId();
  }

  /**
   * 库存调整。
   *
   * 在一个事务里完成「改库存 + 记流水」，两者必须同生共死——
   * 只改库存不记流水会让台账与实际对不上，只记流水不改库存会让台账骗人。
   *
   * 流水的 quantity 是**带符号的增量**：
   * - ADJUST_IN  → +quantity
   * - ADJUST_OUT → -quantity
   * - CHECK      → 传入的是盘点后的实际值，增量 = 实际值 - 原值
   */
  async adjust(
    dto: AdjustStockDto,
    operatorId: string,
  ): Promise<{ sku: Sku; movement: InventoryMovement }> {
    const tenantId = this.currentTenantId();

    return this.prisma.$transaction(async (tx) => {
      const sku = await tx.sku.findFirst({ where: { id: dto.skuId } });
      if (!sku) {
        throw new NotFoundException('SKU 不存在');
      }

      const stockBefore = sku.stock;
      let stockAfter: number;
      let delta: number;

      // 用 if-else 而不是 switch：switch 里每个 case 都要 break，
      // 而 TS 的「使用前赋值」检查在 switch 外会报 stockAfter 可能未赋值
      // （控制流分析看不穿 switch 的分支穷尽性）。if-else 链没有这个问题。
      if (dto.type === 'ADJUST_IN') {
        delta = dto.quantity;
        stockAfter = stockBefore + delta;
      } else if (dto.type === 'ADJUST_OUT') {
        if (dto.quantity > stockBefore) {
          throw new BadRequestException(
            `库存不足：当前 ${stockBefore}，要出库 ${dto.quantity}`,
          );
        }
        delta = -dto.quantity;
        stockAfter = stockBefore + delta;
      } else {
        // CHECK：传的是盘点后的绝对值，流水里记成差量
        stockAfter = dto.quantity;
        delta = stockAfter - stockBefore;
      }

      // 乐观锁：把 stockVersion 放进 where，由数据库在写入那一刻判定。
      //
      // 不加这一步会**丢失更新**：两个并发的入库各读到 stock=10，
      // 各自算出 stockAfter=20，后写的覆盖先写的——入库两笔却只进一笔，
      // 而且流水里会记两条，账实对不上。
      //
      // 事务只保证「改库存 + 记流水」的原子性，不保证读-改-写的隔离，
      // 所以这里必须让数据库在写入那一刻再校验一次版本。
      //
      // 受影响行数为 0 = 在本事务读出 stock 到写入之间有人改过它。
      // 手动调整是低频操作，让调用方重试即可（与 Product.version 同一模式）。
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

      const movement = await tx.inventoryMovement.create({
        data: {
          // tenantId 显式写出：租户扩展在运行时会把它注入 data，
          // 但 TypeScript 只认 Prisma 生成的类型，不看运行时行为，
          // 漏掉会在 tsc --noEmit 处报错。
          tenantId,
          skuId: sku.id,
          type: dto.type,
          quantity: delta,
          stockBefore,
          stockAfter,
          ...(dto.reason !== undefined ? { reason: dto.reason } : {}),
          operatorId,
        },
      });

      const updated = await tx.sku.findFirst({ where: { id: sku.id } });
      if (!updated) {
        // 事务内刚改过的行不可能消失，出现即说明有并发删除或扩展行为异常。
        // 显式抛错让事务回滚，好过静默返回一个 null 给调用方。
        throw new NotFoundException('SKU 不存在');
      }
      return { sku: updated, movement };
    });
  }

  /**
   * 退货入库（阶段 11d）。
   *
   * ## 业务定位
   *
   * 退款**不**自动回补库存是有意的取舍（设计 §十三 / README 遗留项）——
   * 钱退了不代表货回来了。货真退回仓库时，商家在这里手动入库：
   * - **只有 REFUNDED 的订单**能退（货没退回来之前谈不上升库存）；
   * - 入库上限 = 该订单该 SKU 的购买量 − 已 RETURN 的量
   *   （RETURN 流水带 orderId，SUM 出已入库量）——**重复入库会把库存
   *   凭空加多**，上限校验是数据层的，不是靠调用方自觉；
   * - 库存写入用 stockVersion 乐观锁（与手动调整同一套防丢失更新机制）；
   * - 流水记**正数增量**（与 ADJUST_IN 同口径），带 orderId 供审计追溯。
   */
  async returnToStock(
    dto: ReturnStockDto,
    operatorId: string,
  ): Promise<{ movements: InventoryMovement[] }> {
    const tenantId = this.currentTenantId();

    return this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findFirst({ where: { id: dto.orderId } });
      if (!order) {
        throw new NotFoundException('订单不存在');
      }
      if (order.status !== 'REFUNDED') {
        throw new ConflictException('只有已退款（REFUNDED）的订单才能退货入库');
      }

      const orderItems = await tx.orderItem.findMany({
        where: { orderId: order.id },
      });
      const orderedQty = new Map(orderItems.map((i) => [i.skuId, i.quantity]));

      // 同一 SKU 在请求里出现多次时先合并（否则两次各 1 件能绕过单次校验）
      const merged = new Map<string, number>();
      for (const item of dto.items) {
        merged.set(item.skuId, (merged.get(item.skuId) ?? 0) + item.quantity);
      }

      // 上限校验：购买量 − 已 RETURN 量 ≥ 本次入库量
      for (const [skuId, quantity] of merged) {
        const ordered = orderedQty.get(skuId);
        if (ordered === undefined) {
          throw new BadRequestException('该商品不在本订单中');
        }
        const returned = await tx.inventoryMovement.aggregate({
          where: { skuId, orderId: order.id, type: 'RETURN' },
          _sum: { quantity: true },
        });
        const already = returned._sum.quantity ?? 0;
        if (quantity > ordered - already) {
          throw new BadRequestException(
            `该商品最多还能入库 ${ordered - already} 件（下单 ${ordered}，已入库 ${already}）`,
          );
        }
      }

      // 逐 SKU 入库：乐观锁改库存 + 记 RETURN 流水（带 orderId）
      const movements: InventoryMovement[] = [];
      for (const [skuId, quantity] of merged) {
        const sku = await tx.sku.findFirst({ where: { id: skuId } });
        if (!sku) {
          throw new NotFoundException('SKU 不存在');
        }
        const stockBefore = sku.stock;
        const affected = await tx.sku.updateMany({
          where: { id: sku.id, stockVersion: sku.stockVersion },
          data: {
            stock: stockBefore + quantity,
            stockVersion: { increment: 1 },
          },
        });
        if (affected.count === 0) {
          throw new ConflictException('库存已被他人修改，请重试');
        }
        movements.push(
          await tx.inventoryMovement.create({
            data: {
              tenantId,
              skuId,
              type: 'RETURN',
              quantity,
              stockBefore,
              stockAfter: stockBefore + quantity,
              ...(dto.reason !== undefined ? { reason: dto.reason } : {}),
              orderId: order.id,
              operatorId,
            },
          }),
        );
      }
      return { movements };
    });
  }

  /** 流水列表。流水表是 append-only 的，没有修改与删除接口。 */
  async movements(query: {
    skuId?: string;
    page?: number;
    pageSize?: number;
  }): Promise<{
    items: InventoryMovement[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    this.currentTenantId();
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));

    const where = query.skuId ? { skuId: query.skuId } : {};

    const [items, total] = await Promise.all([
      this.prisma.inventoryMovement.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.inventoryMovement.count({ where }),
    ]);

    return { items, total, page, pageSize };
  }

  /** 库存汇总：按商品列出各 SKU 的当前库存 */
  async summary(
    productId: string,
  ): Promise<
    Array<{ skuId: string; code: string | null; stock: number; status: string }>
  > {
    this.currentTenantId();
    const skus = await this.prisma.sku.findMany({
      where: { productId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, code: true, stock: true, status: true },
    });
    return skus.map((s) => ({
      skuId: s.id,
      code: s.code,
      stock: s.stock,
      status: s.status,
    }));
  }
}
