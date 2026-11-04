import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { requireTenantId } from '../../common/tenant/require-tenant';
import {
  isChannelEnabled,
  isProduction,
  normalizeChannel,
} from '../../common/channel/channel-config';
import { PayoutProviderRegistry } from '../../common/payment/payout-provider.registry';
import { PlatformSettingService } from '../../common/platform-settings/platform-setting.service';
import { PayoutCipherService } from './payout-cipher.service';

/**
 * 收款账户的对外形状（**账号脱敏**）。
 *
 * ⚠️ **四个渠道字段（阶段 6a Task 5）** 用来让商家看出
 * 「现在用的到底是哪家渠道、是平台配的、还是我自己配的、
 *   以及我配的渠道是不是已经停用了」。
 *   停用**不回落**平台默认 —— 执行时会 fail-closed，所以这里必须可见。
 */
export interface PayoutAccountView {
  accountName: string;
  bankName: string;
  /** 脱敏后的账号：只留尾 4 位 */
  maskedAccountNo: string;
  updatedAt: string;
  /** 商家自己在账户里配的默认渠道；null = 没配（用平台默认） */
  preferredChannel: string | null;
  /** **实际会用的**出款渠道 */
  effectiveChannel: string;
  /** `effectiveChannel` 的来源：`MERCHANT` = 商家配的；`PLATFORM` = 平台默认 */
  effectiveSource: 'MERCHANT' | 'PLATFORM';
  /** 商家配了渠道但该渠道已停用/不可执行 → 执行时 fail-closed，必须重新选择 */
  preferredChannelUnavailable: boolean;
}

/**
 * 商家收款账户的服务层（阶段 5h-1）。
 *
 * ⚠️ **一商家一账户**（`tenantId` 唯一）—— 本阶段不做多账户与默认账户。
 */
@Injectable()
export class PayoutAccountService {
  constructor(
    private readonly prisma: TenantPrismaService,
    private readonly cipher: PayoutCipherService,
    private readonly registry: PayoutProviderRegistry,
    private readonly platformSettings: PlatformSettingService,
  ) {}

  /**
   * 读当前商家的收款账户（没有就是 null）。
   *
   * ⚠️ **未迁移的行掩码串是空串** —— 迁移 SQL 用 `DEFAULT ''` 加的列，
   *    迁移脚本跑完才有值。**这是预期的**。
   * ⚠️ **不要在这里解密兜底** —— 那等于把加密悄悄关掉。
   */
  async get(): Promise<PayoutAccountView | null> {
    requireTenantId();
    // ⚠️ **商家侧的查询不手写 tenantId**：`withMergedWhere` 是
    //    `{...base, ...extra}` → 扩展附的那份会**覆盖**调用方手写的同键值，
    //    手写既不生效也不构成漏洞，只是让人误以为「这里自己保证了隔离」。
    const account = await this.prisma.merchantPayoutAccount.findFirst({
      where: {},
    });
    if (!account) {
      return null;
    }
    return this.toView(account);
  }

  /**
   * 设置当前商家的收款账户（**有则更新、无则新建**）。
   *
   * ⚠️ **用「先查后插」而不是 `upsert`**：`merchant_payout_accounts` 在
   * 租户白名单里，租户扩展对白名单模型**直接拒绝** `upsert`
   * （它的 where 只接受唯一字段，无法附加 tenantId 条件）。
   *
   * ⚠️ **`accountNo` 在更新时可空，在新建时必填**：
   *    后端只把**脱敏值**返回给商家（`maskedAccountNo`），商家改个开户人
   *    姓名时并没有原账号可填 → 账号留空表示「不修改这一项」。
   *    但**第一次设置时必须给账号** —— 没有账号不知道钱打给谁。
   */
  async set(input: {
    accountName: string;
    bankName: string;
    accountNo?: string;
    /** 不传 = 不修改；空串 = 清除配置（改用平台默认） */
    preferredChannel?: string;
  }): Promise<PayoutAccountView> {
    const tenantId = requireTenantId();

    const accountNo = input.accountNo?.trim() ?? '';

    // ⚠️ **先校验再写库**：不合法渠道一律 400，且不落任何数据。
    //    `undefined` = 不修改；`''` = 清除（写 null）。
    const preferredChannel = input.preferredChannel?.trim();
    if (preferredChannel) {
      this.assertChannelUsable(preferredChannel);
    }
    // ⚠️ **落库用归一化后的渠道名**（注册表按小写索引）：
    //    存 `Fake-Payout` 会通过上面的校验，但执行时 `get()` 才归一化 ——
    //    库里的值与实际用的渠道名不一致，排查时很难看出是同一个渠道。
    const storedPreferredChannel = preferredChannel
      ? normalizeChannel(preferredChannel)
      : preferredChannel;

    const existing = await this.prisma.merchantPayoutAccount.findFirst({
      where: {},
      select: { id: true },
    });

    if (existing) {
      const updated = await this.prisma.merchantPayoutAccount.updateMany({
        where: { id: existing.id },
        data: {
          accountName: input.accountName,
          bankName: input.bankName,
          // ⚠️ **`accountNo` 为空时不带这个键**：
          //    Prisma 的 `undefined` = 不更新该字段 → 保留原账号。
          //    写成空串会把账号**清掉** —— 钱就不知道打给谁了。
          ...(accountNo
            ? {
                accountNoCipher: this.cipher.encrypt(accountNo),
                maskedAccountNo: maskAccountNo(accountNo),
                encryptionVersion: 1,
              }
            : {}),
          // ⚠️ **`preferredChannel` 的三种语义**（与 `accountNo` 同款「键在不在」）：
          //    不传 → 键不出现 = 保留原值；空串 → 写 null = 清除；
          //    有值 → 写归一化后的渠道名。
          ...(preferredChannel === undefined
            ? {}
            : { preferredChannel: storedPreferredChannel || null }),
        },
      });
      if (updated.count === 0) {
        throw new NotFoundException('收款账户不存在');
      }
      const account = await this.prisma.merchantPayoutAccount.findFirst({
        where: {},
      });
      if (!account) {
        throw new NotFoundException('收款账户不存在');
      }
      return this.toView(account);
    }

    if (!accountNo) {
      throw new BadRequestException('首次设置收款账户时必须填写银行账号');
    }

    const created = await this.prisma.merchantPayoutAccount.create({
      data: {
        tenantId,
        accountName: input.accountName,
        bankName: input.bankName,
        // ⚠️ **账号落库即密文** —— 库里不该再有完整账号的明文副本。
        accountNoCipher: this.cipher.encrypt(accountNo),
        // ⚠️ **掩码串单独存**：密文长度 ≠ 明文长度，
        //    而掩码要按明文长度打星 → 不解密就还原不出掩码。
        maskedAccountNo: maskAccountNo(accountNo),
        encryptionVersion: 1,
        preferredChannel: storedPreferredChannel || null,
      },
    });
    return this.toView(created);
  }

