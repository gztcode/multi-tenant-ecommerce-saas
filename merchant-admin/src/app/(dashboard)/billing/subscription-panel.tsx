'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import {
  describeInvoiceStatus,
  describeSubscriptionStatus,
  formatCommissionRate,
  formatPriceLabel,
  formatQuota,
  type Invoice,
  type PaymentMethodItem,
  type PaymentMethodType,
  type Plan,
  type Subscription,
} from '@/lib/billing';

/**
 * 订阅页的四个块：当前订阅、套餐列表、账单、支付方式。
 *
 * ⚠️ **逻辑内嵌在组件内部，没有从 Server Component 往下传回调**——
 * Server → Client 传函数在 tsc 与 next build 下都能过，
 * 只有真正渲染这一页时才 500（阶段 2b 踩过）。
 *
 * ⚠️ **所有写操作都走同源的 /api/** 中转（不是直连后端）：
 * 后端没开 CORS，而且 accessToken 不该进客户端代码。
 * 中转路由在服务端用 auth() 取 token，并**按白名单重建请求体**。
 *
 * ⚠️ **金额一律整数分**（后端的约定），只在展示层转成「元」。
 */

/** 支付方式的类型 → 中文 */
const PAYMENT_METHOD_TYPE_LABEL: Record<string, string> = {
  CARD: '银行卡',
  WECHAT: '微信支付',
  ALIPAY: '支付宝',
};

/** 功能开关 → 中文 */
const FEATURE_LABEL: Record<string, string> = {
  marketing: '营销工具',
  coupons: '优惠券',
  promotions: '满减活动',
  multiStore: '多店铺',
  api: '开放 API',
};

/** 统一的中转路由响应解析：后端 message 已经脱敏，可以直接显示给人看 */
async function readResponse(
  response: Response,
  fallback: string,
): Promise<string | null> {
  const payload = (await response.json().catch(() => ({}))) as {
    message?: string;
  };
  return response.ok ? null : (payload.message ?? fallback);
}

/** ISO 时间 → 商家看得懂的本地日期 */
function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('zh-CN');
}

type Tab = 'subscription' | 'plans' | 'invoices' | 'methods';

