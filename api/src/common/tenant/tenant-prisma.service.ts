import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { TenantScopeError } from './tenant-scope.error';
import {
  RECOMMENDED_REPLACEMENT,
  SOFT_DELETE_MODELS,
  TENANT_SCOPED_MODELS,
  UNIQUE_ONLY_OPERATIONS,
} from './tenant-models';
import {
  TenantContextValue,
  isPlatformScope,
  tenantContext,
} from './tenant-context';

/**
 * 取出某个模型的关系字段名——只有关系字段下的对象/数组值才可能是 Prisma 的嵌套写。
 *
 * 之前用一份固定的黑名单（connect / create / push / set ...）扫 data 的每一个 key，
 * 把 `themeTokens: { push: '#000' }` 这种合法的 Json 用户数据也误判成嵌套写。
 * 改成基于 schema 判定后，只有 `Store.tenant`、`User.tenant`、`User.refreshTokens` 这类
 * 关系字段下的对象/数组才会被拦截，Json 字段（themeTokens、paymentConfig）下的任意
 * key/value 结构都安全放行。
 *
 * 通过 `Prisma.dmmf` 在运行时直接读 schema 元数据，无须另维护一份白名单。
 */
function getRelationFieldNames(model: string): Set<string> {
  const modelDef = Prisma.dmmf.datamodel.models.find((m) => m.name === model);
  if (!modelDef) return new Set();
  return new Set(
    modelDef.fields
      .filter(
        (field) =>
          field.kind === 'object' &&
          'relationName' in field &&
          !!field.relationName,
      )
      .map((field) => field.name),
  );
}

function assertNoNestedWrites(
  data: unknown,
  path: string,
  relationFields: Set<string>,
): void {
  if (Array.isArray(data)) {
    data.forEach((item, index) =>
      assertNoNestedWrites(item, `${path}[${index}]`, relationFields),
    );
    return;
  }
  if (data !== null && typeof data === 'object') {
    for (const [key, value] of Object.entries(
      data as Record<string, unknown>,
    )) {
      // 只有「关系字段」下的对象/数组才被判定为可能的嵌套写：
      // 标量字段、Json 字段下的任意结构放行，沿 key 继续向下递归
      if (
        relationFields.has(key) &&
        value !== null &&
        typeof value === 'object'
      ) {
        throw new TenantScopeError(
          `租户作用域模型禁止关系字段的嵌套写操作：${path}.${key}。` +
            '请拆成两次独立调用。',
        );
      }
      assertNoNestedWrites(value, `${path}.${key}`, relationFields);
    }
  }
}

type ScopeDecision =
  /** 模型不在白名单内：不做任何租户处理 */
  | { kind: 'not-scoped' }
  /** 平台作用域：显式跨租户，不附加过滤 */
  | { kind: 'platform' }
  /** 租户作用域：附加 tenantId 过滤 */
  | { kind: 'tenant'; where: { tenantId: string } };

/**
 * 判定当前请求对某个模型的租户作用域。
 *
 * 关键点：只有白名单内的模型才受隔离约束。
 * 白名单外的模型（Tenant、RefreshToken 等）在任何上下文下都可访问，
 * 否则会因为缺少上下文而无法执行与租户无关的系统级操作。
 */
function resolveScope(
  model: string,
  context: TenantContextValue | undefined,
): ScopeDecision {
  if (!TENANT_SCOPED_MODELS.has(model)) {
    return { kind: 'not-scoped' };
  }
  if (!context) {
    throw new TenantScopeError(
      `模型 ${model} 是租户作用域的，但当前请求没有租户上下文，拒绝访问`,
    );
  }
  if (isPlatformScope(context)) {
    return { kind: 'platform' };
  }
  if (!context.tenantId) {
    throw new TenantScopeError(
      `模型 ${model} 是租户作用域的，但当前请求既不是租户作用域也不是平台作用域，拒绝访问`,
    );
  }
  return { kind: 'tenant', where: { tenantId: context.tenantId } };
}

/**
 * 拒绝租户作用域模型上的「唯一字段 only」方法。
 *
 * 这些方法（findUnique / update / delete / upsert 等）只接受唯一字段作为 where，
 * 无法附加 tenantId 条件，会造成跨租户越权，因此必须拒绝。
 *
 * 注意：作为模块级函数而非类方法，是为了避开 Prisma extension 回调里
 * `this` 指向扩展 client 而不是服务实例的陷阱（参见任务描述「容易踩的坑 #1」）。
 */
