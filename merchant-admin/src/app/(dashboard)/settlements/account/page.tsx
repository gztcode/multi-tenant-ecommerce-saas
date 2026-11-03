import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import type {
  PayoutAccountView,
  PayoutChannelOption,
  PayoutChannelsResponse,
} from '@/lib/payout';
import { PayoutAccountForm } from './account-form';

/**
 * 读商家可选的出款渠道（**只在服务端调用**）。
 *
 * ⚠️ **取数函数放在页面而不是 `lib/payout.ts`**：那个文件被多个客户端组件
 *    引用，在里面 import `api-client` 会把 next-auth 整条依赖图带进浏览器包。
 */
async function fetchPayoutChannelOptions(): Promise<PayoutChannelOption[]> {
  const result = await apiFetchAuthed<PayoutChannelsResponse>(
    '/merchant/payout-channels',
  );
  return result.channels;
}

/**
 * 商家侧的收款账户设置页（Server Component）。
 *
 * ⚠️ **账号只展示脱敏的**：后端返回的就是脱敏后的，
 * 页面**不能**自己去显示完整账号 —— 那就白脱敏了。
 */
export default async function PayoutAccountPage() {
  // ⚠️ **账户与渠道列表并行取**：串行会多等一个来回。
  //    **账号失败整页不展示表单**（没有账户就没法编辑），
  //    但**渠道列表失败不挡账户** —— 表单退化成「下拉只有使用平台默认一项」，
  //    已有配置仍作为「当前配置，不可用」选项显示（见表单里的补选项逻辑）。
  const [accountResult, channelsResult] = await Promise.allSettled([
    apiFetchAuthed<PayoutAccountView | null>('/merchant/payout-account'),
    fetchPayoutChannelOptions(),
  ]);

  let account: PayoutAccountView | null = null;
  let error: string | null = null;

  if (accountResult.status === 'fulfilled') {
    account = accountResult.value;
  } else {
    const cause: unknown = accountResult.reason;
    error =
      cause instanceof ApiError
        ? `加载收款账户失败（${cause.status}）：${cause.message}`
        : cause instanceof Error
          ? cause.message
          : '收款账户加载失败';
  }

  const channels: PayoutChannelOption[] =
    channelsResult.status === 'fulfilled' ? channelsResult.value : [];

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-bold">收款账户</h2>
      <p className="text-sm text-muted-foreground">
        出款的钱会打到这张卡上。一个商家只能有一张收款账户；
        账号在页面上只显示尾号。
      </p>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <PayoutAccountForm initial={account} channels={channels} />
    </div>
  );
}
