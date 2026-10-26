import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Promotion, PromotionStatus } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { getTenantContext } from '../../common/tenant/tenant-context';
import { CreatePromotionDto } from './dto/create-promotion.dto';
import { UpdatePromotionDto } from './dto/update-promotion.dto';
import { FEATURE_MARKETING, QuotaService } from '../billing/quota.service';

/**
 * 满减活动服务（阶段 5a Task 3）。
 *
 * 活动是**店铺级、自动生效**的优惠：不需要用户领，
 * 结算时按订单原价小计与门槛比较（判定逻辑在优惠引擎里）。
 *
 * ## 与券的区别
 *
 * - 活动：`promotions` 表，门槛 + 减免额，作用于**全店商品**
 * - 券：`coupons` 表，面额 + 门槛，需要用户**领取**后持有
 *
 * 两者可以叠加（设计文档 §二 决策 2），计算顺序是「先活动、后券」。
 */
@Injectable()
export class PromotionService {
  constructor(
    private readonly prisma: TenantPrismaService,
    // ⚠️ **模块依赖方向是 `coupon` → `billing`**（单向）。
    // `billing` 绝不能 import `coupon` —— 那就成了环。
    private readonly quota: QuotaService,
  ) {}

  /** 当前租户 ID（租户从上下文读，不当参数传） */
  private currentTenantId(): string {
    const context = getTenantContext();
    if (!context.tenantId) {
      throw new ForbiddenException('无法确定店铺');
    }
    return context.tenantId;
  }

  /**
   * 创建活动。
   *
   * ⚠️ **不采信请求体里的任何身份字段**：`status` 恒为 ACTIVE，
   * `tenantId` 从上下文拿。
   */
  async create(dto: CreatePromotionDto): Promise<Promotion> {
    const tenantId = this.currentTenantId();

    // ⚠️ **功能开关检查在 service 层**（护栏 M14 / M16）：
    // 只在 controller 层拦的话，绕过 controller 直接调 service 就拦不住。
    await this.quota.assertHasFeature(tenantId, FEATURE_MARKETING);

    const { startsAt, endsAt } = this.parseWindow(dto.startsAt, dto.endsAt);

    return this.prisma.promotion.create({
      data: {
        tenantId,
        name: dto.name,
        description: dto.description ?? null,
        minAmount: dto.minAmount,
        discountAmount: dto.discountAmount,
        status: PromotionStatus.ACTIVE,
        startsAt,
        endsAt,
      },
    });
  }

  /**
   * 修改活动。
   *
   * ⚠️ **更新用 `updateMany` 而不是 `update`**：租户作用域模型上
   * `update` 的 where 只接受唯一字段，扩展会直接拒绝。
   */
  async update(id: string, dto: UpdatePromotionDto): Promise<Promotion> {
    const tenantId = this.currentTenantId();

    // ⚠️ **功能开关检查在 service 层**（护栏 M14 / M16）
    await this.quota.assertHasFeature(tenantId, FEATURE_MARKETING);

    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.minAmount !== undefined) data.minAmount = dto.minAmount;
    if (dto.discountAmount !== undefined)
      data.discountAmount = dto.discountAmount;
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.startsAt !== undefined && dto.endsAt !== undefined) {
      const { startsAt, endsAt } = this.parseWindow(dto.startsAt, dto.endsAt);
      data.startsAt = startsAt;
      data.endsAt = endsAt;
    }

    const affected = await this.prisma.promotion.updateMany({
      where: { id, tenantId },
      data,
    });
    if (affected.count === 0) {
      throw new NotFoundException('活动不存在');
    }

    const updated = await this.prisma.promotion.findFirst({
      where: { id, tenantId },
    });
    if (!updated) {
      throw new NotFoundException('活动不存在');
    }
    return updated;
  }

  /**
   * 删除活动（软删）。
   *
   * ⚠️ **软删而非物理删**：活动是营销配置，`promotions` 登记在
   * `SOFT_DELETE_MODELS` 里，扩展会自动过滤掉已软删的行。
   */
  async remove(id: string): Promise<void> {
    const tenantId = this.currentTenantId();
    const affected = await this.prisma.promotion.updateMany({
      where: { id, tenantId },
      data: { deletedAt: new Date() },
    });
    if (affected.count === 0) {
      throw new NotFoundException('活动不存在');
    }
  }

  /** 活动列表（商家侧） */
  async list(): Promise<{ items: Promotion[]; total: number }> {
    const tenantId = this.currentTenantId();
    const items = await this.prisma.promotion.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
    return { items, total: items.length };
  }

  /**
   * 解析并校验有效期。
   *
   * ⚠️ **跨字段校验放在 service 层**：`endsAt > startsAt` 这类规则
   * class-validator 的装饰器做不到。
   */
  private parseWindow(
    startsAtRaw: string,
    endsAtRaw: string,
  ): { startsAt: Date; endsAt: Date } {
    const startsAt = new Date(startsAtRaw);
    const endsAt = new Date(endsAtRaw);
    if (endsAt.getTime() <= startsAt.getTime()) {
      throw new BadRequestException('结束时间必须晚于开始时间');
    }
    return { startsAt, endsAt };
  }
}