export function SubscriptionPanel({
  plans,
  subscription,
  invoices,
  paymentMethods,
  errors,
}: {
  plans: Plan[];
  subscription: Subscription | null;
  invoices: Invoice[];
  paymentMethods: PaymentMethodItem[];
  /** 每一块各自的加载失败原因；某块失败不影响其它块 */
  errors: Partial<
    Record<'plans' | 'subscription' | 'invoices' | 'paymentMethods', string>
  >;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('subscription');
  /** 成功提示（灰色）与失败提示（红色）分开：长得一样就分不清有没有办成 */
  const [success, setSuccess] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  /**
   * ⚠️ **按动作分键**，而不是一个全局标志：一个慢请求会把整页所有按钮
   * 一起禁掉（商家在别的标签页想设个默认支付方式也点不动）。
   * 值是动作名，每个按钮只读自己那个键。
   */
  const [busy, setBusy] = useState<string | null>(null);
  /**
   * ⚠️ **闸门读的是 ref 不是 state**：state 同一 tick 内还是旧值，
   * 连点两次会一起通过检查发出两次请求。ref 是同步写的。
   */
  const busyRef = useRef<string | null>(null);

  /**
   * 统一的写操作包装。
   *
   * ⚠️ **成功后必须 router.refresh()**：套餐、订阅、账单都是服务端渲染的，
   * 本组件不持有它们的副本，不刷新就看不到变化。
   *
   * ⚠️ **失败信息要让商家知道下一步做什么**：只丢一句「操作失败」
   * 等于让商家对着空气猜。
   */
  async function run(
    key: string,
    action: () => Promise<Response>,
    fallback: string,
    successMessage?: string,
  ) {
    // ⚠️ **并发闸门**：同一个动作进行中就直接返回，连点两次不能发两次请求
    // （重复扣款、重复绑卡）。
    // ⚠️ **闸门读 ref 不读 state**：state 在同一 tick 里还是旧值，
    // 连点两次会一起通过检查。ref 是同步写的。
    if (busyRef.current === key) return;
    busyRef.current = key;
    setBusy(key);
    setSuccess(null);
    setFailure(null);
    try {
      const response = await action();
      const problem = await readResponse(response, fallback);
      if (problem) throw new Error(problem);
      if (successMessage) setSuccess(successMessage);
      router.refresh();
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : fallback;
      setFailure(`${fallback}：${reason}。请稍后重试；若反复失败请联系平台客服。`);
    } finally {
      // ⚠️ **只清自己那个键**：别的动作可能正在跑，清成 null 会把它的
      // 按钮解禁，让商家能重复提交。
      if (busyRef.current === key) {
        busyRef.current = null;
        setBusy(null);
      }
    }
  }

  /**
   * 开通 / 换套餐。
   *
   * ⚠️ **有订阅时必须走 PATCH**：`POST` 在已有订阅时是幂等的
   * （护栏 M4），会原样返回旧订阅——套餐根本没换，界面却提示「已提交」。
   * 那比报错更糟。
   */
  async function subscribe(planId: string) {
    const changing = Boolean(subscription);
    await run(
      changing ? `plan:${planId}` : 'subscribe',
      () =>
        fetch('/api/billing/subscription', {
          method: changing ? 'PATCH' : 'POST',
          headers: { 'content-type': 'application/json' },
          // ⚠️ **只发 planId**：价格、额度、抽佣率都由后端从库里读。
          body: JSON.stringify({ planId }),
        }),
      changing ? '切换套餐失败' : '开通失败',
      changing
        ? '已提交切换申请，新套餐将在本周期结束后生效；本期仍按原套餐计费。'
        : '已提交开通申请，稍后刷新即可看到新的订阅状态。',
    );
  }

  async function payInvoice(invoiceNumber: string) {
    setSuccess(null);
    setFailure(null);
    const key = `pay:${invoiceNumber}`;
    if (busyRef.current === key) return;
    busyRef.current = key;
    setBusy(key);
    try {
      const response = await fetch(
        `/api/billing/invoices/${encodeURIComponent(invoiceNumber)}/pay`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // ⚠️ **不带金额**：金额只从账单读。
          body: JSON.stringify({}),
        },
      );
      // ⚠️ **响应体只读一次**：读过之后就没了，再读一次拿到的是空对象，
      // `payUrl` 会凭空消失。
      const payload = (await response.json().catch(() => ({}))) as {
        message?: string;
        payUrl?: string;
      };
      if (!response.ok) {
        throw new Error(payload.message ?? '发起支付失败');
      }
      if (!payload.payUrl) {
        throw new Error('后端没有返回支付页面地址');
      }
      // ⚠️ **给商家一条明确提示**：支付页在**后端**上，跳过去之前
      // 先说清楚要去哪、付完回来。
      setSuccess('正在跳转到支付页面，请在支付页完成付款后返回本后台。');
      window.location.href = payload.payUrl;
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : '发起支付失败';
      setFailure(
        `发起支付失败：${reason}。请稍后重试；若反复失败请联系平台客服。`,
      );
    } finally {
      if (busyRef.current === key) {
        busyRef.current = null;
        setBusy(null);
      }
    }
  }

  async function setDefaultMethod(id: string) {
    await run(
      `default:${id}`,
      () => fetch(`/api/billing/payment-methods/${id}/default`, { method: 'POST' }),
      '设置失败',
      '已设为默认支付方式。',
    );
  }

  async function removeMethod(id: string, label: string) {
    if (!confirm(`确定解绑「${label}」？解绑后将无法自动续费。`)) {
      return;
    }
    await run(
      `remove:${id}`,
      () => fetch(`/api/billing/payment-methods/${id}`, { method: 'DELETE' }),
      '解绑失败',
      '已解绑该支付方式。',
    );
  }

  async function addMethod(type: PaymentMethodType, channel: string) {
    await run(
      'add-method',
      () =>
        fetch('/api/billing/payment-methods', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // ⚠️ **不发 token**：token 必须由渠道给。
          body: JSON.stringify({ type, channel }),
        }),
      '绑定失败',
      '已绑定该支付方式。',
    );
  }

  function renderSubscription() {
    if (errors.subscription) {
      return <p className="text-sm text-destructive">{errors.subscription}</p>;
    }
    if (!subscription) {
      return (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            你还没有订阅任何套餐。选一个套餐开通，就能开始上架商品了。
          </p>
          <button
            type="button"
            onClick={() => setTab('plans')}
            className="w-fit rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
          >
            去看看套餐
          </button>
        </div>
      );
    }

    const currentPlan = plans.find((plan) => plan.id === subscription.planId);
    const pendingPlan = plans.find(
      (plan) => plan.id === subscription.pendingPlanId,
    );

    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1 rounded-lg border p-4">
          <div className="flex items-center gap-2">
            <span className="text-base font-medium">
              {/* ⚠️ **套餐已下架时不要说「当前套餐」**：后端只返回在售的
                  套餐，商家会以为套餐名丢了。也不要显示裸 id。 */}
              {currentPlan?.name ?? '套餐已下架'}
            </span>
            <span className="rounded-md border px-2 py-0.5 text-xs">
              {describeSubscriptionStatus(subscription)}
            </span>
          </div>
          <span className="text-sm text-muted-foreground">
            本期：{formatDate(subscription.currentPeriodStart)} 至{' '}
            {formatDate(subscription.currentPeriodEnd)}
          </span>
          {subscription.trialEndsAt && (
            <span className="text-sm text-muted-foreground">
              试用到 {formatDate(subscription.trialEndsAt)}，到期后开始计费。
            </span>
          )}
          {subscription.cancelAtPeriodEnd && (
            <span className="text-sm text-muted-foreground">
              已设置到期不自动续费，{formatDate(subscription.currentPeriodEnd)}{' '}
              后套餐会停止。想继续用的话，在本期结束前重新开通即可恢复自动续费。
            </span>
          )}
        </div>

        {subscription.pendingPlanId && (
          <div className="rounded-lg border border-primary/40 p-4 text-sm">
            {pendingPlan
              ? `已预约切换到「${pendingPlan.name}」，${formatDate(subscription.currentPeriodEnd)} 起生效。`
              : /* ⚠️ **不要把裸 id 打给商家看**（形如「已预约切换套餐
                   （plan_xxx）」）——那是内部标识，商家看不懂。 */
                `已预约切换套餐（新套餐已下架，暂无法显示名称），${formatDate(subscription.currentPeriodEnd)} 起生效。`}
          </div>
        )}
      </div>
    );
  }

  function renderPlans() {
    if (errors.plans) {
      return <p className="text-sm text-destructive">{errors.plans}</p>;
    }
    if (plans.length === 0) {
      return (
        <p className="text-sm text-muted-foreground">
          平台暂时没有可开通的套餐。
        </p>
      );
    }

    return (
      <ul className="flex flex-col gap-3">
        {plans.map((plan) => {
          const features = Object.entries(plan.features ?? {}).filter(
            ([, enabled]) => Boolean(enabled),
          );
          const isCurrent = subscription?.planId === plan.id;
          const isPending = subscription?.pendingPlanId === plan.id;
          // ⚠️ **按钮文案要区分**：没订阅是「开通」，有订阅是「切换到这个套餐」。
          // 两者走的是不同的端点（POST / PATCH），语义也不同。
          const actionLabel = subscription ? '切换到这个套餐' : '开通';

          return (
            <li key={plan.id} className="flex flex-col gap-2 rounded-lg border p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex flex-col gap-1">
                  <span className="text-base font-medium">
                    {plan.name}
                    {isCurrent && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        当前套餐
                      </span>
                    )}
                  </span>
                  {plan.description && (
                    <span className="text-sm text-muted-foreground">
                      {plan.description}
                    </span>
                  )}
                  <span className="text-sm">
                    {formatPriceLabel(plan.price)}
                    <span className="text-muted-foreground">
                      {' '}
                      / {plan.periodDays} 天
                      {plan.trialDays > 0
                        ? `（含 ${plan.trialDays} 天试用）`
                        : ''}
                    </span>
                  </span>
                </div>
                <button
                  type="button"
                  disabled={busy === `plan:${plan.id}` || isCurrent || isPending}
                  onClick={() => subscribe(plan.id)}
                  className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-40"
                >
                  {isCurrent
                    ? '使用中'
                    : isPending
                      ? '已预约切换'
                      : actionLabel}
                </button>
              </div>

              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>商品 {formatQuota(plan.maxProducts)} 个</span>
                <span>SKU {formatQuota(plan.maxSkus)} 个</span>
                <span>店铺 {formatQuota(plan.maxStores)} 个</span>
                <span>平台抽佣 {formatCommissionRate(plan.commissionBps)}</span>
              </div>

              {features.length > 0 && (
                <div className="flex flex-wrap gap-1 text-xs">
                  {features.map(([key]) => (
                    <span
                      key={key}
                      className="rounded-md bg-muted px-2 py-0.5"
                    >
                      {FEATURE_LABEL[key] ?? key}
                    </span>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  function renderInvoices() {
    if (errors.invoices) {
      return <p className="text-sm text-destructive">{errors.invoices}</p>;
    }
    if (invoices.length === 0) {
      return (
        <p className="text-sm text-muted-foreground">
          还没有账单。开通套餐后会在这里看到每个周期的账单。
        </p>
      );
    }

    return (
      <ul className="flex flex-col gap-3">
        {invoices.map((invoice) => {
          // ⚠️ **只有未结清的账单才给「去支付」**：
          // 已支付的再点一次会拿到一句没头没尾的失败。
          const payable = invoice.status === 'OPEN' || invoice.status === 'FAILED';

          return (
            <li
              key={invoice.id}
              className="flex flex-col gap-2 rounded-lg border p-4"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex flex-col gap-1">
                  <span className="font-medium">
                    {formatPriceLabel(invoice.amount)}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {invoice.number}
                    </span>
                  </span>
                  <span className="text-sm text-muted-foreground">
                    计费周期：{formatDate(invoice.periodStart)} 至{' '}
                    {formatDate(invoice.periodEnd)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    应付截止：{formatDate(invoice.dueAt)}
                    {invoice.paidAt
                      ? ` · 已于 ${formatDate(invoice.paidAt)} 支付`
                      : ''}
                  </span>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <span className="rounded-md border px-2 py-1 text-xs">
                    {describeInvoiceStatus(invoice)}
                  </span>
                  {payable && (
                    <button
                      type="button"
                      disabled={busy === `pay:${invoice.number}`}
                      onClick={() => payInvoice(invoice.number)}
                      className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-40"
                    >
                      去支付
                    </button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    );
  }

  function renderMethods() {
    if (errors.paymentMethods) {
      return <p className="text-sm text-destructive">{errors.paymentMethods}</p>;
    }

    return (
      <div className="flex flex-col gap-4">
        {paymentMethods.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            还没有绑定支付方式。绑一个之后，套餐到期会自动扣款，
            不用每次手动续费。
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {paymentMethods.map((method) => {
              const label =
                PAYMENT_METHOD_TYPE_LABEL[method.type] ?? method.type;

              return (
                <li
                  key={method.id}
                  className="flex flex-col gap-2 rounded-lg border p-4"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex flex-col gap-1">
                      <span className="font-medium">
                        {label}
                        {method.isDefault && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            默认
                          </span>
                        )}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        渠道：{method.channel} · 绑定于{' '}
                        {formatDate(method.createdAt)}
                      </span>
                    </div>
                    <div className="flex gap-3 text-xs">
                      {!method.isDefault && (
                        <button
                          type="button"
                          disabled={busy === `default:${method.id}`}
                          onClick={() => setDefaultMethod(method.id)}
                          className="underline disabled:opacity-40"
                        >
                          设为默认
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busy === `remove:${method.id}`}
                        onClick={() => removeMethod(method.id, label)}
                        className="text-destructive underline disabled:opacity-40"
                      >
                        解绑
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <BindMethodForm
          busy={busy === 'add-method'}
          onSubmit={addMethod}
        />
      </div>
    );
  }

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: 'subscription', label: '当前订阅' },
    { key: 'plans', label: '套餐' },
    { key: 'invoices', label: '账单' },
    { key: 'methods', label: '支付方式' },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2">
        {tabs.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            className={[
              'rounded-md border px-3 py-1 text-sm',
              tab === item.key ? 'border-primary text-primary' : '',
            ].join(' ')}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'subscription' && renderSubscription()}
      {tab === 'plans' && renderPlans()}
      {tab === 'invoices' && renderInvoices()}
      {tab === 'methods' && renderMethods()}

      {success && (
        <p role="status" className="text-sm text-muted-foreground">
          {success}
        </p>
      )}
      {failure && (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      )}
    </div>
  );
}

/**
 * 绑定支付方式的表单。
 *
 * ⚠️ **只让用户选类型与渠道**：token 由渠道给，界面上没有这一栏，
 * 也不该有——让用户填 token 就等于允许绑一张不属于自己的卡。
 */
function BindMethodForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit: (type: PaymentMethodType, channel: string) => Promise<void>;
}) {
  const [type, setType] = useState<PaymentMethodType>('CARD');
  const [channel, setChannel] = useState('FAKE');

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-4">
      <span className="text-sm font-medium">绑定支付方式</span>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-sm">
          类型
          <select
            value={type}
            aria-label="支付方式类型"
            onChange={(e) => setType(e.target.value as PaymentMethodType)}
            className="rounded-md border px-2 py-1 text-sm"
          >
            {Object.entries(PAYMENT_METHOD_TYPE_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          渠道
          <input
            value={channel}
            aria-label="支付渠道"
            placeholder="渠道名（如 FAKE）"
            onChange={(e) => setChannel(e.target.value)}
            className="rounded-md border px-2 py-1 text-sm"
          />
        </label>
        <button
          type="button"
          disabled={busy}
          onClick={() => onSubmit(type, channel.trim())}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-40"
        >
          绑定
        </button>
      </div>
    </div>
  );
}
