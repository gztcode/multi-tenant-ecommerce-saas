/**
 * 商家（租户）的类型与展示辅助。
 *
 * 刻意放在 lib 而不是组件目录：列表页和详情页都要用，
 * 且详情页需要按 id 从列表结果里筛出同一个形状的对象。
 *
 * 后端 `GET /tenants` 直接返回 Tenant 实体（Prisma 模型直出），
 * 没有 DTO 收窄，所以这里保留 `Record<string, never>` 之外的原始字段不写，
 * 只声明实际用到的字段——多声明会诱使前端直接依赖未承诺稳定的字段。
 */
export type TenantStatus = 'TRIAL' | 'ACTIVE' | 'SUSPENDED';

export const TENANT_STATUSES: readonly TenantStatus[] = [
  'TRIAL',
  'ACTIVE',
  'SUSPENDED',
];

export interface Tenant {
  id: string;
  name: string;
  subdomain: string;
  status: string;
  createdAt: string;
}

/**
 * 把后端返回的 status 收窄成已知的三个枚举值。
 *
 * status 是后端的开放字符串（Prisma enum 直出），后端加一个新状态时
 * 前端不该崩成 undefined：未知值原样返回，由 UI 显示为「未知状态（xx）」。
 */
export function normalizeStatus(status: string): TenantStatus | null {
  return (TENANT_STATUSES as readonly string[]).includes(status)
    ? (status as TenantStatus)
    : null;
}

/** 状态的中文说明与配色 */
export function describeStatus(status: string): {
  label: string;
  className: string;
} {
  switch (normalizeStatus(status)) {
    case 'TRIAL':
      return { label: '试用中', className: 'text-muted-foreground' };
    case 'ACTIVE':
      return { label: '已启用', className: 'text-primary' };
    case 'SUSPENDED':
      return { label: '已停用', className: 'text-destructive' };
    default:
      return { label: `未知状态（${status}）`, className: 'text-muted-foreground' };
  }
}

/** createdAt 的展示格式化；解析失败时原样回显，不让整张表格崩掉。 */
export function formatCreatedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}