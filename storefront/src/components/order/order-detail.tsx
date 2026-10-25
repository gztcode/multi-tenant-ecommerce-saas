'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { ORDER_STATUS_LABEL, consumerActions } from '@/lib/cart';
import { formatPrice } from '@/lib/format';
import type { Order, OrderStatus } from '@/lib/cart';

/**
 * 消费者侧订单详情：订单项快照、收货信息、支付信息，
 * 以及「去支付」「取消订单」「确认收货」三个操作。
 *
 * 逻辑内嵌在组件内部，没有从 Server Component 往下传回调——
 * Server → Client 传函数在 tsc 与 next build 下都能过，
 * 只有真正渲染这一页时才 500。
 */
export function OrderDetail({ initial }: { initial: Order }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const actions = consumerActions(initial.status);

  /**
   * 发起支付，然后跳到支付页面。
   *
   * 支付页面在**后端服务**上（假网关是 `GET /api/v1/pay/fake/:paymentId`），
   * 中转路由已经把它拼成了绝对 URL——真实渠道也是同样的形态
   * （微信给 code_url、支付宝给支付 URL，前端只负责跳过去）。
   *
   * ⚠️ 用 `window.location.assign` 而不是 `<a href>` / `router.push`：
   * 支付页面是**站外**的地址（另一个服务），Router 的客户端导航管不了它。
   */
  async function pay() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/orders/${initial.orderNo}/pay`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new Error(payload.message ?? '发起支付失败');
      }
      const payment = (await response.json()) as { payUrl: string };
      window.location.assign(payment.payUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '发起支付失败');
      setBusy(false);
    }
  }

  async function cancel() {
    if (!confirm('确定取消这笔订单？取消后预占的库存会释放。')) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/orders/${initial.orderNo}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new Error(payload.message ?? '取消订单失败');
      }
      setMessage('订单已取消');
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '取消订单失败');
    } finally {
      setBusy(false);
    }
  }

  async function confirmReceipt() {
    if (!confirm('确定已收到货？')) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/orders/${initial.orderNo}/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new Error(payload.message ?? '确认收货失败');
      }
      setMessage('已确认收货');
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '确认收货失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-bold font-mono">{initial.orderNo}</h2>
        <p className="text-sm text-muted-foreground">
          {ORDER_STATUS_LABEL[initial.status as OrderStatus]} ·{' '}
          {new Date(initial.createdAt).toLocaleString('zh-CN')}
        </p>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {message && <p className="text-sm text-muted-foreground">{message}</p>}

      <div className="flex flex-wrap gap-2">
        {actions.canPay && (
          <Button disabled={busy} onClick={pay}>
            去支付
          </Button>
        )}
        {actions.canCancel && (
          <Button variant="outline" disabled={busy} onClick={cancel}>
            取消订单
          </Button>
        )}
        {actions.canConfirm && (
          <Button disabled={busy} onClick={confirmReceipt}>
            确认收货
          </Button>
        )}
      </div>

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
          <p className="text-sm text-muted-foreground">备注：{initial.remark}</p>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="font-semibold">支付信息</h3>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          {/* ⚠️ **优惠快照**（护栏 M12）：这三行显示的是**下单那一刻**
              算出来的金额，不是现在重新算的。券的规则改了、券被删了，
              历史订单的金额都不受影响——所以它们是订单上的快照字段。 */}
          {initial.originalAmount > initial.totalAmount && (
            <>
              <dt className="text-muted-foreground">商品原价</dt>
              <dd>{formatPrice(initial.originalAmount)}</dd>
              {initial.promotionDiscountAmount > 0 && (
                <>
                  <dt className="text-muted-foreground">活动减免</dt>
                  <dd>-{formatPrice(initial.promotionDiscountAmount)}</dd>
                </>
              )}
              {initial.couponDiscountAmount > 0 && (
                <>
                  <dt className="text-muted-foreground">优惠券</dt>
                  <dd>
                    -{formatPrice(initial.couponDiscountAmount)}
                    {initial.couponName ? `（${initial.couponName}）` : ''}
                  </dd>
                </>
              )}
            </>
          )}
          <dt className="text-muted-foreground">应付金额</dt>
          <dd>¥{(initial.totalAmount / 100).toFixed(2)}</dd>
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
              <th className="w-20">单价</th>
              <th className="w-16">数量</th>
              <th className="w-24">小计</th>
            </tr>
          </thead>
          <tbody>
            {(initial.items ?? []).map((item) => (
              <tr key={item.id} className="border-b">
                <td>{item.productName}</td>
                <td>¥{(item.unitPrice / 100).toFixed(2)}</td>
                <td>{item.quantity}</td>
                <td>¥{(item.subtotal / 100).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
