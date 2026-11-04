import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import type { PrismaTransaction } from '../prisma/prisma-transaction';
import { platformScope, tenantContext } from '../tenant/tenant-context';
import {
  isChannelEnabled,
  isDevOnlyChannel,
  isProduction,
  normalizeChannel,
} from '../channel/channel-config';

/**
 * 平台默认出款渠道设置的**唯一读写入口**（阶段 6a Task 4）。
 *
 * ## 为什么放在 `common/platform-settings/`
 *
 * `PayoutProvidersModule`（`@Global()`）里的核实服务要读「平台默认渠道」做兜底。
 * 如果本服务去依赖注册表，就会形成
 * `PayoutProvidersModule → 本模块 → 注册表 → PayoutProvidersModule` 的环，
 * NestJS 启动直接报错。
 *
 * → 本服务**只依赖 `TenancyModule`**，校验渠道用 `channel-config` 的纯环境变量解析
 *   （`isChannelEnabled` / `isProduction`），**绝不 import 注册表或 `common/payment/*`**。
 *
 * ## 存储口径
 *
 * `platform_settings` 表里一行，`key = 'payout.platformDefaultChannel'`，
 * `value = { "channel": "<渠道名>" }`。
 *
 * - 有行 → 用它，且**每次读都重新校验**（渠道可能已被停用）→ 不合法就抛错，**不回落**；
 * - 无行 → 回落 `PAYOUT_PLATFORM_DEFAULT_CHANNEL`（首次部署 / 迁移前）；
 * - 都没有 → 抛中文 409。
 *
 * ⚠️ **不做进程内缓存** —— 多副本下没有可靠的失效机制，缓存会让
 *    「刚在后台改完、打款还在用旧渠道」。
 */

/** 平台默认出款渠道在 `platform_settings` 里的键名 */
export const PAYOUT_DEFAULT_CHANNEL_KEY = 'payout.platformDefaultChannel';

/** 平台默认出款渠道的读取结果 */
export interface PayoutDefaultChannelResult {
  channel: string;
  /** `DATABASE` = 后台配置过；`ENV` = 尚无配置行，来自部署环境变量兜底 */
  source: 'DATABASE' | 'ENV';
}

/**
 * 超管后台展示用的读取结果（阶段 6 审查结论）。
 *
 * ⚠️ **「还没配」不是错误**：设置页要靠一次 GET 才渲染出保存表单，
 *    「还没配」也照抛 409 的话，全新环境里
 *    **页面永远没有保存入口**，只能靠 curl 或手改环境变量。
 *    所以「读当前值」与「执行时必须有值」分成两个方法：
 *    前者返回 `channel: null` + `source: 'NONE'`，后者仍然 fail-closed。
 */
export interface PayoutDefaultChannelDisplay {
  channel: string | null;
  source: 'DATABASE' | 'ENV' | 'NONE';
}

// ⚠️ **devOnly 名单只从 `channel-config` 读**（阶段 6a）。
//
//    本服务不能 import 注册表（会成环），但 `devOnly` 的**权威名单**不在这两个
//    模块里 —— 它在 `common/channel/channel-config.ts`，启动校验读的也是同一份。
//    曾经这里自己抄了一份 `['sandbox','fake-payout']`：新增 devOnly 渠道时
//    必然漏改一处，结果就是「启动校验拒绝、后台却能把它设成生产默认」。

/** 从 `value`（JsonB）里取出渠道名；结构不对返回 `null` */
function readChannelFromValue(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const raw = (value as Record<string, unknown>).channel;
  if (typeof raw !== 'string') {
    return null;
  }
  const normalized = normalizeChannel(raw);
  return normalized.length > 0 ? normalized : null;
}

@Injectable()
export class PlatformSettingService {
  constructor(private readonly prisma: TenantPrismaService) {}

