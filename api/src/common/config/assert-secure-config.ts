import {
  enabledChannels,
  isDevOnlyChannel,
  isProduction,
  normalizeChannel,
} from '../channel/channel-config';
import type { ChannelKind } from '../channel/channel.types';
import { isPlaceholderSecret } from './placeholder-secrets';

/** 参与启动校验的两个渠道用途（顺序即报错优先级） */
const KNOWN_KINDS: readonly ChannelKind[] = ['PAYMENT', 'PAYOUT'];

/**
 * 当前代码里**已经部署了实现**的渠道（阶段 6a）。
 *
 * ⚠️ **这份名单是「实现存在性」的启动校验**，
 *    与注册表（`PaymentProviderRegistry` / `PayoutProviderRegistry`）
 *    里真正注册了哪些 provider 是**两件事**：
 *    - 注册表在**运行时**按「渠道名 → provider」解析；
 *    - 这里在**启动时**按「渠道名 → 实现是否存在」拒绝，
 *      让「拼错了渠道名」在进程起来之前就暴露，
 *      而不是等到第一笔支付/出款走到注册表才 409。
 *
 * ⚠️ **新增渠道（含 6b 引入 `sandbox`）时必须同步登记** ——
 *    漏登记会让 `PAYMENT_ENABLED_CHANNELS=sandbox` 这种配置
 *    在启动校验这关就被当成「未部署实现」拦掉。
 * ⚠️ **登记 ≠ 生产可用**：`sandbox` 同时在 `DEV_ONLY_CHANNELS` 里，
 *    生产环境启用它仍会被下面的 devOnly 断言拒绝启动。
 */
const KNOWN_CHANNELS: Record<ChannelKind, string[]> = {
  PAYMENT: ['fake', 'sandbox'],
  PAYOUT: ['fake-payout', 'sandbox'],
};

/**
 * 当前**唯一合法**的 `CHANNEL_MODE` 取值。
 *
 * ⚠️ 阶段 6b 接入沙箱渠道（真实渠道）之前只此一个值；
 *    届时新增取值要同时改这里与 `CHANNEL_MODE` 的报错文案。
 */
const CHANNEL_MODE_ALLOWED = ['sandbox'] as const;

/** 用途 → 启用列表的环境变量名（与 `common/channel/channel-config.ts` 对齐） */
const ENABLED_ENV_KEY: Record<ChannelKind, string> = {
  PAYMENT: 'PAYMENT_ENABLED_CHANNELS',
  PAYOUT: 'PAYOUT_ENABLED_CHANNELS',
};

/**
 * 启动时的配置安全断言。
 *
 * `JWT_SECRET` 的占位符长度（46 字节）远超 HS256 要求的 256 bit，argon2 与
 * Prisma 都不会对它报错——但它「看起来像一个合理的值」，没有任何机制阻止它被
 * 原样带进生产。一旦泄露，任何人都能用它自行签发任意租户、任意角色的令牌。
 * 因此必须在创建 Nest 应用**之前**硬失败：那时还没有任何连接与监听，
 * 不会留下半启动的进程。
 */
export function assertSecureConfig(): void {
  // ⚠️ **顺序有意义**：沿用「JWT → 假网关开关 → 渠道配置」的既有顺序。
  //
  //    两个既有断言在前，是因为它们的报错文案已经被验收用例与运维手册引用
  //    （例如「生产配置下假支付网关不可用」断言文案必须含 `FAKE_PAYMENT_ENABLED`）。
  //    渠道配置是阶段 6a 新增的最后一道，放在最后不会改变任何一个既有报错的
  //    优先级 —— 三种都是**启动期硬失败**，先后顺序只影响「先看到哪一条」。
  assertJwtSecret();
  assertFakeToggles();
  assertChannelConfig();
}

function assertJwtSecret(): void {
  const secret = process.env.JWT_SECRET ?? '';

  if (secret.length < 32) {
    throw new Error(
      `JWT_SECRET 至少需要 32 个字符，当前只有 ${secret.length} 个。` +
        '请设置一个足够随机的密钥（可用 `openssl rand -base64 48` 生成）。',
    );
  }

  if (process.env.NODE_ENV === 'production' && isPlaceholderSecret(secret)) {
    throw new Error(
      '生产环境禁止使用示例/默认的 JWT_SECRET 占位符（含 docker-compose 内置默认值），请换成真实密钥。',
    );
  }
}

