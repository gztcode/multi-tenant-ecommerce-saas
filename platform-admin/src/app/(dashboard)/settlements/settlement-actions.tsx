'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import {
  type SettlementGenerateResult,
  type SettlementStatus,
} from '@/lib/billing';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * 结算单的**写操作**（生成 / 确认 / 取消确认 / 重算）。
 *
 * ⚠️ **所有写操作都走同源的 `/api/**` 中转**（不是直连后端）：
 * 后端没开 CORS，而且 accessToken 不该进客户端代码。
 *
 * ⚠️ **闸门读的是 ref 不是 state**：state 同一 tick 内还是旧值，
 * 连点两次会一起通过检查发出两次请求（重复生成）。ref 是同步写的。
 */

/** 统一的失败文案前缀 */
const FAILURE_TEXT = '操作失败';

/**
 * 读取中转路由的错误体。
 *
 * ⚠️ **先判断 `response.ok` 再决定要不要解析**：中转可能返回 204 无内容，
 * 对 204 调 `response.json()` 会抛「body 已消费」。
 */
async function readFailure(
  response: Response,
  fallback: string,
): Promise<string | null> {
  if (response.ok) return null;
  const payload = (await response.json().catch(() => ({}))) as {
    message?: string;
  };
  return payload.message ?? fallback;
}

/**
 * 把生成结果拼成一段给超管看的文案。
 *
 * ⚠️ **`conflicts` / `stale` 都不是失败**：批量生成时后端不中断整批，
 * 其余商家的单据照样建好了。所以这里是在**成功文案后面追加**信息，
 * 而不是改成错误提示 —— 否则超管会以为整批都没出，要重做一遍。
 *
 * ⚠️ **`conflicts` 里带的是后端给的中文 `message`**（含订单号等排查线索），
 * 直接透出来比只报个数量有用得多。
 *
 * ⚠️ **`stale` 里是 `tenantId`**：界面上显示裸 UUID 对超管没有意义，
 * 只报数量，具体是哪几家让用户到列表页自己看。
 */
function describeGenerateResult(result: SettlementGenerateResult): string {
  const parts = [
    `已新建 ${result.created} 张结算单` +
      (result.skipped > 0 ? `，复用 ${result.skipped} 张已有单据` : ''),
  ];

  const conflicts = result.conflicts ?? [];
  if (conflicts.length > 0) {
    parts.push(
      `有 ${conflicts.length} 个商家没能出单（其余商家已出单成功）：` +
        conflicts.map((conflict) => conflict.message).join('；'),
    );
  }

  const stale = result.stale ?? [];
  if (stale.length > 0) {
    parts.push(
      `有 ${stale.length} 个已有单据与当期流水对不上（可能缺笔），` +
        '请到结算单列表里对该单据「取消确认」后「重算」以修正金额。',
    );
  }

  return parts.join('。');
}

/**
 * 生成结算单的表单。
 *
 * ⚠️ **默认月份用 URL 里带来的那个**：超管通常是在「看某个月」的页面上
 * 决定生成那个月的单据。
 */
export function SettlementGenerateForm({ period }: { period?: string }) {
  const router = useRouter();
  const [value, setValue] = useState(period ?? '');
  const [success, setSuccess] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);

  async function handleGenerate() {
    if (busyRef.current) return;

    setSuccess(null);
    setFailure(null);

    const trimmed = value.trim();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(trimmed)) {
      setFailure('周期格式非法：必须是 YYYY-MM（如 2026-10）');
      return;
    }

    if (
      !confirm(
        `确定生成 ${trimmed} 的结算单？\n` +
          '会给该期所有有流水的商家各建一张单据。',
      )
    ) {
      return;
    }

    busyRef.current = true;
    setBusy(true);
    try {
      const response = await fetch('/api/billing/settlements', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ period: trimmed }),
      });
      const problem = await readFailure(response, FAILURE_TEXT);
      if (problem) throw new Error(problem);

      // ⚠️ **用 `lib/billing.ts` 里共享的类型**，不要在这里手写局部类型：
      // 后端改了响应体形状（例如 `created` 改名），手写的那份不会报任何错。
      const result = (await response.json()) as SettlementGenerateResult;
      setSuccess(describeGenerateResult(result));
      // ⚠️ **成功后必须 router.refresh()**：列表是服务端渲染的，
      // 不刷新就看不到新单据。
      router.refresh();
    } catch (cause) {
      setFailure(
        `${FAILURE_TEXT}：${cause instanceof Error ? cause.message : '未知错误'}`,
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>生成结算单</CardTitle>
        <CardDescription>
          按自然月（UTC）给该期所有有流水的商家各建一张单据。
          周期必须已经结束。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="settlement-period">结算周期</Label>
            <Input
              id="settlement-period"
              type="month"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="如 2026-10"
            />
          </div>
          <div className="flex justify-end">
            <Button type="button" disabled={busy} onClick={handleGenerate}>
              {busy ? '生成中…' : '生成'}
            </Button>
          </div>
          {failure && (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          )}
          {success && (
            <p role="status" className="text-sm text-primary">
              {success}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * 单据上的状态操作按钮。
 *
 * ⚠️ **重算与取消确认都要 `confirm()`**：改的是账。
 */
export function SettlementRowActions({
  statementId,
  status,
}: {
  statementId: string;
  /**
   * ⚠️ **用 `lib/billing.ts` 里共享的 `SettlementStatus`，不要就地重写联合**：
   * 就地重写的那份与共享类型没有任何约束关系，后端加状态时漏改的是这里，
   * 报错点却会落在调用方（列表页 / 详情页），错误信息是「类型不兼容」
   * 而不是「状态枚举漏改了」。
   */
  status: SettlementStatus;
}) {
  const router = useRouter();
  const [failure, setFailure] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);

  async function run(
    action: 'confirm' | 'unconfirm' | 'recalculate',
    confirmText: string,
  ) {
    if (busyRef.current) return;
    if (!confirm(confirmText)) return;

    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const response = await fetch(
        `/api/billing/settlements/${statementId}/${action}`,
        { method: 'POST' },
      );
      const problem = await readFailure(response, FAILURE_TEXT);
      if (problem) throw new Error(problem);

      router.refresh();
    } catch (cause) {
      setFailure(
        `${FAILURE_TEXT}：${cause instanceof Error ? cause.message : '未知错误'}`,
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex gap-2">
        {status === 'DRAFT' && (
          <>
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() =>
                run('confirm', '确定确认这张结算单？确认后金额与明细冻结。')
              }
            >
              确认
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                run(
                  'recalculate',
                  '确定重算这张结算单？会按当前抽佣流水重新算一遍。',
                )
              }
            >
              重算
            </Button>
          </>
        )}
        {status === 'CONFIRMED' && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() =>
              run(
                'unconfirm',
                '确定取消确认？取消后可以重算 —— 通常是为了修正漏结的流水。',
              )
            }
          >
            取消确认
          </Button>
        )}
      </div>
      {failure && (
        <p role="alert" className="text-xs text-destructive">
          {failure}
        </p>
      )}
    </div>
  );
}
