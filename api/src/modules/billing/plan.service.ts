import { Injectable, NotFoundException } from '@nestjs/common';
import { PlanStatus, type Plan } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { rethrowIfUniqueViolation } from '../../common/errors/unique-constraint';
import { CreatePlanDto } from './dto/create-plan.dto';
import { UpdatePlanDto } from './dto/update-plan.dto';

/**
 * 套餐（平台级）。
 *
 * ⚠️ **`plans` 表刻意不带 `tenantId`**（设计文档 §3.1）：
 * 套餐是**平台的数据**，不是租户的数据 —— 扩展对它不附加任何条件。
 * 先例是阶段 3 的 `PaymentWebhookEvent`。
 *
 * ⚠️ **只有平台超管能写**（护栏 M3）：写接口挂在
 * `platform/plans`（`@Roles(PLATFORM_ADMIN)`），商家侧**没有**创建接口。
 */
@Injectable()
export class PlanService {
  constructor(private readonly prisma: TenantPrismaService) {}

  /** 在售的套餐（商家能看到的） */
  async listActive(): Promise<{ items: Plan[]; total: number }> {
    const items = await this.prisma.plan.findMany({
      where: { status: PlanStatus.ACTIVE },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return { items, total: items.length };
  }

  /** 全部套餐（平台侧） */
  async listAll(): Promise<{ items: Plan[]; total: number }> {
    const items = await this.prisma.plan.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return { items, total: items.length };
  }

  /**
   * 按 id 找**在售**的套餐。
   *
   * ⚠️ **下架的套餐订不了**（护栏 M3）。
   */
  async findActiveById(id: string): Promise<Plan | null> {
    return this.prisma.plan.findFirst({
      where: { id, status: PlanStatus.ACTIVE },
    });
  }

  async create(dto: CreatePlanDto): Promise<Plan> {
    try {
      return await this.prisma.plan.create({
        data: {
          code: dto.code.trim(),
          name: dto.name.trim(),
          description: dto.description ?? null,
          price: dto.price,
          periodDays: dto.periodDays,
          trialDays: dto.trialDays ?? 0,
          commissionBps: dto.commissionBps,
          maxProducts: dto.maxProducts ?? null,
          maxSkus: dto.maxSkus ?? null,
          // ⚠️ **区分「没传」与「显式传 null」**：`??` 把 null 也当成「没传」，
          // 显式传 null（= 不限）会变成 1 —— 界面上写着「留空 = 不限」，
          // 实际给的是 1，超管以为自己不限店铺、实际只能开 1 个。
          // 没传时才用默认值 1（绝大多数套餐只允许一个店铺）。
          maxStores: dto.maxStores === undefined ? 1 : dto.maxStores,
          features: dto.features ?? {},
          status: PlanStatus.ACTIVE,
        },
      });
    } catch (error) {
      // ⚠️ **P2002 在事务外处理**（唯一约束冲突让事务 aborted）
      rethrowIfUniqueViolation(error, '套餐代码');
    }
  }

  /**
   * 改套餐。
   *
   * ⚠️ **`update` 在租户作用域模型上被扩展禁用**（where 只接受唯一字段）——
   * 但 `plans` **不在**租户作用域里，所以 `update` 是合法的。
   */
  async update(id: string, dto: UpdatePlanDto): Promise<Plan> {
    const data: Record<string, unknown> = {};
    if (dto.code !== undefined) data.code = dto.code.trim();
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.price !== undefined) data.price = dto.price;
    if (dto.periodDays !== undefined) data.periodDays = dto.periodDays;
    if (dto.trialDays !== undefined) data.trialDays = dto.trialDays;
    if (dto.commissionBps !== undefined) data.commissionBps = dto.commissionBps;
    if (dto.maxProducts !== undefined) data.maxProducts = dto.maxProducts;
    if (dto.maxSkus !== undefined) data.maxSkus = dto.maxSkus;
    if (dto.maxStores !== undefined) data.maxStores = dto.maxStores;
    if (dto.features !== undefined) data.features = dto.features;

    const found = await this.prisma.plan.findFirst({ where: { id } });
    if (!found) {
      throw new NotFoundException('套餐不存在');
    }
    try {
      return await this.prisma.plan.update({ where: { id }, data });
    } catch (error) {
      // ⚠️ **P2002 在事务外处理**：`code` 撞了别的套餐时是 409，不是 500
      rethrowIfUniqueViolation(error, '套餐代码');
    }
  }

  /** 下架套餐（软删语义：保留历史订单里的套餐快照） */
  async disable(id: string): Promise<Plan> {
    const found = await this.prisma.plan.findFirst({ where: { id } });
    if (!found) {
      throw new NotFoundException('套餐不存在');
    }
    return this.prisma.plan.update({
      where: { id },
      data: { status: PlanStatus.DISABLED },
    });
  }
}
