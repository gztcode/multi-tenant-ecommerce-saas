/**
 * MinIO 连接配置解析。
 *
 * ⚠️ **为什么单独抽出来**：旧实现在 `MinioService.onModuleInit` 里逐项
 *    `?? 默认值` 兜底，生产漏配时进程照常启动——上传却全部指向
 *    `localhost:19000`，故障被推迟到用户第一次上传才以 500 暴露。
 *    这里把「生产必须显式配置」变成启动期硬失败，并且**一次性列出全部缺失项**，
 *    避免运维改一项、重启、再看到下一项。
 *
 * ⚠️ **只判「非空」不够**：compose 里这些键都写成 `${VAR:-开发默认值}`，
 *    变量永远非空。生产环境必须把「值等于开发默认值 / 占位符 / 回环地址」
 *    与「未配置」等价处理，否则护栏在真实部署形态下永不触发。
 */

import {
  classifyProductionValue,
  describeProductionValueProblem,
} from '../../../common/config/production-value';

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
export const MINIO_DEFAULTS: Readonly<MinioConfig> = {
  endpoint: 'http://localhost:19000',
  internalEndpoint: 'http://localhost:19000',
  bucket: 'ecommerce-media',
  accessKey: 'ecommerce',
  secretKey: 'ecommerce-minio-secret',
  region: 'us-east-1',
};

/** 导出给测试与其他模块复用，避免默认值出现第二份 */
export const MINIO_DEFAULT_BUCKET = MINIO_DEFAULTS.bucket;

/**
 * 生产环境**必须**显式提供、且不能等于开发默认值的变量。
 *
 * 这份清单就是 `MINIO_DEFAULTS` 里除 `region` 外的全部键：
 * region 有合理通用默认值（`us-east-1`），不构成部署错误。
 */
export const MINIO_PRODUCTION_REQUIRED_KEYS = [
  'MINIO_ENDPOINT',
  'MINIO_INTERNAL_ENDPOINT',
  'MINIO_BUCKET',
  'MINIO_ACCESS_KEY',
  'MINIO_SECRET_KEY',
] as const;

interface ProductionKeySpec {
  readonly key: (typeof MINIO_PRODUCTION_REQUIRED_KEYS)[number];
  readonly defaultValue: string;
  readonly rejectLoopback?: boolean;
}

/** 每个生产必需键对应的开发默认值；endpoint 额外拒绝回环地址 */
const PRODUCTION_KEY_SPECS: readonly ProductionKeySpec[] = [
  {
    key: 'MINIO_ENDPOINT',
    defaultValue: MINIO_DEFAULTS.endpoint,
    rejectLoopback: true,
  },
  {
    key: 'MINIO_INTERNAL_ENDPOINT',
    defaultValue: MINIO_DEFAULTS.internalEndpoint,
    rejectLoopback: true,
  },
  { key: 'MINIO_BUCKET', defaultValue: MINIO_DEFAULTS.bucket },
  { key: 'MINIO_ACCESS_KEY', defaultValue: MINIO_DEFAULTS.accessKey },
  { key: 'MINIO_SECRET_KEY', defaultValue: MINIO_DEFAULTS.secretKey },
];

type EnvLike = Record<string, string | undefined>;

function read(env: EnvLike, key: string): string | undefined {
  const value = env[key];
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}

/**
 * 解析 MinIO 配置。
 *
 * - 生产环境：`MINIO_ENDPOINT` / `MINIO_INTERNAL_ENDPOINT` / `MINIO_BUCKET` /
 *   `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` 任一「未配置 / 等于开发默认值 /
 *   占位符 / 回环地址」即抛错，错误信息列出**全部**有问题的变量名。
 * - 非生产环境：缺失项沿用默认值，行为与旧实现一致。
 */
export function resolveMinioConfig(env: EnvLike = process.env): MinioConfig {
  const production = env.NODE_ENV === 'production';

  if (production) {
    const problems = PRODUCTION_KEY_SPECS.flatMap((spec) => {
      const problem = classifyProductionValue(env[spec.key], {
        defaultValue: spec.defaultValue,
        rejectLoopback: spec.rejectLoopback,
      });
      if (problem === null) {
        return [];
      }
      return [`${spec.key}（${describeProductionValueProblem(problem)}）`];
    });

    if (problems.length > 0) {
      throw new Error(
        `生产环境以下 MinIO 配置不可用：${problems.join('、')}。` +
          '值等于开发默认值/占位符，等同于未配置；' +
          '请在生产部署环境（infra/.env）显式设置这些变量，' +
          '不允许回落到本机开发默认值 localhost:19000 / 默认凭据。',
      );
    }
  }

  return {
    endpoint: read(env, 'MINIO_ENDPOINT') ?? MINIO_DEFAULTS.endpoint,
    internalEndpoint:
      read(env, 'MINIO_INTERNAL_ENDPOINT') ?? MINIO_DEFAULTS.internalEndpoint,
    bucket: read(env, 'MINIO_BUCKET') ?? MINIO_DEFAULTS.bucket,
    accessKey: read(env, 'MINIO_ACCESS_KEY') ?? MINIO_DEFAULTS.accessKey,
    secretKey: read(env, 'MINIO_SECRET_KEY') ?? MINIO_DEFAULTS.secretKey,
    region: read(env, 'MINIO_REGION') ?? MINIO_DEFAULTS.region,
  };
}