  /** 单条记录 → 对外字段（账号脱敏 + 默认渠道解析） */
  private async toView(account: {
    accountName: string;
    bankName: string;
    maskedAccountNo: string;
    updatedAt: Date;
    preferredChannel?: string | null;
  }): Promise<PayoutAccountView> {
    return {
      accountName: account.accountName,
      bankName: account.bankName,
      // ⚠️ **直接用库里存的掩码串，不解密** ——
      //    展示路径一旦解密，X14（响应永不含完整账号）就有洞了。
      maskedAccountNo: account.maskedAccountNo,
      updatedAt: account.updatedAt.toISOString(),
      ...(await this.resolveEffectiveChannel(account.preferredChannel ?? null)),
    };
  }

  /**
   * 解析「最终会用哪个渠道」（设计 §4.4）。
   *
   * 1. 商家配了且仍可用 → 用商家值，来源 `MERCHANT`；
   * 2. 商家配了但已停用 → **仍显示商家值**，`unavailable = true`
   *    （执行时 fail-closed，**不静默切平台默认** —— 钱打到哪家必须确定）；
   * 3. 商家没配 → 平台默认，来源 `PLATFORM`。
   *
   * ⚠️ **平台也没配时 `getPayoutDefaultChannel()` 会抛 409**：
   *    商家账户页不该被一个「平台还没设置」搞成整页 500，
   *    所以这里兜底成 `effectiveChannel: ''` + `unavailable: true`，
   *    页面据此提示「平台尚未配置默认渠道」。
   *    其它异常（连库失败等）照常抛出 —— 那不是可预期的配置状态。
   */
  private async resolveEffectiveChannel(
    preferredChannel: string | null,
  ): Promise<
    Pick<
      PayoutAccountView,
      | 'preferredChannel'
      | 'effectiveChannel'
      | 'effectiveSource'
      | 'preferredChannelUnavailable'
    >
  > {
    if (preferredChannel) {
      return {
        preferredChannel,
        effectiveChannel: preferredChannel,
        effectiveSource: 'MERCHANT',
        preferredChannelUnavailable: !this.isChannelUsable(preferredChannel),
      };
    }

    try {
      const platform = await this.platformSettings.getPayoutDefaultChannel();
      return {
        preferredChannel: null,
        effectiveChannel: platform.channel,
        effectiveSource: 'PLATFORM',
        preferredChannelUnavailable: false,
      };
    } catch (cause) {
      if (cause instanceof ConflictException) {
        return {
          preferredChannel: null,
          effectiveChannel: '',
          effectiveSource: 'PLATFORM',
          preferredChannelUnavailable: true,
        };
      }
      throw cause;
    }
  }

  /**
   * 渠道「能不能真的用」：已注册 + 已启用 + （生产环境）非 devOnly。
   *
   * ⚠️ **与注册表 `get()` 的三步校验保持一致**：这里只是不抛异常，
   *    用来给页面做可执行性判断；真正执行仍走注册表。
   */
  private isChannelUsable(channel: string): boolean {
    const normalized = normalizeChannel(channel);
    const descriptor = this.registry.descriptor(normalized);
    return (
      descriptor !== null &&
      isChannelEnabled('PAYOUT', normalized) &&
      !(isProduction() && descriptor.devOnly)
    );
  }

  /** 写入前校验默认渠道；不合法抛中文 400 并点名渠道 */
  private assertChannelUsable(channel: string): void {
    if (!this.isChannelUsable(channel)) {
      throw new BadRequestException(
        `出款渠道「${channel}」未启用或仅限非生产环境使用：请重新选择默认出款渠道。`,
      );
    }
  }
}

/**
 * 账号脱敏：只留尾 4 位。
 *
 * ⚠️ **至少 4 位才脱敏**：账号短于 8 位时全打码 —— 短账号很容易被猜出来。
 */
export function maskAccountNo(accountNo: string): string {
  if (accountNo.length <= 8) {
    return '*'.repeat(accountNo.length);
  }
  return `${'*'.repeat(accountNo.length - 4)}${accountNo.slice(-4)}`;
}
