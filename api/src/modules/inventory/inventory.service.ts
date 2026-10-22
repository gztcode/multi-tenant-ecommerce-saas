import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InventoryMovement, Sku } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { getTenantContext } from '../../common/tenant/tenant-context';
import { AdjustStockDto } from './dto/adjust-stock.dto';

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: TenantPrismaService) {}

  private currentTenantId(): string {
    const context = getTenantContext();
    if (!context.tenantId) {
      throw new NotFoundException('无法确定店铺');
    }
    return context.tenantId;
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