  /**
   * 读「当前平台默认出款渠道」用于**展示**（超管后台设置页）。
   *
   * 顺序：DB 行 → 环境变量兜底 → 都没有则返回 `channel: null`（不算错误）。
   * ⚠️ DB 行的渠道若已停用 / 生产环境是 devOnly → **仍然抛错**：
   *    那是「配置被改坏了」，必须让运营看到并重新设置，不能展示成一个能用的值。
   *
   * @param client 读用的客户端。
   * ⚠️ **事务内必须传 `tx`**：交互事务会独占一条连接，
   *    回调内再用 `this.prisma` 会再借一条 → 小连接池上死等（P2024）。
   *    阶段 10 修的就是这个。
   */
  async readPayoutDefaultChannel(
    client: PrismaTransaction | TenantPrismaService = this.prisma,
  ): Promise<PayoutDefaultChannelDisplay> {
    const row = await tenantContext.run(platformScope(), async () =>
      client.platformSetting.findUnique({
        where: { key: PAYOUT_DEFAULT_CHANNEL_KEY },
      }),
    );

    if (row) {
      const channel = readChannelFromValue(row.value);
      if (!channel) {
        throw new ConflictException(
          '平台默认出款渠道配置已损坏：请在超管后台重新设置。',
        );
      }
      this.assertChannelUsable(
        channel,
        `平台默认出款渠道「${channel}」已停用或仅限非生产环境使用：请登录超管后台重新设置。`,
      );
      return { channel, source: 'DATABASE' };
    }

    const fromEnv = normalizeChannel(
      process.env.PAYOUT_PLATFORM_DEFAULT_CHANNEL ?? '',
    );
    if (fromEnv.length > 0) {
      return { channel: fromEnv, source: 'ENV' };
    }

    return { channel: null, source: 'NONE' };
  }

  /**
   * 读取平台默认出款渠道（**执行路径用**）。
   *
   * 顺序：DB 行 → 环境变量兜底 → 抛中文 409。
   * ⚠️ DB 行的渠道若已停用 / 生产环境是 devOnly → 抛错，**不回落到环境变量**
   *    —— 配置被改坏了就响亮失败，绝不悄悄换一个收款路径。
   *
   * @param client 读用的客户端。
   * ⚠️ **事务内必须传 `tx`**：交互事务会独占一条连接，
   *    回调内再用 `this.prisma` 会再借一条 → 小连接池上死等（P2024）。
   *    阶段 10 修的就是这个。
   */
  async getPayoutDefaultChannel(
    client: PrismaTransaction | TenantPrismaService = this.prisma,
  ): Promise<PayoutDefaultChannelResult> {
    const current = await this.readPayoutDefaultChannel(client);
    if (!current.channel) {
      throw new ConflictException(
        '平台未配置默认出款渠道：请在超管后台设置，或配置环境变量 PAYOUT_PLATFORM_DEFAULT_CHANNEL。',
      );
    }
    // `readPayoutDefaultChannel` 在没有配置时返回 `NONE`；走到这里必然有值。
    return {
      channel: current.channel,
      source: current.source === 'NONE' ? 'ENV' : current.source,
    };
  }

  /**
   * 设置平台默认出款渠道（写库并留痕）。
   *
   * ⚠️ **先校验再写** —— 未启用 / 生产环境 devOnly 的渠道一律拒绝，**不写库**。
   */
  async setPayoutDefaultChannel(
    channel: string,
    operatorId: string,
  ): Promise<{ channel: string; source: 'DATABASE' }> {
    const normalized = normalizeChannel(channel);
    if (normalized.length === 0) {
      throw new BadRequestException('出款渠道不能为空');
    }

    this.assertChannelUsable(
      normalized,
      `出款渠道「${normalized}」未启用或仅限非生产环境使用：无法设为平台默认渠道。`,
    );

    await tenantContext.run(platformScope(), async () => {
      await this.prisma.platformSetting.upsert({
        where: { key: PAYOUT_DEFAULT_CHANNEL_KEY },
        create: {
          key: PAYOUT_DEFAULT_CHANNEL_KEY,
          value: { channel: normalized },
          updatedBy: operatorId,
        },
        update: {
          value: { channel: normalized },
          updatedBy: operatorId,
        },
      });
    });

    return { channel: normalized, source: 'DATABASE' };
  }

  /** 渠道必须「已启用」，且生产环境不能是 devOnly；否则抛中文 409 */
  private assertChannelUsable(channel: string, message: string): void {
    if (!isChannelEnabled('PAYOUT', channel)) {
      throw new ConflictException(message);
    }
    if (isProduction() && isDevOnlyChannel('PAYOUT', channel)) {
      throw new ConflictException(message);
    }
  }
}
