import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import {
  describePayoutAccount,
  describePayoutEntryType,
  describePayoutKind,
  describePayoutOperation,
  describePayoutStatus,
  describePayoutTimeline,
  formatCents,
  type PlatformPayoutDetail,
} from '@/lib/payout';
// ⚠️ **复用 `lib/billing.ts` 的 `formatDateTime`，不要在这里另写一份**：
//    两份实现迟早漂（时区格式、失败回显的措辞都会不一样）。
import { formatDateTime } from '@/lib/billing';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

import { PayoutActions } from '../payout-actions';

/**
 * 平台侧出款单详情页（Server Component）。
 *
 * ⚠️ **明细的金额直接展示后端给的值**：明细是流水 join 出来的，
 *    前端不自己加总（与结算单详情页同款原则）。
 */
export default async function PayoutDetailPage({
  params,
}: {
  // Next.js 15 起 params 是 Promise，必须 await。
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let payout: PlatformPayoutDetail | null = null;
  let error: string | null = null;

  try {
    payout = await apiFetchAuthed<PlatformPayoutDetail>(
      `/platform/payouts/${id}`,
    );
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 404) {
      notFound();
    }
    error =
      cause instanceof ApiError
        ? `加载出款单失败（${cause.status}）：${cause.message}`
        : cause instanceof Error
          ? cause.message
          : '出款单加载失败';
  }

  if (!payout) {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="text-2xl font-bold">出款单详情</h2>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    );
  }

  // ⚠️ **先算一次再渲染**：条件与内容用同一个值，
  //    免得两处各调一次函数（万一将来它不是纯函数就会不一致）。
  const accountText = describePayoutAccount(payout);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">出款单详情</h2>
        <Link
          href="/payouts"
          className="text-sm underline-offset-4 hover:underline"
        >
          返回列表
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {payout.tenantName} · {payout.periodLabel}
          </CardTitle>
          <CardDescription>
            单号 {payout.payoutNo} · {describePayoutStatus(payout.status)}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3">
            <div className="flex gap-6 text-sm">
              <span>货款净额 {formatCents(payout.receiptAmount)}</span>
              <span>佣金 {formatCents(payout.commissionAmount)}</span>
              <span className="font-medium">
                应结金额 {formatCents(payout.netAmount)}
              </span>
              <span className="text-muted-foreground">
                {payout.entryCount} 笔
              </span>
            </div>

            {/* ⚠️ **申请时的预估金额要单独显示**：审批时平台会**重算**
                并锁定金额，两者可能不同 —— 超管看到的「当前应结」是重算后的
                那个值，而商家申请时看到的是另一个数。 */}
            <p className="text-sm text-muted-foreground">
              申请时预估 {formatCents(payout.requestedAmount)}
              （审批通过时平台会重算一次并锁定，可能与上值不同）
            </p>

            {/* ⚠️ **收款账户要显示出来**：超管必须能看出「这笔钱打给谁」。
                阶段 5j 之后库里只有密文，**掩码串是唯一能核对的东西** ——
                界面上不显示它，运营就彻底没法核对打给谁了。

                ⚠️ **这不是 5j 引入的缺口**，是 5h-2 交付时就没有渲染过；
                    5j 只是让它变得更要紧（明文也没了，掩码串成了唯一线索）。

                ⚠️ **只显示掩码串，绝不显示完整账号** —— 完整账号压根不在响应里，
                    前端也不去解密。 */}
            {accountText && (
              <div className="flex justify-between py-2 text-sm">
                <span className="text-muted-foreground">收款账户</span>
                <span>{accountText}</span>
              </div>
            )}

            {/* ⚠️ **时间说明按 `status` 走，不按「字段非空」走**：
                后端 `reject()` 也填 `approvedAt`（拒绝同样是一次审批动作），
                按字段非空显示就会出现「已拒绝 · 已审批」这种自相矛盾的说法。 */}
            <div className="text-sm text-muted-foreground">
              {describePayoutTimeline(payout)}
            </div>

            {payout.rejectedReason && (
              <p className="text-sm text-destructive">
                拒绝原因：{payout.rejectedReason}
              </p>
            )}

            {/* ⚠️ **只在 APPROVED 时显示备注**：入队失败的单停在 APPROVED，
                而失败原因只在 FAILED 时渲染 → 这行是「这张单刚入队失败过、
                正在等兜底扫描救援」的**唯一信号**。

                ⚠️ **平台端加、商家端不加** —— 商家看到「已审批 + 系统将自动重试」
                只会困惑（「重试什么？是不是要我做什么？」），超管看到它就知道
                `scanStuck` 会救它。 */}
            {payout.status === 'APPROVED' && payout.failureReason && (
              <div className="flex justify-between py-2 text-sm text-muted-foreground">
                <span>备注</span>
                <span>{payout.failureReason}</span>
              </div>
            )}

            {/* ⚠️ **类型要单独一行**：补差出款是**增量**，
                混在正常出款里超管会按同一口径核账。 */}
            <div className="flex justify-between py-2 text-sm">
              <span className="text-muted-foreground">类型</span>
              <span>{describePayoutKind(payout.kind)}</span>
            </div>

            {/* ⚠️ **失败原因与尝试次数**：运营需要知道「试了几次、为什么失败」
                才能决定是补单还是让商家改收款信息。 */}
            {payout.status === 'FAILED' && (
              <div className="flex justify-between py-2 text-sm text-destructive">
                <span>失败原因</span>
                <span>
                  {payout.failureReason ?? '未知原因'}（已尝试{' '}
                  {payout.attemptCount} 次）
                </span>
              </div>
            )}

            {/* ⚠️ **失败详情 = 渠道侧的原文**（只有平台端有）——
                超管排查要靠它（「Unsupported state or unable to
                authenticate data」比「收款账号信息异常」有用得多）。
                ⚠️ **看不到解密根因** —— 那是只进日志的（5k 的遗留 4）。 */}
            {payout.failureDetail && (
              <div className="flex justify-between py-2 text-sm text-muted-foreground">
                <span>失败详情</span>
                <span className="max-w-[60%] break-words text-right">
                  {payout.failureDetail}
                </span>
              </div>
            )}

            {/* ⚠️ **打款渠道名**：超管要看到「钱是打给哪个渠道的」——
                对账、排查重复打款都靠这条线索。渠道名**只给平台端**，
                商家不关心（商家端页面不显示这一项）。 */}
            {payout.payoutChannel && (
              <div className="flex justify-between py-2 text-sm">
                <span className="text-muted-foreground">打款渠道</span>
                <span>{payout.payoutChannel}</span>
              </div>
            )}

            {/* ⚠️ **打款时刻 / 失败时刻**：出款单到底什么时候打成功的、
                什么时候失败的 —— 超管排查「卡住」与对账都要看这两个时刻。
                时间格式复用 `lib/billing.ts` 的 `formatDateTime`。 */}
            {payout.status === 'PAID' && payout.paidAt && (
              <div className="flex justify-between py-2 text-sm">
                <span className="text-muted-foreground">打款时间</span>
                <span>{formatDateTime(payout.paidAt)}</span>
              </div>
            )}
            {payout.status === 'FAILED' && payout.failedAt && (
              <div className="flex justify-between py-2 text-sm text-destructive">
                <span>失败时间</span>
                <span>{formatDateTime(payout.failedAt)}</span>
              </div>
            )}

            {/* ⚠️ **操作记录** —— 涉及钱的操作必须能追溯「谁在什么时候
                把这张单怎么了」。留痕写进库里还不够，要看得见。 */}
            {payout.operations.length > 0 && (
              <div className="flex flex-col gap-1 border-t pt-2 text-sm">
                <span className="text-muted-foreground">操作记录</span>
                {payout.operations.map((op) => (
                  <p key={op.id} className="text-muted-foreground">
                    {formatDateTime(op.operatedAt)} · {op.operatorName} ·{' '}
                    {describePayoutOperation(op.action)} · {op.reason}
                  </p>
                ))}
              </div>
            )}

            <PayoutActions
              payoutId={payout.id}
              status={payout.status}
              requestedAmount={payout.requestedAmount}
              failedBeforePayout={payout.failedBeforePayout}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>出款明细</CardTitle>
          <CardDescription>这一期纳入的货款流水，金额单位：元。</CardDescription>
        </CardHeader>
        <CardContent>
          {payout.entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无明细。</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>订单号</TableHead>
                  <TableHead>类型</TableHead>
                  <TableHead>金额</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payout.entries.map((entry) => (
                  <TableRow key={entry.entryId}>
                    <TableCell className="text-muted-foreground">
                      {formatDateTime(entry.occurredAt)}
                    </TableCell>
                    <TableCell>{entry.orderNo}</TableCell>
                    {/* ⚠️ **不显示裸枚举**（`SALE` / `SALE_REVERSAL`） */}
                    <TableCell>{describePayoutEntryType(entry.type)}</TableCell>
                    <TableCell>{formatCents(entry.amount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
