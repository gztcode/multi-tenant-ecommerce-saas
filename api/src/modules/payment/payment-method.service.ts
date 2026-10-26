import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { PAYMENT_PROVIDERS } from './payment.constants';
import type { PaymentProvider } from './payment-provider.interface';

/**
 * 商家的支付方式（自动续费的前提）。
 *
 * ⚠️ **token 由渠道给，不是客户端给的** —— 客户端传 token 的话，
 * 商家就能绑一个「不属于自己的」支付方式，续费时扣的是别人的钱。
 *
 * ⚠️ **token 明文存**：真实渠道必须加密存（可解密的密文 ——
 * 自动续费要拿它去扣款，不是用来比对的）。
 */
@Injectable()
export class PaymentMethodService {
  constructor(
    private readonly prisma: TenantPrismaService,
    @Inject(PAYMENT_PROVIDERS)
    private readonly providers: Map<string, PaymentProvider>,
  ) {}

  /**
   * 绑定一个支付方式。
   *
   * ⚠️ **返回的字段里没有 `token`**：那是渠道给的扣款凭证，
   * 自动续费要拿它去扣款。返回给浏览器 = 把凭证交出去。
   * ⚠️ **手写的返回类型里本来就没有 `token`，但那并不能保证运行时没有** ——
   * Prisma 默认返回整行，类型声明骗不了运行时。用 `select` 挑字段，
   * 挑到的才是真的会被返回的。
   */
  async create(
    tenantId: string,
    type: string,
    channel: string,
  ): Promise<{
    id: string;
    tenantId: string;
    provider: string;
    channel: string;
    type: string;
    isDefault: boolean;
    createdAt: Date;
    updatedAt: Date;
  }> {
    const provider = this.providers.get(channel);
    if (!provider) {
      throw new BadRequestException('未知的支付渠道');
    }
    const { token } = await provider.createPaymentMethod({ type });

    // ⚠️ **默认的只有一个**：新绑的这个是默认，之前那个要让位。
    await this.prisma.paymentMethod.updateMany({
      where: { tenantId },
      data: { isDefault: false },
    });

    return this.prisma.paymentMethod.create({
      data: {
        tenantId,
        provider: provider.provider,
        channel,
        type,
        token,
        isDefault: true,
      },
      select: {
        id: true,
        tenantId: true,
        provider: true,
        channel: true,
        type: true,
        isDefault: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  /**
   * 这个租户的支付方式列表。
   *
   * ⚠️ **不返回 `token`**：`payment_methods.token` 是渠道给的扣款凭证，
   * 自动续费要拿它去扣款。列表接口把它吐给前端 = 把凭证发到浏览器。
   * 用 `select` 显式挑字段 —— 挑不到就不会漏出去。
   */
  async list(tenantId: string) {
    const items = await this.prisma.paymentMethod.findMany({
      where: { tenantId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        provider: true,
        channel: true,
        type: true,
        isDefault: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return { items, total: items.length };
  }

  /** 解绑 */
  async remove(tenantId: string, id: string): Promise<void> {
    // ⚠️ **用 `deleteMany` 而不是 `delete`**：租户作用域模型上
    // `delete` 的 where 只接受唯一字段，扩展会直接拒绝。
    // ⚠️ 这里是**物理删除**（不是软删）：支付方式不用保留历史 ——
    // 但**核销记录要留**，所以只删 token 所在的这一行。
    await this.prisma.paymentMethod.deleteMany({ where: { id, tenantId } });
  }

  /**
   * 设为默认（默认的只有一个）。
   *
   * ⚠️ **两步写在同一个事务里**。
   *
   * `payment_methods` 表上**没有「每租户一个默认」的部分唯一索引**，
   * 所以「只有一个默认」全靠应用层保证。两次 `updateMany` 之间崩溃 →
   * 该租户**没有默认支付方式**（自动续费静默失效）或**两个默认**
   * （续费时扣哪张卡是不确定的）。
   *
   * ⚠️ **顺序不能反**：先把所有默认的清掉，再把目标那笔置为默认。
   * 反过来（先置新的再清旧的）会把刚设好的那个也清掉。
   */
  async setDefault(tenantId: string, id: string): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        await tx.paymentMethod.updateMany({
          where: { tenantId },
          data: { isDefault: false },
        });
        await tx.paymentMethod.updateMany({
          where: { id, tenantId },
          data: { isDefault: true },
        });
      },
      { maxWait: 10_000, timeout: 10_000 },
    );
  }
}