function assertNotUniqueOnly(model: string, operation: string): void {
  if (!TENANT_SCOPED_MODELS.has(model)) return;
  if (!UNIQUE_ONLY_OPERATIONS.has(operation)) return;
  throw new TenantScopeError(
    `模型 ${model} 是租户作用域的，禁止使用 ${operation}：` +
      `Prisma 的 ${operation} 只接受唯一字段，无法附加 tenantId 条件，会造成跨租户越权。` +
      `请改用 ${RECOMMENDED_REPLACEMENT[operation] ?? '等价的安全方法'}。`,
  );
}

/**
 * 类型安全的 args 构造 helper。
 *
 * 因为 Prisma 6 的 $allModels 拦截回调参数 `args` 是按 model 分发的 union 类型，
 * 直接在回调里 spread 然后传给 query() 时 TS 不能把新对象 narrowed 回 union。
 * 通过这一个泛型 helper 把 spread 与类型断言集中处理，业务回调里就不必写
 * 任何 `as` 或 `any`，从而保持 ESLint typed 检查开启。
 */
function withMergedWhere<T>(args: T, extra: object): T {
  const baseWhere = (args as unknown as { where?: Record<string, unknown> })
    .where;
  const nextWhere: Record<string, unknown> = { ...(baseWhere ?? {}), ...extra };
  return { ...args, where: nextWhere };
}

/**
 * 软删除模型：自动把 `deletedAt: null` 合并进 where。
 *
 * 合并而不是由调用方写，是为了「漏写一处就漏过滤一处」这种失效模式
 * 不会发生——过滤条件由扩展统一施加，业务代码无从绕过。
 *
 * 与 tenantId 的合并是两次独立的 merge：两次都调用 withMergedWhere，
 * 后一次会保留前一次已经写进去的键（withMergedWhere 是 {...base, ...extra}）。
 */
function withSoftDeleteFilter<T>(args: T, model: string): T {
  if (!SOFT_DELETE_MODELS.has(model)) return args;
  return withMergedWhere(args, { deletedAt: null });
}

/**
 * 禁止通过普通更新把软删除的行「复活」。
 *
 * 过滤方向是 fail-closed 的：软删模型的查询恒定带上 `deletedAt: null`，
 * 缺上下文时直接抛错。但**解除过滤的方向原本是 fail-open 的**——
 * `updateMany({ data: { deletedAt: null } })` 会把已软删的行改回可见状态，
 * 一次普通的更新就能抹掉删除痕迹。
 *
 * 这个不对称意味着：过滤做得再严，也只是「默认拒绝」而不是「不可能穿透」。
 * 两个方向应该对称加固，所以这里堵上。
 *
 * 只拦 `null`：软删除本身写的是 `new Date()`，必须放行。
 * 将来若确实需要「恢复」功能，走一个显式命名的入口（如 `restore()`），
 * 由它单独决定要不要放开这道闸，而不是让任何 updateMany 都能绕过。
 */
