import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import { SubscriptionPanel } from '@/app/(dashboard)/billing/subscription-panel';
import type {
  Invoice,
  PaymentMethodItem,
  Plan,
  Subscription,
} from '@/lib/billing';

/**
 * 订阅页（Server Component）。
 *
 * 套餐、当前订阅、账单、支付方式都在服务端取：它们是首屏就要看的数据，
 * 走后端渲染免掉一次客户端瀑布；改完之后客户端只要 router.refresh()
 * 就会重新走这里，不需要自己维护一份副本。
 *
 * ⚠️ **四个数据源各自兜住失败**：某一个 404 或 500 不该让整页崩掉。
 * 商家后台的核心是「别白屏」——账单加载失败时，商家仍然要能看得到
 * 自己的套餐并升级。所以每一块独立失败、独立显示「加载失败」。
 */
interface ListResponse<T> {
  items: T[];
  total: number;
}

/** 把失败收敛成一句能显示给人看的话 */
function errorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof ApiError) {
    return `${fallback}（${cause.status}）：${cause.message}`;
  }
  if (cause instanceof Error) {
    return `${fallback}：${cause.message}`;
  }
  return fallback;
}

export default async function BillingPage() {
  const [plansResult, subscriptionResult, invoicesResult, methodsResult] =
    await Promise.allSettled([
      apiFetchAuthed<ListResponse<Plan>>('/billing/plans'),
      apiFetchAuthed<Subscription | null>('/billing/subscription'),
      apiFetchAuthed<ListResponse<Invoice>>('/billing/invoices'),
      apiFetchAuthed<ListResponse<PaymentMethodItem>>('/billing/payment-methods'),
    ]);

  const plans =
    plansResult.status === 'fulfilled' ? (plansResult.value.items ?? []) : [];
  const subscription =
    subscriptionResult.status === 'fulfilled'
      ? subscriptionResult.value
      : null;
  const invoices =
    invoicesResult.status === 'fulfilled' ? (invoicesResult.value.items ?? []) : [];
  const paymentMethods =
    methodsResult.status === 'fulfilled'
      ? (methodsResult.value.items ?? [])
      : [];

  const errors: Partial<
    Record<'plans' | 'subscription' | 'invoices' | 'paymentMethods', string>
  > = {};
  if (plansResult.status === 'rejected') {
    errors.plans = errorMessage(plansResult.reason, '套餐列表加载失败');
  }
  if (subscriptionResult.status === 'rejected') {
    errors.subscription = errorMessage(
      subscriptionResult.reason,
      '当前订阅加载失败',
    );
  }
  if (invoicesResult.status === 'rejected') {
    errors.invoices = errorMessage(invoicesResult.reason, '账单列表加载失败');
  }
  if (methodsResult.status === 'rejected') {
    errors.paymentMethods = errorMessage(
      methodsResult.reason,
      '支付方式加载失败',
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-bold">订阅</h2>
      <p className="text-sm text-muted-foreground">
        套餐决定店铺能上架多少商品、抽多少成、能不能用营销工具。
        账单与支付方式用于自动续费——绑一张支付方式，到期后系统自动扣款，
        不用每次手动续费。
      </p>
      <SubscriptionPanel
        plans={plans}
        subscription={subscription}
        invoices={invoices}
        paymentMethods={paymentMethods}
        errors={errors}
      />
    </div>
  );
}
