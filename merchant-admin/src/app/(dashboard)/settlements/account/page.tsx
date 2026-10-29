import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import type { PayoutAccount } from '@/lib/payout';
import { PayoutAccountForm } from './account-form';

/**
 * 商家侧的收款账户设置页（Server Component）。
 *
 * ⚠️ **账号只展示脱敏的**：后端返回的就是脱敏后的，
 * 页面**不能**自己去显示完整账号 —— 那就白脱敏了。
 */
export default async function PayoutAccountPage() {
  let account: PayoutAccount | null = null;
  let error: string | null = null;

  try {
    account = await apiFetchAuthed<PayoutAccount | null>(
      '/merchant/payout-account',
    );
  } catch (cause) {
    error =
      cause instanceof ApiError
        ? `加载收款账户失败（${cause.status}）：${cause.message}`
        : cause instanceof Error
          ? cause.message
          : '收款账户加载失败';
  }

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-bold">收款账户</h2>
      <p className="text-sm text-muted-foreground">
        出款的钱会打到这张卡上。一个商家只能有一张收款账户；
        账号在页面上只显示尾号。
      </p>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <PayoutAccountForm initial={account} />
    </div>
  );
}
