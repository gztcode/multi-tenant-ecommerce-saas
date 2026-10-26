import { Injectable, NotFoundException } from '@nestjs/common';
import { Tenant, TenantStatus } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';

/**
 * 商家（租户）管理服务，仅供平台超管调用。
 *
 * 这里的每个方法都是跨租户操作，但 Tenant **不在** TENANT_SCOPED_MODELS 里，
 * 因此租户扩展对它不做任何附加过滤——跨租户能力来自模型本身而不是上下文，
 * 真正的访问控制在控制器层的 @Roles(PLATFORM_ADMIN)。
 *
 * 这是一处刻意的取舍：把 Tenant 做成租户作用域模型毫无意义（租户就是租户本身，
 * tenantId 是它自己的主键），却会让「按 id 查租户」这种平台基础操作处处受限。
 */
@Injectable()
export class TenantsService {
  constructor(private readonly prisma: TenantPrismaService) {}

  /** 商家列表（平台超管） */
  async list(): Promise<Tenant[]> {
    return this.prisma.tenant.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * 变更商家状态（平台超管）：ACTIVE / SUSPENDED。
   *
   * 用 updateMany 而非 update，与店铺更新同理——update 的 where 只接受唯一字段。
   * 先 findFirst 判存在再写，是为了把「商家不存在」表达成 404 而不是静默成功。
   *
   * 注意：目前**状态变更不会让已签发的令牌失效**。用户被置为 SUSPENDED 后，
   * 他手上没过期的 access token 仍能继续调接口（详见 e2e 里那条如实记录）。
   * 补齐需要 JWT 版本号/吊销名单机制，属于后续任务的范围，不在这里悄悄半做。
   */
  async updateStatus(id: string, status: TenantStatus): Promise<Tenant> {
    const tenant = await this.prisma.tenant.findFirst({ where: { id } });
    if (!tenant) {
      throw new NotFoundException('商家不存在');
    }

    await this.prisma.tenant.updateMany({
      where: { id },
      data: { status },
    });

    const updated = await this.prisma.tenant.findFirst({ where: { id } });
    if (!updated) {
      // 读到的第一行还在、紧接着的写入后就消失了：并发删除。
      throw new NotFoundException('商家不存在');
    }

    return updated;
  }
}
