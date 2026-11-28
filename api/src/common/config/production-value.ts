/**
 * 生产环境配置值的「可用性」判定（2026-11）。
 *
 * ⚠️ **为什么需要它**：生产部署走 `infra/docker-compose.yml`，里面大量键写成
 *    `${VAR:-开发默认值}`。变量因此「非空」，只判非空的护栏会放行，进程照常
 *    启动——但值就是仓库里公开的开发默认值，故障被推迟到第一次真实请求。
 *    「值等于开发默认值」必须与「未配置」等价处理。
 *
 * ⚠️ 判定集中在**纯函数**里：`minio-config.ts` 与 `seed-guard.ts` 各自散落
 *    一套判断的话，迟早出现「一处拦、一处放」的漂移。
 *
 * ⚠️ 返回的是**原因类别**而不是值本身：调用方把类别写进启动错误信息，
 *    真实凭据不会被带进日志或 CI 输出。
 */

import { isPlaceholderSecret } from './placeholder-secrets';

/** 一个生产配置值不可用的原因类别 */
export type ProductionValueProblem =
  'empty' | 'matches-default' | 'placeholder' | 'loopback';

/** 回环地址的主机名（生产不可能用回环地址对外提供服务） */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
]);

/** 原因类别 → 报错文案里的短语（**不含具体值**） */
const PROBLEM_LABELS: Record<ProductionValueProblem, string> = {
  empty: '未配置/空值',
  'matches-default': '等于开发默认值',
  placeholder: '占位符',
  loopback: '回环地址',
};

export interface ProductionValueOptions {
  /** 该键在非生产环境的兜底默认值；生产环境等于它视为未配置 */
  readonly defaultValue?: string;
  /** 是否额外拒绝回环地址（只对 endpoint 之类的 URL 生效） */
  readonly rejectLoopback?: boolean;
}

/**
 * 判断值是否指向本机回环地址。
 *
 * 非 URL（例如拼错成 `minio:9000` 少了协议头）一律返回 false ——
 * 这里只负责「回环」这一条，URL 合法性交给下游 S3 客户端。
 */
export function isLoopbackEndpoint(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return LOOPBACK_HOSTNAMES.has(hostname);
  } catch {
    return false;
  }
}

/**
 * 判定一个生产配置值是否可用。
 *
 * 返回 `null` 表示可用；否则返回首个命中的原因类别。
 * 判定的先后顺序：空值 → 等于默认值 → 占位符 → 回环地址。
 * （保持这个顺序，报错文案才不会因为调用方传参顺序不同而漂移。）
 */
export function classifyProductionValue(
  value: string | undefined,
  options: ProductionValueOptions = {},
): ProductionValueProblem | null {
  const trimmed = value?.trim() ?? '';

  if (trimmed.length === 0) {
    return 'empty';
  }

  if (options.defaultValue !== undefined && trimmed === options.defaultValue) {
    return 'matches-default';
  }

  if (isPlaceholderSecret(trimmed)) {
    return 'placeholder';
  }

  if (options.rejectLoopback && isLoopbackEndpoint(trimmed)) {
    return 'loopback';
  }

  return null;
}

/** 把原因类别转成报错文案里的短语（不泄露值） */
export function describeProductionValueProblem(
  problem: ProductionValueProblem,
): string {
  return PROBLEM_LABELS[problem];
}