function assertFakeToggles(): void {
  // ⚠️ 假支付网关在生产环境开启 = 任何人知道 paymentId 就能免费下单（R3）。
  //
  // 假网关的支付页面**无需登录**——知道 paymentId 就能把订单付掉。
  // 所以这个开关在生产环境必须**拒绝启动**，而不是「配错了就那样吧」。
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.FAKE_PAYMENT_ENABLED === 'true'
  ) {
    throw new Error(
      '生产环境禁止启用 FAKE_PAYMENT_ENABLED：假支付网关无需登录即可支付订单。',
    );
  }

  // ⚠️ 假出款网关在生产环境开启 = 平台能让「打款失败」（阶段 5h-2）。
  //
  // 与假支付网关**分成两条**：用同一个开关的话，开着假支付就等于
  // 同时开着假出款，两个环境的启停会互相牵连。
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.FAKE_PAYOUT_ENABLED === 'true'
  ) {
    throw new Error(
      '生产环境禁止启用 FAKE_PAYOUT_ENABLED：假出款网关能让出款失败。',
    );
  }
}

/**
 * 渠道配置校验（阶段 6a）。
 *
 * ⚠️ **「哪些渠道启用」必须复用 `common/channel/channel-config.ts`**，
 *    不能在这里自己再解析一遍环境变量 ——
 *    两处判断漂移会让「启动校验放行」与「注册表实际能用」对不上。
 */
function assertChannelConfig(): void {
  const production = isProduction();

  // ① CHANNEL_MODE：只允许 `sandbox`，非空且不合法时**显式报错**，
  //    不让拼写错误（如 `sandBox` / `live`）被静默当成「没配」。
  const channelMode = (process.env.CHANNEL_MODE ?? '').trim();
  if (channelMode.length > 0) {
    const allowed = CHANNEL_MODE_ALLOWED.join(' / ');
    if (
      !CHANNEL_MODE_ALLOWED.includes(
        channelMode as (typeof CHANNEL_MODE_ALLOWED)[number],
      )
    ) {
      throw new Error(
        `CHANNEL_MODE 的取值 ${channelMode} 不合法，允许的取值为：${allowed}。`,
      );
    }
    if (production && channelMode === 'sandbox') {
      throw new Error(
        '生产环境禁止使用 CHANNEL_MODE=sandbox：沙箱渠道不允许接入生产流量。',
      );
    }
  }

  // ② 启用列表：逐用途校验（生产环境 fail-closed；非生产由 channel-config 回落 fake）
  const enabledByKind: Record<ChannelKind, string[]> = {
    PAYMENT: enabledChannels('PAYMENT'),
    PAYOUT: enabledChannels('PAYOUT'),
  };

  //  先查「有没有实现」，再查「生产能不能用」——
  //  否则 PAYMENT 配错会掩盖 PAYOUT 配错，报错跟着变量声明顺序跑。
  for (const kind of KNOWN_KINDS) {
    const envKey = ENABLED_ENV_KEY[kind];
    for (const channel of enabledByKind[kind]) {
      // 未部署实现 → 启动期点名变量与渠道名，
      //    而不是等到运行时注册表才 409。
      if (!KNOWN_CHANNELS[kind].includes(channel)) {
        throw new Error(
          `${envKey} 里的渠道 ${channel} 没有已部署的实现。` +
            `已登记的 ${kind} 渠道：${KNOWN_CHANNELS[kind].join('、')}。`,
        );
      }
    }
  }

  if (production) {
    for (const kind of KNOWN_KINDS) {
      const envKey = ENABLED_ENV_KEY[kind];
      for (const channel of enabledByKind[kind]) {
        // ⚠️ devOnly 名单的**单一事实来源**在 `common/channel/channel-config.ts`
        //    （平台设置服务读的是同一份）—— 这里不要再复制一份。
        if (isDevOnlyChannel(kind, channel)) {
          throw new Error(
            `生产环境禁止启用 ${envKey}=${channel}：该渠道仅限非生产环境使用。`,
          );
        }
      }
    }
  }

  // ③ 平台默认出款渠道：若设置，必须在出款启用列表内。
  //    生产环境**允许不设**——由平台后台 `platform_settings` 配置。
  const defaultChannel = normalizeChannel(
    process.env.PAYOUT_PLATFORM_DEFAULT_CHANNEL ?? '',
  );
  if (defaultChannel.length > 0) {
    const payoutEnabled = enabledByKind.PAYOUT;
    if (!payoutEnabled.includes(defaultChannel)) {
      throw new Error(
        `PAYOUT_PLATFORM_DEFAULT_CHANNEL=${defaultChannel} 不在出款渠道启用列表内，` +
          `请检查 PAYOUT_ENABLED_CHANNELS。`,
      );
    }
  }
}
