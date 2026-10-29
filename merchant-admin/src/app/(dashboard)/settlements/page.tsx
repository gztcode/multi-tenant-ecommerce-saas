import Link from 'next/link';
import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import { describePayoutStatus, formatCents } from '@/lib/payout';
import type { PayoutItem } from '@/lib/payout';

/**
 * 商家侧的「我的出款单」列表页（Server Component）。
 *
 * ⚠️ **merchant-admin 没有 `Table` 组件** → 用裸 `<table>`
 * （照抄 `merchant-admin/src/components/order/order-list.tsx` 的写法）。
 *
 * ⚠️ **金额一律用后端返回的值**：前端自己把「货款 − 佣金」加总一遍，
 * 就是第二套口径，迟早漂。
 */
interface PayoutListResult {
  items: PayoutItem[];
  total: number;
}

/**
 * 一页最多取多少张出款单。
 *
 * ⚠️ **上限就是 100**（后端 `clampPagination` 的 `MAX_PAGE_SIZE`），
 *    再大也会被夹回 100。
 */
const PAGE_SIZE = 100;

export default async function PayoutsPage() {
  let data: PayoutListResult | null = null;
  let error: string | null = null;

  try {
    // ⚠️ **显式请求 `pageSize=100`**（后端 `clampPagination` 的
    // `MAX_PAGE_SIZE` 就是 100，再大也会被夹回 100）：
    // 不带这个参数 → 后端退回缺省的 20 → 页面上写着「共 N 张出款单」
    // 却只画 20 张，第 21 条之后商家永远看不到，还没有分页控件可翻。
    data = await apiFetchAuthed<PayoutListResult>(
      `/merchant/payouts?pageSize=${PAGE_SIZE}`,
    );
  } catch (cause) {
    error =
      cause instanceof ApiError
        ? `加载出款单失败：${cause.message}`
        : cause instanceof Error
          ? cause.message
          : '出款单加载失败';
  }

  const items = data?.items ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">出款</h2>
        {/* ⚠️ **必须有这个入口**：否则商家能看列表、看详情、撤回，
            却**没有任何路径**进到申请页 —— 5h-1 的核心写入流程在商家端不可用。
            样式照抄 `platform-admin/src/app/(dashboard)/plans/page.tsx`
            的「新建套餐」链接（`Link` + 按钮底色，不套 `Button`：
            `Button` 是 base-ui 的，没有 `asChild`）。 */}
        <Link
          href="/settlements/apply"
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
        >
          申请出款
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">
        平台按「货款 − 平台佣金」算出你这一期该拿多少钱。申请提交后由平台审批，
        审批时会再算一次并锁定金额。
      </p>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {data && (
        <>
          <p className="text-xs text-muted-foreground">
            共 {data.total} 张出款单
            {data.total > items.length ? `（本页显示 ${items.length} 张）` : ''}
            {/* ⚠️ **明确告诉商家超量时怎么办**：本页一次最多取 100 张
                （后端 `clampPagination` 的 `MAX_PAGE_SIZE`），超出部分
                只能找平台要。**不能写成「已显示全部」** —— 那是骗商家。 */}
            {data.total > items.length
              ? '。本页只显示最近 100 张，更多出款单请联系平台'
              : ''}
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th>周期</th>
                <th>状态</th>
                <th>货款净额</th>
                <th>平台佣金</th>
                <th>应结金额</th>
                <th>笔数</th>
                <th>单号</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-4 text-muted-foreground">
                    暂无出款单。
                  </td>
                </tr>
              ) : (
                items.map((payout) => (
                  <tr key={payout.id} className="border-b">
                    <td>
                      <Link
                        href={`/settlements/${payout.id}`}
                        className="underline"
                      >
                        {payout.periodLabel}
                      </Link>
                    </td>
                    <td>{describePayoutStatus(payout.status)}</td>
                    <td>{formatCents(payout.receiptAmount)}</td>
                    <td>{formatCents(payout.commissionAmount)}</td>
                    <td>{formatCents(payout.netAmount)}</td>
                    <td>{payout.entryCount} 笔</td>
                    <td>{payout.payoutNo}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
