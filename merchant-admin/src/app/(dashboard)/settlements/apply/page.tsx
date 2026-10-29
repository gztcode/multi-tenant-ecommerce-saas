import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import type { AvailablePeriod } from '@/lib/payout';
import { PayoutApplyForm } from './apply-form';

/**
 * 商家侧的「申请出款」页（Server Component）。
 *
 * ⚠️ **金额全部由后端算**：这里只把后端给的「可申请周期 + 应结金额」
 * 传给表单，商家选周期 → 提交。商家**不能**自己填金额。
 */
export default async function PayoutApplyPage() {
  let periods: AvailablePeriod[] = [];
  let error: string | null = null;

  try {
    periods = await apiFetchAuthed<AvailablePeriod[]>(
      '/merchant/payouts/available-periods',
    );
  } catch (cause) {
    error =
      cause instanceof ApiError
        ? `加载可申请周期失败：${cause.message}`
        : cause instanceof Error
          ? cause.message
          : '可申请周期加载失败';
  }

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-bold">申请出款</h2>
      <p className="text-sm text-muted-foreground">
        选一个自然月提交申请。金额由平台按「货款 − 平台佣金」算好，
        审批时还会再算一次并锁定。
      </p>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <PayoutApplyForm periods={periods} />
    </div>
  );
}
