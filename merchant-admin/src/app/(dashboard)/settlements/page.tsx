import Link from 'next/link';
import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import {
  describePayoutKind,
  describePayoutStatus,
  formatCents,
} from '@/lib/payout';
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
 * 每页条数的可选档位（阶段 5l）。
 *
 * ⚠️ **默认档必须是 100** —— 与改造前一致。改成 20 会被商家当成
 *    「数据丢了」（出款单是要核账的凭证，少列几行就是事故）。
 */
const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;

export default async function PayoutsPage({
  searchParams,
}: {
  // Next.js 15 起 searchParams 是 Promise，必须 await。
  searchParams: Promise<{ page?: string; pageSize?: string }>;
}) {
  // ⚠️ **页码与每页条数从 URL 读** —— 纯服务端翻页，不需要客户端组件。
  const params = await searchParams;
  const parsedPage = Number.parseInt(params.page ?? '1', 10);
  const page =
    Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const parsedPageSize = Number.parseInt(params.pageSize ?? '100', 10);
  // ⚠️ **夹到 1..100**（上限与后端 `clampPagination` 的 `MAX_PAGE_SIZE` 一致）：
  //    写大了后端也会夹回来，但页面上的「每页 N 条」得跟实际一致。
  const pageSize = Math.min(
    100,
    Math.max(1, Number.isFinite(parsedPageSize) ? parsedPageSize : 100),
  );

  let data: PayoutListResult | null = null;
  let error: string | null = null;

  try {
    // ⚠️ **显式请求 `pageSize`**（后端 `clampPagination` 的
    // `MAX_PAGE_SIZE` 就是 100，再大也会被夹回 100）：
    // 不带这个参数 → 后端退回缺省的 20 → 页面上写着「共 N 张出款单」
    // 却只画 20 张，第 21 条之后商家永远看不到。
    data = await apiFetchAuthed<PayoutListResult>(
      `/merchant/payouts?page=${page}&pageSize=${pageSize}`,
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
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

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
            {/* ⚠️ **不能再写「更多出款单请联系平台」** —— 现在有翻页控件了，
                商家自己就能翻到下一页（阶段 5l）。 */}
          </p>
          {/* ⚠️ **每页条数三档** —— 默认 100（与改造前一致） */}
          <div className="flex gap-2 text-sm">
            {PAGE_SIZE_OPTIONS.map((size) => (
              <Link
                key={size}
                href={`?page=1&pageSize=${size}`}
                className={
                  size === pageSize
                    ? 'underline font-medium'
                    : 'underline-offset-4 hover:underline'
                }
              >
                {size}
              </Link>
            ))}
            <span className="text-muted-foreground">条 / 页</span>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th>周期</th>
                <th>类型</th>
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
                  <td colSpan={8} className="py-4 text-muted-foreground">
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
                    {/* ⚠️ **用 `describePayoutKind` 而不是内联三元**：
                        文案与平台端统一（「补差出款 / 正常出款」），
                        且未知枚举值有回落 —— 内联三元会把新枚举误标成「正常」。 */}
                    <td>{describePayoutKind(payout.kind)}</td>
                    <td>
                      {describePayoutStatus(payout.status)}
                      {/* ⚠️ **失败原因直接用后端给的业务口径**（阶段 5l）——
                          后端按「钱打没打出去」分流：
                          ① 确定没打（账户不可用 / 金额异常 / 人工转失败）
                             → 「收款账号信息异常，本次未打款，请更新收款账户后重新申请」
                          ② 可能已打（渠道试满 / 金额核对不通过）
                             → 「出款未完成，请联系平台确认出款情况」
                          ⚠️ **前端不要自己拼措辞** —— 两端必须一套说法，
                          而且「哪些失败意味着没打钱」的知识在后端
                          （那里才有 `failedBeforePayout` 这个事实依据）。 */}
                      {payout.status === 'FAILED' && payout.failureReason && (
                        <p className="text-xs text-destructive">
                          {payout.failureReason}
                        </p>
                      )}
                    </td>
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
          {/* ⚠️ **翻页** —— 纯服务端：`<Link>` 改 URL，Server Component 重渲染。
              商家端没有筛选条件，所以翻页链接只需要带 `page` 与 `pageSize`。 */}
          {totalPages > 1 && (
            <div className="flex items-center gap-4 text-sm">
              <Link
                href={`?page=${Math.max(1, page - 1)}&pageSize=${pageSize}`}
                className={
                  page <= 1
                    ? 'pointer-events-none opacity-40'
                    : 'underline-offset-4 hover:underline'
                }
              >
                上一页
              </Link>
              <span>
                第 {page} / {totalPages} 页，共 {total} 张
              </span>
              <Link
                href={`?page=${Math.min(totalPages, page + 1)}&pageSize=${pageSize}`}
                className={
                  page >= totalPages
                    ? 'pointer-events-none opacity-40'
                    : 'underline-offset-4 hover:underline'
                }
              >
                下一页
              </Link>
            </div>
          )}
        </>
      )}
    </div>
  );
}
