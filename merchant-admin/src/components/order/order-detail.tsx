'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatPrice } from '@/components/product/format';
import {
  ORDER_STATUS_LABEL,
  merchantActions,
  type MerchantOrder,
  type OrderStatus,
} from '@/components/order/types';

/**
 * 商家侧订单详情：订单项快照、收货信息、支付信息、发货表单、退款按钮。
 *
 * 逻辑内嵌在组件内部，没有从 Server Component 往下传回调——
 * Server → Client 传函数在 tsc 与 next build 下都能过，
 * 只有真正渲染这一页时才 500。
 */
export function OrderDetail({ initial }: { initial: MerchantOrder }) {
  const router = useRouter();
  const [trackingNo, setTrackingNo] = useState(initial.trackingNo ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const actions = merchantActions(initial.status);

  async function ship(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/orders/${initial.orderNo}/ship`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ trackingNo: trackingNo.trim() }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new Error(payload.message ?? '发货失败');
      }
      setMessage('已发货');
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '发货失败');
    } finally {
      setBusy(false);
    }
  }

  async function refund() {
    if (
      !confirm(
        '确定整单退款？\n\n退款只退钱，库存不会自动加回——退货入库是另一套流程。',
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/orders/${initial.orderNo}/refund`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new Error(payload.message ?? '退款失败');
      }
      setMessage('已退款');
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '退款失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-bold font-mono">{initial.orderNo}</h2>
        <p className="text-xs text-muted-foreground">
          {ORDER_STATUS_LABEL[initial.status as OrderStatus]} ·{' '}
          {new Date(initial.createdAt).toLocaleString('zh-CN')}
        </p>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {message && <p className="text-sm text-muted-foreground">{message}</p>}

      {actions.canShip && (
        <section className="flex flex-col gap-2 rounded-md border p-4">
          <h3 className="font-semibold">发货</h3>
          <form onSubmit={ship} className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              快递单号
              <input
                value={trackingNo}
                onChange={(event) => setTrackingNo(event.target.value)}
                placeholder="如 SF1234567890"
                maxLength={100}
                required
                className="rounded-md border px-2 py-1 text-sm"
              />
            </label>
            <button
              type="submit"
              disabled={busy || trackingNo.trim() === ''}
              className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-40"
            >
              {busy ? '提交中…' : '确认发货'}
            </button>
          </form>
        </section>
      )}

      {actions.canRefund && (
        <section className="flex flex-col gap-2 rounded-md border p-4">
          <h3 className="font-semibold">退款</h3>
          <button
            type="button"
            disabled={busy}
            onClick={refund}
            className="self-start rounded-md border border-destructive px-3 py-1.5 text-sm text-destructive disabled:opacity-40"
          >
            整单退款
          </button>
          {/* 这行说明不能省：商家看到「退款后库存没变」会以为系统坏了。
              退款只退钱，库存的回补是「退货入库」那套流程的事（设计 §7.1）。 */}
          <p className="text-xs text-muted-foreground">
            退款只退钱，库存不会自动加回——退货入库是另一套流程。
          </p>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="font-semibold">收货信息</h3>
        <p className="text-sm">
          {initial.receiverName} {initial.receiverPhone}
        </p>
        <p className="text-sm text-muted-foreground">
          {initial.province}
          {initial.city}
          {initial.district}
          {initial.detail}
        </p>
        {initial.remark && (
          <p className="text-sm text-muted-foreground">
            买家备注：{initial.remark}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="font-semibold">支付与物流</h3>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">订单金额</dt>
          <dd>{formatPrice(initial.totalAmount)}</dd>
          <dt className="text-muted-foreground">件数</dt>
          <dd>{initial.itemCount}</dd>
          <dt className="text-muted-foreground">支付渠道</dt>
          <dd>{initial.payChannel ?? '—'}</dd>
          <dt className="text-muted-foreground">支付时间</dt>
          <dd>
            {initial.paidAt
              ? new Date(initial.paidAt).toLocaleString('zh-CN')
              : '—'}
          </dd>
          <dt className="text-muted-foreground">发货时间</dt>
          <dd>
            {initial.shippedAt
              ? new Date(initial.shippedAt).toLocaleString('zh-CN')
              : '—'}
          </dd>
          <dt className="text-muted-foreground">快递单号</dt>
          <dd>{initial.trackingNo ?? '—'}</dd>
        </dl>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="font-semibold">商品</h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th>商品</th>
              <th className="w-24">单价</th>
              <th className="w-16">数量</th>
              <th className="w-24">小计</th>
            </tr>
          </thead>
          <tbody>
            {(initial.items ?? []).map((item) => (
              <tr key={item.id} className="border-b">
                <td>{item.productName}</td>
                <td>{formatPrice(item.unitPrice)}</td>
                <td>{item.quantity}</td>
                <td>{formatPrice(item.subtotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
