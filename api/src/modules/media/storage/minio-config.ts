/**
 * MinIO 连接配置解析。
 *
 * ⚠️ **为什么单独抽出来**：旧实现在 `MinioService.onModuleInit` 里逐项
 *    `?? 默认值` 兜底，生产漏配时进程照常启动——上传却全部指向
 *    `localhost:19000`，故障被推迟到用户第一次上传才以 500 暴露。
 *    这里把「生产必须显式配置」变成启动期硬失败，并且**一次性列出全部缺失项**，
 *    避免运维改一项、重启、再看到下一项。
 */

export interface MinioConfig {
  /** 签发 presigned URL 用，必须是浏览器可达的地址 */
  endpoint: string;
  /** 后端自己 HEAD / 删除对象用，容器内地址 */
  internalEndpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string;
}

/** 非生产环境的兜底值（本地开发与 e2e 用） */
const DEFAULTS: MinioConfig = {
  endpoint: 'http://localhost:19000',
  internalEndpoint: 'http://localhost:19000',
  bucket: 'ecommerce-media',
  accessKey: 'ecommerce',
  secretKey: 'ecommerce-minio-secret',
  region: 'us-east-1',
};

/** 导出给测试与其他模块复用，避免默认值出现第二份 */
export const MINIO_DEFAULT_BUCKET = DEFAULTS.bucket;

/** 生产环境**必须**显式提供的变量（bucket 保持默认：写错 bucket 会在启动探测时报错） */
const PRODUCTION_REQUIRED_KEYS = [
  'MINIO_ENDPOINT',
  'MINIO_INTERNAL_ENDPOINT',
  'MINIO_ACCESS_KEY',
  'MINIO_SECRET_KEY',
] as const;

type EnvLike = Record<string, string | undefined>;

function read(env: EnvLike, key: string): string | undefined {
  const value = env[key];
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}

/**
 * 解析 MinIO 配置。
 *
 * - 生产环境：`MINIO_ENDPOINT` / `MINIO_INTERNAL_ENDPOINT` /
 *   `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` 缺任意一项即抛错，
 *   错误信息列出**全部**缺失项。
 * - 非生产环境：缺失项沿用默认值，行为与旧实现一致。
 */
export function resolveMinioConfig(env: EnvLike = process.env): MinioConfig {
  const production = env.NODE_ENV === 'production';

  if (production) {
    const missing = PRODUCTION_REQUIRED_KEYS.filter((key) => !read(env, key));
    if (missing.length > 0) {
      throw new Error(
        `生产环境缺少必需的 MinIO 配置：${missing.join('、')}。` +
          '请在生产部署环境（infra/.env）显式设置这些变量；' +
          '不允许回落到本机开发默认值 localhost:19000 / 默认凭据。',
      );
    }
  }

  return {
    endpoint: read(env, 'MINIO_ENDPOINT') ?? DEFAULTS.endpoint,
    internalEndpoint:
      read(env, 'MINIO_INTERNAL_ENDPOINT') ?? DEFAULTS.internalEndpoint,
    bucket: read(env, 'MINIO_BUCKET') ?? DEFAULTS.bucket,
    accessKey: read(env, 'MINIO_ACCESS_KEY') ?? DEFAULTS.accessKey,
    secretKey: read(env, 'MINIO_SECRET_KEY') ?? DEFAULTS.secretKey,
    region: read(env, 'MINIO_REGION') ?? DEFAULTS.region,
  };
}
