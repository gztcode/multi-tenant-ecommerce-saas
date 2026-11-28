import { assertSeedAllowed, resolveSeedPassword } from './seed-guard';
import { KNOWN_PLACEHOLDER_SECRETS } from './placeholder-secrets';

/**
 * 种子脚本的生产护栏（2026-11）。
 *
 * ⚠️ 这些用例存在的意义：seed.ts 会在生产误跑时创建**已知口令**的超管账号。
 *    护栏一旦被摘掉，生产库就会多出一个任何人都能登录的后门账号。
 */
describe('resolveSeedPassword', () => {
  it('生产环境未设置口令 → 抛错，且错误信息点名变量', () => {
    expect(() =>
      resolveSeedPassword({ NODE_ENV: 'production' }, 'platform-admin'),
    ).toThrow(/SEED_PLATFORM_ADMIN_PASSWORD/);
  });

  it('生产环境口令为空串 → 抛错（空串等同未设置）', () => {
    expect(() =>
      resolveSeedPassword(
        { NODE_ENV: 'production', SEED_PLATFORM_ADMIN_PASSWORD: '   ' },
        'platform-admin',
      ),
    ).toThrow(/SEED_PLATFORM_ADMIN_PASSWORD/);
  });

  it('生产环境显式提供口令 → 采用环境变量值', () => {
    expect(
      resolveSeedPassword(
        { NODE_ENV: 'production', SEED_PLATFORM_ADMIN_PASSWORD: 'prod-口令-1' },
        'platform-admin',
      ),
    ).toEqual({ password: 'prod-口令-1', source: 'env' });
  });

  it('生产环境口令等于内置默认口令 → 按缺失处理并抛错', () => {
    // 先拿到非生产环境的默认口令，再原样喂回生产分支。
    const { password: builtinDefault } = resolveSeedPassword(
      {},
      'platform-admin',
    );

    expect(() =>
      resolveSeedPassword(
        {
          NODE_ENV: 'production',
          SEED_PLATFORM_ADMIN_PASSWORD: builtinDefault,
        },
        'platform-admin',
      ),
    ).toThrow(/SEED_PLATFORM_ADMIN_PASSWORD.*(默认|等同)/);
  });

  it('生产环境口令是已知占位符 → 按缺失处理并抛错', () => {
    const placeholder = [...KNOWN_PLACEHOLDER_SECRETS][0];

    expect(() =>
      resolveSeedPassword(
        { NODE_ENV: 'production', SEED_PLATFORM_ADMIN_PASSWORD: placeholder },
        'platform-admin',
      ),
    ).toThrow(/SEED_PLATFORM_ADMIN_PASSWORD.*占位符/);
  });

  it('非生产环境口令正好等于内置默认值 → 仍视为显式配置（行为不变）', () => {
    const { password: builtinDefault } = resolveSeedPassword(
      {},
      'platform-admin',
    );

    expect(
      resolveSeedPassword(
        {
          NODE_ENV: 'development',
          SEED_PLATFORM_ADMIN_PASSWORD: builtinDefault,
        },
        'platform-admin',
      ),
    ).toEqual({ password: builtinDefault, source: 'env' });
  });

  it('开发环境未设置口令 → 沿用内置默认值', () => {
    const resolved = resolveSeedPassword(
      { NODE_ENV: 'development' },
      'platform-admin',
    );
    expect(resolved.source).toBe('default');
    expect(resolved.password.length).toBeGreaterThan(0);
  });

  it('NODE_ENV 未设置（jest/CI 默认）→ 沿用内置默认值', () => {
    expect(resolveSeedPassword({}, 'demo-customer').source).toBe('default');
  });

  it('示例消费者口令同样受生产护栏保护', () => {
    expect(() =>
      resolveSeedPassword({ NODE_ENV: 'production' }, 'demo-customer'),
    ).toThrow(/SEED_DEMO_CUSTOMER_PASSWORD/);
  });

  it('示例店主口令同样受生产护栏保护', () => {
    expect(() =>
      resolveSeedPassword({ NODE_ENV: 'production' }, 'demo-merchant'),
    ).toThrow(/SEED_DEMO_MERCHANT_PASSWORD/);
  });

  it('开发环境显式提供口令 → 采用环境变量值且来源标为 env', () => {
    expect(
      resolveSeedPassword(
        { NODE_ENV: 'development', SEED_DEMO_CUSTOMER_PASSWORD: 'dev-口令' },
        'demo-customer',
      ),
    ).toEqual({ password: 'dev-口令', source: 'env' });
  });
});

describe('assertSeedAllowed', () => {
  it('生产环境未设置 ALLOW_PROD_SEED → 拒绝执行，错误信息点名开关', () => {
    expect(() => assertSeedAllowed({ NODE_ENV: 'production' })).toThrow(
      /ALLOW_PROD_SEED/,
    );
  });

  it('生产环境 ALLOW_PROD_SEED 不是 true → 仍然拒绝', () => {
    expect(() =>
      assertSeedAllowed({ NODE_ENV: 'production', ALLOW_PROD_SEED: '1' }),
    ).toThrow(/ALLOW_PROD_SEED/);
  });

  it('生产环境显式 ALLOW_PROD_SEED=true → 放行', () => {
    expect(() =>
      assertSeedAllowed({ NODE_ENV: 'production', ALLOW_PROD_SEED: 'true' }),
    ).not.toThrow();
  });

  it('非生产环境一律放行', () => {
    expect(() => assertSeedAllowed({ NODE_ENV: 'development' })).not.toThrow();
    expect(() => assertSeedAllowed({})).not.toThrow();
  });
});
