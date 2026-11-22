/**
 * 假网关转发的护栏测试（`storefront/next.config.ts`）。
 *
 * 背景：支付中转返回的 payUrl 是**根相对**路径 `/api/v1/pay/fake/:paymentId`。
 * 生产形态由 nginx 的 `location /api/v1/` 转给 api；但本机 dev 与 CI 的
 * browser e2e 前面没有网关，请求会落到 storefront 自己身上 —— 缺了这条
 * rewrite 就是 Next 404，`golden-path.spec.ts` 因此红过。
 *
 * 这里钉住四件事：
 * 1. 非生产下确实生成 rewrite，且**只匹配假网关路径**（不是通用 API 后门）；
 * 2. destination 在**调用时**读 `API_BASE_URL`，不固化在模块加载时；
 * 3. `API_BASE_URL` 缺失时显式兜底，绝不拼出 `undefined`；
 * 4. 生产构建里不生成（standalone 产物不需要它，构建机也可能没有该变量）。
 *
 * 故意改坏 destination（硬编码错误地址 / 丢掉 `:path*`）都会让本文件变红。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

type Rewrite = { source: string; destination: string };
type RewritesFn = () => Promise<Rewrite[]>;

const DEFAULT_BASE = 'http://localhost:3000/api/v1';

/** 用指定的 NODE_ENV 重新加载配置模块（模块顶层按 NODE_ENV 决定是否挂 rewrites） */
async function loadConfig(nodeEnv: string) {
  vi.stubEnv('NODE_ENV', nodeEnv);
  vi.resetModules();
  const mod = await import('../../next.config');
  return mod.default;
}

/** 取出 rewrites 的结果；同时断言这个环境下确实挂了 rewrites */
async function readRewrites(config: { rewrites?: unknown }): Promise<Rewrite[]> {
  expect(typeof config.rewrites).toBe('function');
  return (config.rewrites as RewritesFn)();
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('next.config 假网关转发（dev / e2e 的网关替身）', () => {
  it('非生产下生成 rewrite，且只匹配假网关路径', async () => {
    vi.stubEnv('API_BASE_URL', 'http://localhost:3100/api/v1');

    const config = await loadConfig('development');
    const list = await readRewrites(config);

    // `toEqual` 完整比对：多出任何一条（尤其是通用的 `/api/v1/:path*`）
    // 都会变红 —— 那会把 storefront 变成绕过 BFF 白名单的 API 后门。
    expect(list).toEqual([
      {
        source: '/api/v1/pay/fake/:path*',
        destination: 'http://localhost:3100/api/v1/pay/fake/:path*',
      },
    ]);
  });

  it('destination 在调用时读 API_BASE_URL（不固化在模块加载时）', async () => {
    vi.stubEnv('API_BASE_URL', 'http://first:3000/api/v1');
    const config = await loadConfig('test');

    const first = await readRewrites(config);
    expect(first[0].destination).toBe(
      'http://first:3000/api/v1/pay/fake/:path*',
    );

    // 不重新 import 模块，只改环境变量：destination 必须跟着变。
    vi.stubEnv('API_BASE_URL', 'http://second:3100/api/v1');
    const second = await readRewrites(config);
    expect(second[0].destination).toBe(
      'http://second:3100/api/v1/pay/fake/:path*',
    );
  });

  it('API_BASE_URL 缺失时显式兜底，不拼出 undefined', async () => {
    vi.stubEnv('API_BASE_URL', undefined);

    const config = await loadConfig('development');
    const list = await readRewrites(config);

    expect(list[0].destination).toBe(`${DEFAULT_BASE}/pay/fake/:path*`);
    expect(list[0].destination).not.toContain('undefined');
  });

  it('API_BASE_URL 带尾斜杠时不产生 //pay/fake', async () => {
    vi.stubEnv('API_BASE_URL', 'http://api:3000/api/v1/');

    const config = await loadConfig('development');
    const list = await readRewrites(config);

    expect(list[0].destination).toBe(
      'http://api:3000/api/v1/pay/fake/:path*',
    );
  });

  it('destination 保留 :path* 通配，假网关表单的 /confirm 子路径才能转发', async () => {
    vi.stubEnv('API_BASE_URL', 'http://api:3000/api/v1');

    const config = await loadConfig('development');
    const list = await readRewrites(config);

    // 假网关页面的表单 action 是 `/api/v1/pay/fake/:id/confirm`；
    // 丢掉 `:path*` 只会转发两级路径，confirm 提交就 404。
    expect(list[0].destination.endsWith('/pay/fake/:path*')).toBe(true);
    expect(list[0].source.endsWith('/pay/fake/:path*')).toBe(true);
  });

  it('生产构建下不生成这条 rewrite', async () => {
    vi.stubEnv('API_BASE_URL', 'http://api:3000/api/v1');

    const config = await loadConfig('production');

    // 生产由 nginx 承担转发；standalone 产物的 destination 是构建期固化的，
    // 留着只会变成僵尸配置（构建机没有 API_BASE_URL 时还会坏）。
    expect(config.rewrites).toBeUndefined();
  });
});
