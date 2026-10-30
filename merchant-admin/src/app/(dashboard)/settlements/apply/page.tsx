import Link from 'next/link';
import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import type { AvailablePeriod, PayoutAccount } from '@/lib/payout';
import { PayoutApplyForm } from './apply-form';

/**
 * 商家侧的「申请出款」页（Server Component）。
 *
 * ⚠️ **金额全部由后端算**：这里只把后端给的「可申请周期 + 应结金额」
 *    传给表单，商家选周期 → 提交。商家**不能**自己填金额。
 *
 * ⚠️ **收款账户要显示出来**：商家提交之前必须能看出「钱会打到哪」。
 *    阶段 5j 之后库里只有密文，**掩码串是唯一能核对的东西**。
 */
export default async function PayoutApplyPage() {
  let periods: AvailablePeriod[] = [];
  let error: string | null = null;
  let account: PayoutAccount | null = null;
  let accountError: string | null = null;

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

  // ⚠️ **账户加载失败不阻断申请** —— 它只是展示信息，
  //    申请接口有服务端校验（没有账户会被拒）。
  try {
    account = await apiFetchAuthed<PayoutAccount | null>(
      '/merchant/payout-account',
    );
  } catch (cause) {
    accountError =
      cause instanceof ApiError
        ? `加载收款账户失败：${cause.message}`
        : cause instanceof Error
          ? cause.message
          : '收款账户加载失败';
  }

  // ⚠️ **拼法要与详情页的 `describePayoutAccount` 逐字一致** ——
  //    申请页显示的是「**当前**账户」、详情页显示的是「申请时快照」，
  //    两份数据本来就可能不同，但**拼法必须一样** ——
  //    否则同一个商家在两个页面看到两种写法（一个「银行 ****1234（张三）」、
  //    一个「银行 ****1234 （张三）」）。
  const accountText = account
    ? [
        account.bankName,
        account.maskedAccountNo,
        `（${account.accountName}）`,
      ].join(' ')
    : null;

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

      {/* ⚠️ **收款账户要显示**：商家提交之前必须能看出「钱会打到哪」。
          ⚠️ **没账户时要给入口** —— 光说「尚未设置」商家不知道去哪设。
          ⚠️ **显示的是「当前账户」**，与详情页的「申请时快照」不是同一份
          （商家改过账户就会不同）—— 这是对的：申请页讲的是「这次会打给谁」。 */}
      <div className="rounded-md border p-3 text-sm">
        {accountText ? (
          <p>本次出款将打到：{accountText}</p>
        ) : accountError ? (
          <p className="text-muted-foreground">
            收款账户加载失败：{accountError}
          </p>
        ) : (
          <p>
            尚未设置收款账户，
            <Link
              href="/settlements/account"
              className="underline underline-offset-4"
            >
              去设置收款账户
            </Link>
          </p>
        )}
      </div>

      <PayoutApplyForm periods={periods} />
    </div>
  );
}
