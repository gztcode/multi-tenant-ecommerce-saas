import {
  MINIO_DEFAULTS,
  MINIO_PRODUCTION_REQUIRED_KEYS,
  resolveMinioConfig,
} from './minio-config';
import { KNOWN_PLACEHOLDER_SECRETS } from '../../../common/config/placeholder-secrets';

/**
 * MinIO 配置解析（2026-11）。
 *
 * ⚠️ 生产环境漏配端点/凭据时，旧实现会**静默回落 localhost**：
 *    进程照常启动、健康检查也绿，但每一次上传都指向一台不存在的主机，
 *    故障被推迟到用户点上传时才以 500 暴露。这里把故障提前到启动期。
 */
describe('resolveMinioConfig', () => {
  const productionEnv = {
    NODE_ENV: 'production',
    MINIO_ENDPOINT: 'https://media.example.com',
    MINIO_INTERNAL_ENDPOINT: 'http://minio:9000',
    MINIO_BUCKET: 'prod-media',
    MINIO_ACCESS_KEY: 'prod-access',
    MINIO_SECRET_KEY: 'prod-secret',
  };

  it('生产环境一项都没配 → 抛错，且错误信息列出全部缺失变量', () => {
    let message = '';
    try {
      resolveMinioConfig({ NODE_ENV: 'production' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    for (const key of [
      'MINIO_ENDPOINT',
      'MINIO_INTERNAL_ENDPOINT',
      'MINIO_BUCKET',
      'MINIO_ACCESS_KEY',
      'MINIO_SECRET_KEY',
    ]) {
      expect(message).toContain(key);
    }
  });

  it('生产环境只缺一项 → 抛错，且只点名缺的那一项', () => {
    const env = { ...productionEnv, MINIO_SECRET_KEY: '' };
    expect(() => resolveMinioConfig(env)).toThrow(/MINIO_SECRET_KEY/);
  });

  it('生产环境值等于开发默认值 → 抛错，且列全所有命中的变量名', () => {
    // 这正是 compose 的部署形态：变量「非空」，但每个值都是开发默认值。
    let message = '';
    try {
      resolveMinioConfig({
        NODE_ENV: 'production',
        MINIO_ENDPOINT: MINIO_DEFAULTS.endpoint,
        MINIO_INTERNAL_ENDPOINT: MINIO_DEFAULTS.internalEndpoint,
        MINIO_BUCKET: MINIO_DEFAULTS.bucket,
        MINIO_ACCESS_KEY: MINIO_DEFAULTS.accessKey,
        MINIO_SECRET_KEY: MINIO_DEFAULTS.secretKey,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    for (const key of [
      'MINIO_ENDPOINT',
      'MINIO_INTERNAL_ENDPOINT',
      'MINIO_BUCKET',
      'MINIO_ACCESS_KEY',
      'MINIO_SECRET_KEY',
    ]) {
      expect(message).toContain(key);
    }
    expect(message).toContain('默认值');
    expect(message).not.toContain(MINIO_DEFAULTS.secretKey);
  });

  it('生产环境值是已知占位符 → 抛错并点名变量', () => {
    const placeholder = [...KNOWN_PLACEHOLDER_SECRETS][0];
    expect(() =>
      resolveMinioConfig({ ...productionEnv, MINIO_SECRET_KEY: placeholder }),
    ).toThrow(/MINIO_SECRET_KEY.*占位符|占位符.*MINIO_SECRET_KEY/);
  });

  it.each([
    'http://localhost:9000',
    'http://127.0.0.1:9000',
    'http://0.0.0.0:9000',
  ])('生产环境 endpoint 是回环地址 %s → 抛错', (endpoint) => {
    expect(() =>
      resolveMinioConfig({ ...productionEnv, MINIO_ENDPOINT: endpoint }),
    ).toThrow(/MINIO_ENDPOINT.*回环地址/);
  });

  it('生产环境全部为真实值 → 通过', () => {
    expect(resolveMinioConfig(productionEnv)).toEqual({
      endpoint: 'https://media.example.com',
      internalEndpoint: 'http://minio:9000',
      bucket: 'prod-media',
      accessKey: 'prod-access',
      secretKey: 'prod-secret',
      region: 'us-east-1',
    });
  });

  it('生产必需变量清单与默认值一一对应（防止将来加默认值漏登记）', () => {
    const mapping: Record<string, string> = {
      MINIO_ENDPOINT: MINIO_DEFAULTS.endpoint,
      MINIO_INTERNAL_ENDPOINT: MINIO_DEFAULTS.internalEndpoint,
      MINIO_BUCKET: MINIO_DEFAULTS.bucket,
      MINIO_ACCESS_KEY: MINIO_DEFAULTS.accessKey,
      MINIO_SECRET_KEY: MINIO_DEFAULTS.secretKey,
    };
    expect([...MINIO_PRODUCTION_REQUIRED_KEYS].sort()).toEqual(
      Object.keys(mapping).sort(),
    );
  });

  it('开发环境缺变量 → 沿用内置默认值（本地与 e2e 行为不变）', () => {
    expect(resolveMinioConfig({ NODE_ENV: 'development' })).toEqual({
      endpoint: 'http://localhost:19000',
      internalEndpoint: 'http://localhost:19000',
      bucket: 'ecommerce-media',
      accessKey: 'ecommerce',
      secretKey: 'ecommerce-minio-secret',
      region: 'us-east-1',
    });
  });

  it('NODE_ENV 未设置（jest/CI 默认）→ 沿用内置默认值', () => {
    expect(resolveMinioConfig({}).endpoint).toBe('http://localhost:19000');
  });

  it('开发环境显式配置 → 覆盖对应默认值', () => {
    expect(
      resolveMinioConfig({
        MINIO_ENDPOINT: 'http://127.0.0.1:19000',
        MINIO_BUCKET: 'dev-bucket',
      }),
    ).toEqual({
      endpoint: 'http://127.0.0.1:19000',
      internalEndpoint: 'http://localhost:19000',
      bucket: 'dev-bucket',
      accessKey: 'ecommerce',
      secretKey: 'ecommerce-minio-secret',
      region: 'us-east-1',
    });
  });
});
