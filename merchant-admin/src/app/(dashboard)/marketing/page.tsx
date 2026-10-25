import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import { MarketingPanel } from '@/components/marketing/marketing-panel';
import type { Coupon, Promotion } from '@/lib/marketing';

/**
 * 营销页（Server Component）。
 *
 * 券与活动都在服务端取：列表是首屏就要看的数据，走后端渲染免掉一次客户端瀑布；
 * 增删改后客户端只要 router.refresh() 就会重新走这里，
 * 不需要自己维护一份列表的副本。
 *
 * ⚠️ **两个列表分别取**：一个失败不应该把另一个也拖下水
 * （优惠券加载失败时，商家仍然要能看得到满减活动）。
 */
interface CouponListResponse {
  items: Coupon[];
  total: number;
}

interface PromotionListResponse {
  items: Promotion[];
  total: number;
}

function errorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof ApiError) {
    return `${fallback}（${cause.status}）：${cause.message}`;
  }
  if (cause instanceof Error) {
    return cause.message;
  }
  return fallback;
}

export default async function MarketingPage() {
  const [couponResult, promotionResult] = await Promise.allSettled([
    apiFetchAuthed<CouponListResponse>('/merchant/coupons'),
    apiFetchAuthed<PromotionListResponse>('/merchant/promotions'),
  ]);

  const coupons =
    couponResult.status === 'fulfilled' ? (couponResult.value.items ?? []) : [];
  const promotions =
    promotionResult.status === 'fulfilled'
      ? (promotionResult.value.items ?? [])
      : [];

  const error =
    couponResult.status === 'rejected' || promotionResult.status === 'rejected'
      ? [
          couponResult.status === 'rejected'
            ? errorMessage(couponResult.reason, '优惠券加载失败')
            : null,
          promotionResult.status === 'rejected'
            ? errorMessage(promotionResult.reason, '满减活动加载失败')
            : null,
        ]
          .filter(Boolean)
          .join('；')
      : null;

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-bold">营销</h2>
      <p className="text-sm text-muted-foreground">
        优惠券由消费者领取后在结算时使用；满减活动自动生效，与优惠券可以叠加
        （活动先减、券后减）。金额一律以分为单位保存，界面上填「元」。
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <MarketingPanel coupons={coupons} promotions={promotions} />
    </div>
  );
}
