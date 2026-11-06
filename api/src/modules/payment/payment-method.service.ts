import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { transactionOptions } from '../../common/db/transaction-options';
import { isUniqueViolation } from '../../common/errors/unique-constraint';
import { PaymentProviderRegistry } from './payment-provider.registry';

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
    // ⚠️ **渠道只从注册表取**（阶段 6a）：未注册 / 未启用 / 生产 devOnly
    // 由注册表统一拒绝，不再直接读 `PAYMENT_PROVIDERS` 这个兼容 Map。
    private readonly registry: PaymentProviderRegistry,
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
    const provider = this.registry.get(channel);

    // ⚠️ **能力门控必须在调用渠道与落库之前**（阶段 6a）：
    // 不支持绑卡的渠道拿不到授权凭证，调下去只会得到一个假 token——
    // 之后自动续费会拿它去扣一笔根本不存在的授权，扣款必然失败。
    if (!provider.capabilities.paymentMethod) {
      throw new ConflictException(
        `当前渠道 ${provider.channel} 不支持绑定支付方式`,
      );
    }

    const { token } = await provider.createPaymentMethod({ type });

    // ⚠️ **清默认 + 写新默认必须在同一个事务里**（审计 P1-5）：
    // 分成两条语句的话，中途失败/并发会让该租户出现「零个默认」
    // 或「两个默认」。
    //
    // ⚠️ **顺序不能反**：先把所有默认的清掉，再插入新的默认。
    // 反过来（先插新的再清旧的）会撞上部分唯一索引
    // `payment_methods_tenant_default_uniq`。
    //
    // ⚠️ **P2002 必须在事务外处理**：唯一约束冲突让事务 aborted，
    // 在事务里 catch 之后继续查会报 `current transaction is aborted`。
    try {
      return await this.prisma.$transaction(async (tx) => {
        // ⚠️ **默认的只有一个**：新绑的这个是默认，之前那个要让位。
        await tx.paymentMethod.updateMany({
          where: { tenantId },
          data: { isDefault: false },
        });

        return tx.paymentMethod.create({
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
      }, transactionOptions());
    } catch (error) {
      if (isUniqueViolation(error)) {
        // 并发绑定时另一个事务抢先把默认位占了 —— 数据库的不变式守住了，
        // 告诉调用方「重试」而不是 500。
        throw new ConflictException('并发绑定冲突，请重试');
      }
      throw error;
    }
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

  /**
   * 解绑支付方式。
   *
   * ⚠️ **用 `deleteMany` 而不是 `delete`**：租户作用域模型上
   * `delete` 的 where 只接受唯一字段，扩展会直接拒绝。
   * ⚠️ 这里是**物理删除**（不是软删）：支付方式不用保留历史 ——
   * 但**核销记录要留**，所以只删 token 所在的这一行。
   *
   * ⚠️ **删掉的是默认卡时，要把剩余的一张提为默认**（审计 P1-5）：
   * 删完之后该租户就**没有默认支付方式**了 —— 自动续费找不到卡
   * （`renewal.service.ts` 取默认卡那一段）会走「等商家手动支付」，
   * 周期一过订阅**静默过期**，商家看不到任何错误。
   *
   * ⚠️ **删与提必须在同一个事务里**：中间失败就留下 0 个默认。
   * ⚠️ **顺序不能反**：先删再提。反过来（先提新的再删旧的）
   * 会撞上部分唯一索引 `payment_methods_tenant_default_uniq`。
   */
  async remove(tenantId: string, id: string): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const target = await tx.paymentMethod.findFirst({
          where: { id, tenantId },
          select: { id: true, isDefault: true },
        });
        // ⚠️ **不存在就什么都不做**（幂等解绑，接口仍返回 200）
        if (!target) return;

        await tx.paymentMethod.deleteMany({ where: { id, tenantId } });

        // ⚠️ **删掉的不是默认卡**：不用提位
        if (!target.isDefault) return;

        // ⚠️ **把剩余卡里最新的一张提为默认**（与 `create` 的
        // 「新绑的成为默认」同一个口径：越晚绑的越优先）
        const next = await tx.paymentMethod.findFirst({
          where: { tenantId },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        });
        if (!next) return;
        await tx.paymentMethod.updateMany({
          where: { id: next.id },
          data: { isDefault: true },
        });
      }, transactionOptions());
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('并发修改冲突，请重试');
      }
      throw error;
    }
  }

  /**
   * 设为默认（默认的只有一个）。
   *
   * ⚠️ **先校验目标存在且属本租户，再清默认**（审计 P1-5）：
   * 原来是「先无条件清空全部默认卡，再置目标为默认」。传一个不存在 /
   * 已被删除 / 属别家租户的 id 时，第二步命中 0 行，
   * 而该租户**一个默认卡都不剩** —— 接口却返回 200「成功」。
   *
   * ⚠️ **校验放在事务里**：事务外先查、事务内再改，中间卡被删掉的话
   * 又会回到「清了却没设上」的老路。抛 404 会让整个事务回滚，
   * 清空的那一步也跟着撤销。
   *
   * ⚠️ **两步写在同一个事务里**，且**顺序不能反**：
   * 先把所有默认的清掉，再把目标那笔置为默认。
   * 反过来（先置新的再清旧的）会把刚设好的那个也清掉。
   *
   * ⚠️ **不变式由数据库兜底**：`payment_methods_tenant_default_uniq`
   * （部分唯一索引）保证同一个租户最多一个默认卡。
   */
  async setDefault(tenantId: string, id: string): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const target = await tx.paymentMethod.findFirst({
          where: { id, tenantId },
          select: { id: true },
        });
        // ⚠️ **不存在或不属于本租户 → 404**：不清空任何默认卡
        if (!target) {
          throw new NotFoundException('支付方式不存在');
        }

        await tx.paymentMethod.updateMany({
          where: { tenantId },
          data: { isDefault: false },
        });
        const affected = await tx.paymentMethod.updateMany({
          where: { id, tenantId },
          data: { isDefault: true },
        });
        // ⚠️ **命中 0 行也要当失败**：说明目标在事务期间被删了，
        // 抛异常让事务回滚 —— 否则会留下「一个默认都没有」的状态。
        if (affected.count === 0) {
          throw new NotFoundException('支付方式不存在');
        }
      }, transactionOptions());
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('并发修改冲突，请重试');
      }
      throw error;
    }
  }
}
