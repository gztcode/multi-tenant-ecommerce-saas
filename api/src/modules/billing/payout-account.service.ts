import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import { getTenantContext } from '../../common/tenant/tenant-context';
import { PayoutCipherService } from './payout-cipher.service';

/** 收款账户的对外形状（**账号脱敏**） */
export interface PayoutAccountView {
  accountName: string;
  bankName: string;
  /** 脱敏后的账号：只留尾 4 位 */
  maskedAccountNo: string;
  updatedAt: string;
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
  ) {}

  /**
   * 读当前商家的收款账户（没有就是 null）。
   *
   * ⚠️ **未迁移的行掩码串是空串** —— 迁移 SQL 用 `DEFAULT ''` 加的列，
   *    迁移脚本跑完才有值。**这是预期的**。
   * ⚠️ **不要在这里解密兜底** —— 那等于把加密悄悄关掉。
   */
  async get(): Promise<PayoutAccountView | null> {
    const context = getTenantContext();
    const tenantId = context.tenantId;
    if (!tenantId) {
      throw new NotFoundException('缺少租户上下文');
    }
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
  }): Promise<PayoutAccountView> {
    const context = getTenantContext();
    const tenantId = context.tenantId;
    if (!tenantId) {
      throw new NotFoundException('缺少租户上下文');
    }

    const accountNo = input.accountNo?.trim() ?? '';

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
      },
    });
    return this.toView(created);
  }

  /** 单条记录 → 对外字段（账号脱敏） */
  private toView(account: {
    accountName: string;
    bankName: string;
    maskedAccountNo: string;
    updatedAt: Date;
  }): PayoutAccountView {
    return {
      accountName: account.accountName,
      bankName: account.bankName,
      // ⚠️ **直接用库里存的掩码串，不解密** ——
      //    展示路径一旦解密，X14（响应永不含完整账号）就有洞了。
      maskedAccountNo: account.maskedAccountNo,
      updatedAt: account.updatedAt.toISOString(),
    };
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