function assertNotRevivingSoftDelete(model: string, args: unknown): void {
  if (!SOFT_DELETE_MODELS.has(model)) return;
  const data = (args as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return;
  if (!('deletedAt' in (data as Record<string, unknown>))) return;
  if ((data as Record<string, unknown>).deletedAt !== null) return;
  throw new TenantScopeError(
    `模型 ${model} 是软删除模型，禁止通过 updateMany 把 deletedAt 置 null 来复活记录。` +
      '这会绕过扩展的软删除过滤。若确需恢复，请走显式命名的恢复入口。',
  );
}

/**
 * 软删除模型禁止物理删除。
 *
 * 物理删除会连带毁掉审计链：SKU 被物理删除后，它的历史库存流水
 * 就失去了指向对象（数据库层面还有 Restrict 外键兜着，但品类、
 * 媒体这类没有流水引用的模型就没有第二道防线了）。
 *
 * 「删除」的正确做法是软删除：
 *   await prisma.product.updateMany({ where: { id }, data: { deletedAt: new Date() } })
 */
function assertNotPhysicallyDeletable(model: string, operation: string): void {
  if (!SOFT_DELETE_MODELS.has(model)) return;
  throw new TenantScopeError(
    `模型 ${model} 是软删除模型，禁止使用 ${operation} 物理删除。` +
      '请改用 updateMany 设置 deletedAt。',
  );
}

function withTenantIdInData<T>(args: T, model: string, tenantId: string): T {
  const holder = args as unknown as Record<string, unknown>;
  const data = holder.data as Record<string, unknown> | undefined;
  assertNoNestedWrites(data, 'data', getRelationFieldNames(model));
  holder.data = {
    ...(data ?? {}),
    tenantId,
  };
  return args;
}

function withTenantIdInEachRow<T>(args: T, model: string, tenantId: string): T {
  const inner = args as unknown as { data: unknown };
  const rows = Array.isArray(inner.data) ? inner.data : [inner.data];
  const relationFields = getRelationFieldNames(model);
  rows.forEach((row, index) =>
    assertNoNestedWrites(row, `data[${index}]`, relationFields),
  );
  const stamped = rows.map((row) => ({
    ...((row as object | null | undefined) ?? {}),
    tenantId,
  }));
  (inner as unknown as Record<string, unknown>).data = stamped;
  return args;
}

/**
 * 租户作用域的 query 拦截扩展。
 *
 * 通过 Prisma 6 的 `defineExtension` 构造。
 */
const tenantExtension = Prisma.defineExtension({
  name: 'tenant-scope',
  query: {
    $allModels: {
      // ---------- 读操作：自动追加 tenantId 过滤 ----------

      async findMany({ model, args, query }) {
        const scope = resolveScope(model, tenantContext.getStore());
        const withDelete = withSoftDeleteFilter(args, model);
        if (scope.kind !== 'tenant') return query(withDelete);
        return query(withMergedWhere(withDelete, scope.where));
      },

      async findFirst({ model, args, query }) {
        const scope = resolveScope(model, tenantContext.getStore());
        const withDelete = withSoftDeleteFilter(args, model);
        if (scope.kind !== 'tenant') return query(withDelete);
        return query(withMergedWhere(withDelete, scope.where));
      },

      async findFirstOrThrow({ model, args, query }) {
        const scope = resolveScope(model, tenantContext.getStore());
        const withDelete = withSoftDeleteFilter(args, model);
        if (scope.kind !== 'tenant') return query(withDelete);
        return query(withMergedWhere(withDelete, scope.where));
      },

      async count({ model, args, query }) {
        const scope = resolveScope(model, tenantContext.getStore());
        const withDelete = withSoftDeleteFilter(args, model);
        if (scope.kind !== 'tenant') return query(withDelete);
        return query(withMergedWhere(withDelete, scope.where));
      },

      async aggregate({ model, args, query }) {
        const scope = resolveScope(model, tenantContext.getStore());
        const withDelete = withSoftDeleteFilter(args, model);
        if (scope.kind !== 'tenant') return query(withDelete);
        return query(withMergedWhere(withDelete, scope.where));
      },

      async groupBy({ model, args, query }) {
        const scope = resolveScope(model, tenantContext.getStore());
        const withDelete = withSoftDeleteFilter(args, model);
        if (scope.kind !== 'tenant') return query(withDelete);
        return query(withMergedWhere(withDelete, scope.where));
      },

      // ---------- 唯一性方法：直接拒绝，避免绕过隔离 ----------

      async findUnique({ model, args, query }) {
        assertNotUniqueOnly(model, 'findUnique');
        return query(args);
      },

      async findUniqueOrThrow({ model, args, query }) {
        assertNotUniqueOnly(model, 'findUniqueOrThrow');
        return query(args);
      },

      async update({ model, args, query }) {
        assertNotUniqueOnly(model, 'update');
        return query(args);
      },

      async delete({ model, args, query }) {
        assertNotUniqueOnly(model, 'delete');
        assertNotPhysicallyDeletable(model, 'delete');
        return query(args);
      },

      async upsert({ model, args, query }) {
        // upsert 的 where 必须是唯一字段，附加 tenantId 条件不可行。
        // `where: { id }` 完全无 tenantId 过滤；
        // `where: { tenantId_slug: { tenantId: B.id, ... } }` 中嵌入的 tenantId
        // 也可以被攻击者伪造成别的租户。一律拒绝以堵住跨租户越权。
        assertNotUniqueOnly(model, 'upsert');
        return query(args);
      },

      // ---------- 写操作：自动注入 tenantId ----------

      async create({ model, args, query }) {
        const scope = resolveScope(model, tenantContext.getStore());
        if (scope.kind === 'not-scoped') return query(args);

        if (scope.kind === 'platform') {
          // 平台作用域写入：要求调用方显式指定 tenantId
          const data = (args as unknown as { data?: Record<string, unknown> })
            .data;
          if (!data || typeof data.tenantId !== 'string') {
            throw new TenantScopeError(
              `模型 ${model} 的平台作用域写入必须显式指定 tenantId`,
            );
          }
          return query(args);
        }

        return query(withTenantIdInData(args, model, scope.where.tenantId));
      },

      async createMany({ model, args, query }) {
        const scope = resolveScope(model, tenantContext.getStore());
        if (scope.kind === 'not-scoped') return query(args);

        if (scope.kind === 'platform') {
          // 平台作用域写入：每一行都必须显式指定 tenantId
          const inner = args as unknown as { data: unknown };
          const rows = Array.isArray(inner.data) ? inner.data : [inner.data];
          rows.forEach((row: unknown, index: number) => {
            const data = row as Record<string, unknown> | undefined;
            if (!data || typeof data.tenantId !== 'string') {
              throw new TenantScopeError(
                `模型 ${model} 的平台作用域批量写入必须为每一行显式指定 tenantId` +
                  `（第 ${index} 行缺失）`,
              );
            }
          });
          return query(args);
        }

        return query(withTenantIdInEachRow(args, model, scope.where.tenantId));
      },

      async createManyAndReturn({ model, args, query }) {
        // 与 createMany 同形：每一行注入 tenantId，平台作用域下要求每行显式带 tenantId
        const scope = resolveScope(model, tenantContext.getStore());
        if (scope.kind === 'not-scoped') return query(args);

        if (scope.kind === 'platform') {
          const inner = args as unknown as { data: unknown };
          const rows = Array.isArray(inner.data) ? inner.data : [inner.data];
          rows.forEach((row: unknown, index: number) => {
            const data = row as Record<string, unknown> | undefined;
            if (!data || typeof data.tenantId !== 'string') {
              throw new TenantScopeError(
                `模型 ${model} 的平台作用域批量写入必须为每一行显式指定 tenantId` +
                  `（第 ${index} 行缺失）`,
              );
            }
          });
          return query(args);
        }

        return query(withTenantIdInEachRow(args, model, scope.where.tenantId));
      },

      async updateMany({ model, args, query }) {
        const scope = resolveScope(model, tenantContext.getStore());
        const withDelete = withSoftDeleteFilter(args, model);
        if (scope.kind !== 'tenant') return query(withDelete);
        // 放在早退之后：非租户作用域下没有「替当前租户改数据」这回事
        assertNotRevivingSoftDelete(model, args);
        // updateMany 的 data 也可能带嵌套写（如 `data: { tenant: { connect: { id } } }`），
        // 同样危险——一并做嵌套写检查
        assertNoNestedWrites(
          (args as unknown as Record<string, unknown>).data,
          'data',
          getRelationFieldNames(model),
        );
        return query(withMergedWhere(withDelete, scope.where));
      },

      async updateManyAndReturn({ model, args, query }) {
        // 与 updateMany 同形：合并 where.tenantId + 软删过滤 + 两道 data 检查
        const scope = resolveScope(model, tenantContext.getStore());
        const withDelete = withSoftDeleteFilter(args, model);
        if (scope.kind !== 'tenant') return query(withDelete);
        assertNotRevivingSoftDelete(model, args);
        assertNoNestedWrites(
          (args as unknown as Record<string, unknown>).data,
          'data',
          getRelationFieldNames(model),
        );
        return query(withMergedWhere(withDelete, scope.where));
      },

      async deleteMany({ model, args, query }) {
        assertNotPhysicallyDeletable(model, 'deleteMany');
        const scope = resolveScope(model, tenantContext.getStore());
        const withDelete = withSoftDeleteFilter(args, model);
        if (scope.kind !== 'tenant') return query(withDelete);
        return query(withMergedWhere(withDelete, scope.where));
      },
    },
  },
});

/**
 * 租户隔离版 PrismaClient。
 *
 * Prisma 6 移除了 `PrismaClientOptions.extensions` 构造选项，扩展只能通过
 * `new PrismaClient().$extends(...)` 实例方法应用，因此本类采用「包装」
 * 而不是「继承」的方式来暴露扩展后的能力。
 *
 * 设计要点：
 * - 内部保存一个 `$extends(tenantExtension)` 后的实例 `extended`，所有模型
 *   delegate（user/store/tenant/refreshToken）以及事务都从这里走；
 * - 通过 getter 把扩展实例的方法/属性代理到自身，让消费者仍然可以用
 *   `prisma.user.findMany(...)` 这种纯 PrismaClient 写法；
 * - 生命周期由 NestJS 的 `OnModuleInit` / `OnModuleDestroy` 钩子管理。
 *
 * 关于原生 SQL（$queryRaw / $queryRawUnsafe / $executeRaw / $executeRawUnsafe）：
 * 已被刻意从 Service 上移除——这些方法不经过租户扩展，完全不设防，
 * 阶段 1 不使用；将来真需要时应以显式注入 tenantId 条件的专用 wrapper 形式加回，
 * 而非裸暴露。
 */
// 实例化一个 client 仅用于类型推导：Prisma 6 的 `$extends` 是带泛型签名
// 的实例方法，单独 `ReturnType<PrismaClient['$extends']>` 会被推为 unknown；
// 借助 `typeof` 拿到带 query 扩展的精确类型，编译器才能正确推断
// `prisma.user.findMany(...)` 等调用。
// 实例不会真的建立连接——Prisma 是懒加载引擎，`$extends` 不触发 `$connect`。
// 真正的 client 在 Service 实例化时由 `createExtendedClient()` 重新创建。
//
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _extendedTypeSource = new PrismaClient().$extends(tenantExtension);
type ExtendedClient = typeof _extendedTypeSource;

const createExtendedClient = (): ExtendedClient =>
  new PrismaClient().$extends(tenantExtension);

@Injectable()
export class TenantPrismaService implements OnModuleInit, OnModuleDestroy {
  // 实际的 PrismaClient 实例，挂上扩展；存为私有字段对外隐藏。
  private readonly client: ExtendedClient = createExtendedClient();

  // ------- 模型 delegate 代理 -------
  get user() {
    return this.client.user;
  }

  get store() {
    return this.client.store;
  }

  get tenant() {
    return this.client.tenant;
  }

  get refreshToken() {
    return this.client.refreshToken;
  }

  get category() {
    return this.client.category;
  }

  get product() {
    return this.client.product;
  }

  get productSpec() {
    return this.client.productSpec;
  }

  get productSpecValue() {
    return this.client.productSpecValue;
  }

  get sku() {
    return this.client.sku;
  }

  get skuSpecValue() {
    return this.client.skuSpecValue;
  }

  get media() {
    return this.client.media;
  }

  get productMedia() {
    return this.client.productMedia;
  }

  get inventoryMovement() {
    return this.client.inventoryMovement;
  }

  // ------- 交易链路（计划 3）模型 delegate 代理 -------

  get cart() {
    return this.client.cart;
  }

  get cartItem() {
    return this.client.cartItem;
  }

  get address() {
    return this.client.address;
  }

  get order() {
    return this.client.order;
  }

  get orderItem() {
    return this.client.orderItem;
  }

  get payment() {
    return this.client.payment;
  }

  // 不在租户白名单里，但业务代码要读写它（webhook 幂等表）
  get paymentWebhookEvent() {
    return this.client.paymentWebhookEvent;
  }

  // ------- 营销（计划 5a）模型 delegate 代理 -------

  get coupon() {
    return this.client.coupon;
  }

  get couponClaim() {
    return this.client.couponClaim;
  }

  get couponRedemption() {
    return this.client.couponRedemption;
  }

  get promotion() {
    return this.client.promotion;
  }

  // ------- 平台计费（计划 5b）模型 delegate 代理 -------

  get subscription() {
    return this.client.subscription;
  }

  get invoice() {
    return this.client.invoice;
  }

  get paymentMethod() {
    return this.client.paymentMethod;
  }

  // ⚠️ plan 不在租户白名单里，但业务代码要读它（套餐是平台的数据）
  get plan() {
    return this.client.plan;
  }

  // ------- 抽佣流水（阶段 5e）模型 delegate 代理 -------

  get commissionEntry() {
    return this.client.commissionEntry;
  }

  // ------- 结算单（阶段 5g）模型 delegate 代理 -------

  get settlementStatement() {
    return this.client.settlementStatement;
  }

  // 不在租户白名单里，但业务代码要读写它（结算单明细，无 tenantId 字段）
  // ⚠️ 因此**不受租户作用域约束**——查询前必须自行校验 statementId 属于当前租户
  get settlementStatementEntry() {
    return this.client.settlementStatementEntry;
  }

  // ------- 商家应收货款流水（阶段 5h-1）模型 delegate 代理 -------

  get merchantReceipt() {
    return this.client.merchantReceipt;
  }

  // ------- 商家收款账户（阶段 5h-1）模型 delegate 代理 -------

  get merchantPayoutAccount() {
    return this.client.merchantPayoutAccount;
  }

  // ------- 出款单（阶段 5h-1）模型 delegate 代理 -------

  get payout() {
    return this.client.payout;
  }

  // 不在租户白名单里，但业务代码要读写它（出款单明细，无 tenantId 字段）
  // ⚠️ 因此**不受租户作用域约束**——查询前必须自行校验 payoutId 属于当前租户
  get payoutEntry() {
    return this.client.payoutEntry;
  }

  // ------- PrismaClient 实例级方法代理 -------
  // $connect / $disconnect 由生命周期钩子分别调用，
  // 这里仍然透传出来让服务消费者可以手动关闭连接（例如测试用例）。
  get $connect() {
    return this.client.$connect.bind(this.client);
  }

  get $disconnect() {
    return this.client.$disconnect.bind(this.client);
  }

  // 其余实例级方法（$transaction / $on 等）保留外部访问。
  //
  // 必须全部 `.bind(this.client)`：Prisma 的这些实例方法依赖内部 this
  // （this._engineConfig.adapter、this._createPrismaPromise 等），
  // 通过 getter 取出裸引用再调用时 this 会指向 Service 实例而非 client，直接抛错。
  get $transaction() {
    return this.client.$transaction.bind(this.client);
  }

  get $extends() {
    return this.client.$extends.bind(this.client);
  }

  async onModuleInit(): Promise<void> {
    await this.client.$connect();
    this.assertTenantScopedModelsRegistered();
  }

  /**
   * 取数据库的当前时间（`SELECT now()`）。
   *
   * ⚠️ **这是本类唯一暴露的原生 SQL 入口**，而且只查 `now()`——
   * 不涉及任何租户数据，所以不需要手写 tenantId 条件。
   *
   * 为什么需要它（阶段 5a 的 M15）：过期判定统一用**数据库的时钟**，
   * 不用应用进程的时钟。多副本部署时各机器的时钟有偏差，边界时刻会出现
   * 「这张券在这台机器上过期了、在那台机器上还没过期」。
   * 数据库的 `now()` 是单一事实来源。
   *
   * ⚠️ **刻意不裸暴露 `$queryRaw`**：原生 SQL 完全不经过租户扩展，
   * 一旦放开就成了「绕过隔离的后门」。要加新的原生 SQL 时，
   * 同样以这种专用 wrapper 的形式加，并显式注入 tenantId 条件。
   */
  async databaseNow(): Promise<Date> {
    const rows = await this.client.$queryRaw<Array<{ now: Date }>>`
      SELECT now() as now
    `;
    return rows[0].now;
  }

  /**
   * 启动时校验：schema 里凡是带 tenantId 字段的模型，都必须登记在租户作用域白名单里。
   *
   * 否则新增业务表时忘了登记，那张表的所有读写都不会附加 tenantId 条件——
   * 彻底失去隔离且没有任何报错。这是本机制最危险的失效模式，所以在启动时硬失败。
   */
  private assertTenantScopedModelsRegistered(): void {
    const modelsWithTenantId = Prisma.dmmf.datamodel.models
      .filter((model) =>
        model.fields.some((field) => field.name === 'tenantId'),
      )
      .map((model) => model.name);

    const missing = modelsWithTenantId.filter(
      (name) => !TENANT_SCOPED_MODELS.has(name),
    );

    if (missing.length > 0) {
      throw new Error(
        `以下模型带 tenantId 字段但未登记到 TENANT_SCOPED_MODELS，将失去租户隔离：` +
          `${missing.join('、')}。请在 api/src/common/tenant/tenant-models.ts 中登记。`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
