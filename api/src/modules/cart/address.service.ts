import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Address, UserRole } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { getTenantContext } from '../../common/tenant/tenant-context';
import { CreateAddressDto } from './dto/create-address.dto';
import { UpdateAddressDto } from './dto/update-address.dto';

@Injectable()
export class AddressService {
  constructor(private readonly prisma: TenantPrismaService) {}

  /** 当前租户 ID */
  private currentTenantId(): string {
    const context = getTenantContext();
    if (!context.tenantId) {
      throw new ForbiddenException('无法确定店铺');
    }
    return context.tenantId;
  }

  /**
   * 地址簿列表（只列当前消费者自己的）。
   *
   * Address 是软删模型，扩展的软删过滤只作用于顶层查询，
   * 这里查的就是顶层，所以已软删的地址自动被排除。
   */
  async list(customerId: string): Promise<{ items: Address[] }> {
    const items = await this.prisma.address.findMany({
      where: { customerId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
    // 用 { items } 包一层而不是直接返回数组：
    // 将来要加分页/总数时有地方放，前端的解析形状也不用改。
    return { items };
  }

  /**
   * 新增地址。
   *
   * ⚠️ **默认地址唯一**（护栏 19）：数据库上有部分唯一索引
   * `addresses_tenant_customer_default_uniq (tenantId, customerId)
   *    WHERE isDefault = true AND deletedAt IS NULL`，
   * 同一瞬间出现两条默认地址会被数据库直接拒绝。
   * 所以设新默认前**先把旧的置 false**，再设新的。
   */
  async create(customerId: string, dto: CreateAddressDto): Promise<Address> {
    if (dto.isDefault) {
      await this.clearDefault(customerId);
    }
    return this.prisma.address.create({
      data: {
        // tenantId 显式写出：租户扩展在运行时会把它注入 data，
        // 但 TypeScript 只认 Prisma 生成的类型，不看运行时行为，漏掉会编译报错。
        tenantId: this.currentTenantId(),
        customerId,
        receiver: dto.receiver,
        phone: dto.phone,
        province: dto.province,
        city: dto.city,
        district: dto.district,
        detail: dto.detail,
        isDefault: dto.isDefault ?? false,
      },
    });
  }

  /**
   * 修改地址。
   *
   * ⚠️ 只能改**自己**的地址：where 里带上 customerId。
   * 只按 id 查的话，同一租户内 A 消费者就能改 B 消费者的地址。
   */
  async update(
    customerId: string,
    id: string,
    dto: UpdateAddressDto,
  ): Promise<Address> {
    const existing = await this.prisma.address.findFirst({
      where: { id, customerId },
    });
    if (!existing) {
      throw new NotFoundException('地址不存在');
    }

    // ⚠️ 顺序要紧：先把旧的默认取消，再设新的。
    // 反过来做的话，中间那一瞬间会有两条 isDefault = true，撞唯一索引。
    if (dto.isDefault === true && !existing.isDefault) {
      await this.clearDefault(customerId);
    } else if (dto.isDefault === false && existing.isDefault) {
      // 取消默认：把新的默认让给剩下的某一条，否则用户会一个默认都没有。
      // 剩下没有别的地址时保持「没有默认」也是合法的（下单时可指定地址）。
      await this.promoteAnotherDefault(customerId, id);
    }

    const updated = await this.prisma.address.updateMany({
      where: { id, customerId },
      data: {
        ...(dto.receiver !== undefined ? { receiver: dto.receiver } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
        ...(dto.province !== undefined ? { province: dto.province } : {}),
        ...(dto.city !== undefined ? { city: dto.city } : {}),
        ...(dto.district !== undefined ? { district: dto.district } : {}),
        ...(dto.detail !== undefined ? { detail: dto.detail } : {}),
        ...(dto.isDefault !== undefined ? { isDefault: dto.isDefault } : {}),
      },
    });
    if (updated.count === 0) {
      throw new NotFoundException('地址不存在');
    }
    const result = await this.prisma.address.findFirst({
      where: { id, customerId },
    });
    if (!result) {
      throw new NotFoundException('地址不存在');
    }
    return result;
  }

  /**
   * 删除地址（软删）。
   *
   * 删的是默认地址时，要把默认让给剩下的某一条，
   * 否则用户会一个默认都没有。
   */
  async remove(customerId: string, id: string): Promise<void> {
    const existing = await this.prisma.address.findFirst({
      where: { id, customerId },
    });
    if (!existing) {
      throw new NotFoundException('地址不存在');
    }

    const wasDefault = existing.isDefault;
    // 软删：Address 是软删模型，扩展会禁止物理删除
    await this.prisma.address.updateMany({
      where: { id, customerId },
      data: { deletedAt: new Date(), isDefault: false },
    });

    if (wasDefault) {
      await this.promoteAnotherDefault(customerId, null);
    }
  }

  /**
   * 校验消费者属于当前租户（护栏 20）。
   *
   * ⚠️ Address 刻意**不声明 tenant 关系**，只有 tenantId 标量。
   * 外键只引用 User.id、不带 tenantId，数据库挡不住「把地址挂到别的租户的
   * 消费者名下」这种跨租户挂载——只能由 service 层显式校验归属。
   */
  async assertCustomerInTenant(customerId: string): Promise<void> {
    const customer = await this.prisma.user.findFirst({
      where: { id: customerId, role: UserRole.CUSTOMER },
    });
    if (!customer) {
      throw new ForbiddenException('消费者不存在或不属于当前店铺');
    }
  }

  /** 把当前消费者名下所有默认地址取消 */
  private async clearDefault(customerId: string): Promise<void> {
    await this.prisma.address.updateMany({
      where: { customerId, isDefault: true },
      data: { isDefault: false },
    });
  }

  /**
   * 把默认地址让给剩下的某一条（排除 excludeId）。
   *
   * 选最早创建的那条——顺序稳定，重复调用不会来回跳。
   */
  private async promoteAnotherDefault(
    customerId: string,
    excludeId: string | null,
  ): Promise<void> {
    const candidate = await this.prisma.address.findFirst({
      where: {
        customerId,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      orderBy: { createdAt: 'asc' },
    });
    if (!candidate) {
      return;
    }
    await this.prisma.address.updateMany({
      where: { id: candidate.id },
      data: { isDefault: true },
    });
  }
}
