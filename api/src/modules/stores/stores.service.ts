import { Injectable, NotFoundException } from '@nestjs/common';
import { Store } from '@prisma/client';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import {
  getTenantContext,
  platformScope,
  tenantContext,
} from '../../common/tenant/tenant-context';
import { UpdateStoreDto } from './dto/update-store.dto';

@Injectable()
export class StoresService {
  constructor(private readonly prisma: TenantPrismaService) {}

  /**
   * 取当前租户的店铺（商家后台与消费者侧共享同一份数据）。
   *
   * 这里的 `where: { tenantId: context.tenantId }` 是**手写的第二道防线**：
   * 租户扩展本来就会自动合并 tenantId，但显式写出来有两个作用——
   * ① 没有它，「店铺按什么维度定位」这件事就完全隐含在扩展里，
   *    读代码的人看不出越权边界在哪；
   * ② 后续若扩展的行为被改动或被绕过（比如误换成裸 client），
   *    这一行仍在，不会静默变成跨租户查询。
   */
  async findMine(): Promise<Store> {
    const context = getTenantContext();
    if (!context.tenantId) {
      throw new NotFoundException('当前身份不属于任何店铺');
    }

    const store = await this.prisma.store.findFirst({
      where: { tenantId: context.tenantId },
    });

    if (!store) {
      throw new NotFoundException('店铺不存在');
    }

    return store;
  }

  /**
   * 更新当前租户的店铺设置。
   *
   * 用 updateMany 而非 update：update 的 where 只接受唯一字段，无法附加
   * tenantId 条件，租户扩展会直接抛 TenantScopeError 拒绝。
   * updateMany 的 where 会与扩展注入的 tenantId **合并**，
   * 传入别的店铺 id 也只会影响 0 行、拿不到任何数据。
   *
   * 用展开运算逐字段构造 data 而不是 `...dto`：
   * UpdateStoreDto 的每个字段都是可选的，undefined 会被 Prisma 视作「不更新」，
   * 但显式写出条件能保证「没传的字段绝不会被碰到」，也不会被将来往 DTO 上
   * 加字段的实现细节（直接展开就会把整个 DTO 灌进 data）带出新的写入面。
   */
  async updateMine(dto: UpdateStoreDto): Promise<Store> {
    const store = await this.findMine();

    await this.prisma.store.updateMany({
      where: { id: store.id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.themeTokens !== undefined
          ? { themeTokens: dto.themeTokens as object }
          : {}),
      },
    });

    // 重新读一次而不是复用 store：updateMany 的返回值只有 count，
    // 复用旧对象会返回过期的 name（updatedAt 也会停在旧值）。
    return this.findMine();
  }

  /**
   * 按子域名取店铺（店铺前台公开接口）。
   *
   * 子域名本身就是定位租户的入口，这里必须做一次显式的跨租户读取，
   * 因此进入 platformScope() 而不是沿用当前请求的租户上下文——
   * 请求很可能带着「调用者所属的租户」，而要查的是「子域名指向的租户」，
   * 两者是不同的租户。
   *
   * ⚠️ run() 的回调必须是 async 函数：Prisma 6 的 PrismaPromise 是 thenable，
   * 同步回调会让 AsyncLocalStorage 上下文在查询执行那一刻丢失，隔离静默失效。
   *
   * 平台作用域是全应用唯一一个「可以不带任何身份地跨租户读」的位置，
   * 因此这里的输入（subdomain）必须可信——它只来自 URL 路径而非请求体，
   * 且 Tenant.subdomain 有唯一约束，读不到就是读不到，不会串到别的租户。
   */
  async findBySubdomain(subdomain: string): Promise<Store> {
    return tenantContext.run(platformScope(), async () => {
      const tenant = await this.prisma.tenant.findFirst({
        where: { subdomain: subdomain.toLowerCase() },
      });

      if (!tenant) {
        throw new NotFoundException('店铺不存在');
      }

      const store = await this.prisma.store.findFirst({
        where: { tenantId: tenant.id },
      });

      if (!store) {
        throw new NotFoundException('店铺不存在');
      }

      return store;
    });
  }
}
