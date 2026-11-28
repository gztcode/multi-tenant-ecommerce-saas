/**
 * 种子脚本（`prisma/seed.ts`）的生产护栏。
 *
 * ⚠️ **为什么单独抽成纯函数**：seed.ts 顶层直接连接数据库、失败即
 *    `process.exit`，无法单测。而这里的判定决定了「生产环境会不会被
 *    种出一个口令写在 git 里的超管账号」——是最需要被用例钉住的一段逻辑。
 *    脚本里只调用，不复制判定。
 */

import {
  classifyProductionValue,
  describeProductionValueProblem,
} from './production-value';

/** 种子护栏错误：脚本入口据此只打印一行说明，而不是整段堆栈 */
export class SeedGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedGuardError';
  }
}

/** 种子脚本里需要口令的账号类别 */
export type SeedCredentialKind =
  'platform-admin' | 'demo-merchant' | 'demo-customer';

/** 口令来源，仅用于日志展示——**不打印口令本身** */
export type SeedPasswordSource = 'env' | 'default';

export interface ResolvedSeedPassword {
  password: string;
  source: SeedPasswordSource;
}

interface SeedCredentialSpec {
  /** 读取口令的环境变量名 */
  readonly envKey: string;
  /**
   * 非生产环境的内置默认口令（本地开发与 e2e 用）。
   *
   * ⚠️ 这些值**在 git 里**，等于公开。所以生产环境禁止回落到它们——
   *    见 `resolveSeedPassword` 的生产分支。
   */
  readonly defaultPassword: string;
  /** 报错文案里用的账号说明 */
  readonly accountLabel: string;
}

const SEED_CREDENTIALS: Record<SeedCredentialKind, SeedCredentialSpec> = {
  'platform-admin': {
    envKey: 'SEED_PLATFORM_ADMIN_PASSWORD',
    defaultPassword: 'Admin12345!',
    accountLabel: '平台超管',
  },
  'demo-merchant': {
    envKey: 'SEED_DEMO_MERCHANT_PASSWORD',
    defaultPassword: 'Demo12345!',
    accountLabel: '示例店主',
  },
  'demo-customer': {
    envKey: 'SEED_DEMO_CUSTOMER_PASSWORD',
    defaultPassword: 'Demo12345!',
    accountLabel: '示例消费者',
  },
};

/** 只用到的环境变量子集，便于单测传入普通对象 */
type EnvLike = Record<string, string | undefined>;

/**
 * 解析某个种子账号的口令。
 *
 * - 生产环境：**必须**显式提供对应环境变量，且值不能等于内置默认口令 /
 *   已知占位符（未提供、为空、等于默认值都按缺失处理并抛错，
 *   否则生产库会多出一个口令写在仓库里的账号）。
 * - 非生产环境：未提供则沿用内置默认值，本地与 CI 行为不变。
 */
export function resolveSeedPassword(
  env: EnvLike,
  kind: SeedCredentialKind,
): ResolvedSeedPassword {
  const spec = SEED_CREDENTIALS[kind];
  const raw = env[spec.envKey] ?? '';

  if (env.NODE_ENV === 'production') {
    // ⚠️ 只判非空不够：compose / 运维脚本可能把内置默认口令原样注入，
    //    那与「没配」是同一个后果 —— 仓库里公开的口令能登录生产超管。
    const problem = classifyProductionValue(raw, {
      defaultValue: spec.defaultPassword,
    });
    if (problem !== null) {
      throw new SeedGuardError(
        `生产环境必须显式提供 ${spec.envKey}（${spec.accountLabel}的登录口令）：` +
          `当前值${describeProductionValueProblem(problem)}。` +
          '值等于开发默认值/占位符，等同于未配置；' +
          '生产环境禁止使用种子脚本内置的默认口令（它们在版本库里，等于公开）。',
      );
    }
    return { password: raw, source: 'env' };
  }

  if (raw.trim().length > 0) {
    return { password: raw, source: 'env' };
  }

  return { password: spec.defaultPassword, source: 'default' };
}

/**
 * 生产环境默认**不执行**种子脚本，需显式放行。
 *
 * 理由：种子脚本会创建示例店铺、试用订阅与三个演示账号。生产误跑
 * 不只是多几条脏数据——它还会创建可登录账号（口令即使显式提供，也往往是
 * 运维随手设的弱口令），并且在 stdout 打出账号信息。
 */
export function assertSeedAllowed(env: EnvLike): void {
  if (env.NODE_ENV !== 'production') {
    return;
  }
  if (env.ALLOW_PROD_SEED === 'true') {
    return;
  }
  throw new SeedGuardError(
    '生产环境默认不执行种子脚本。确需在生产初始化数据时，' +
      '请显式设置 ALLOW_PROD_SEED=true 后重跑，并同时提供 ' +
      'SEED_PLATFORM_ADMIN_PASSWORD 等种子口令环境变量。',
  );
}
