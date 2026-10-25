'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AddressForm } from '@/components/address/address-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  formatAddress,
  itemSubtotal,
  toOrderItems,
  totalAmount,
} from '@/lib/cart';
import { formatPrice } from '@/lib/format';
import type { Address, Cart } from '@/lib/cart';

/**
 * 结算表单：选地址、填备注、提交下单。
 *
 * ## 幂等键（这一页最重要的一件事）
 *
 * 幂等键在**进入结算页时**生成并**持有在 state 里**，提交失败重试时复用
 * 同一个键。
 *
 * ⚠️ **绝不能「点提交时才生成」**——用户点一次、网络超时、页面没跳转，
 * 再点一次就成两个订单（两个订单都占库存）。
 *
 * 为什么还要写进 `sessionStorage`：用户提交失败后**刷新页面**再提交，
 * `useState` 里的键就丢了，会生成新的键 → 两个订单。
 * sessionStorage 活到标签页关闭，正好覆盖「同一次结算尝试」这个范围。
 */

/** sessionStorage 里存幂等键的键名 */
const IDEMPOTENCY_STORAGE_KEY = 'checkout.idempotencyKey';

/**
 * 取出本次结算尝试的幂等键，没有就生成一个。
 *
 * ⚠️ SSR 阶段没有 sessionStorage（也没有 window），所以只在客户端调用；
 * 首屏渲染用 useState 的默认值占位，服务端与客户端的第一次渲染必须一致
 * （否则 React 会报 hydration mismatch）。
 */
function useIdempotencyKey(): string {
  const [key, setKey] = useState('');

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.sessionStorage.getItem(IDEMPOTENCY_STORAGE_KEY);
    } catch {
      // 隐私模式下 sessionStorage 可能抛错，忽略即可（退化成每次生成新的）
    }

    if (stored) {
      setKey(stored);
      return;
    }

    const fresh = crypto.randomUUID();
    setKey(fresh);
    try {
      window.sessionStorage.setItem(IDEMPOTENCY_STORAGE_KEY, fresh);
    } catch {
      // 存不进去就算了，本次页面生命周期内仍然是同一个键
    }
  }, []);

  return key;
}

/** 结算成功后清掉幂等键——下一次结算是新的尝试 */
function clearIdempotencyKey() {
  try {
    window.sessionStorage.removeItem(IDEMPOTENCY_STORAGE_KEY);
  } catch {
    // 忽略
  }
}

export function CheckoutForm({
  cart,
  addresses,
  loggedIn,
}: {
  cart: Cart;
  addresses: Address[];
  /** 是否已登录（没登录不能下单——后端整组挂 JwtAuthGuard） */
  loggedIn: boolean;
}) {
  const router = useRouter();
  const idempotencyKey = useIdempotencyKey();

  const [addressId, setAddressId] = useState<string>(
    addresses.find((a) => a.isDefault)?.id ?? addresses[0]?.id ?? '',
  );
  const [remark, setRemark] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAddressForm, setShowAddressForm] = useState(addresses.length === 0);

  async function submitOrder(event: React.FormEvent) {
    event.preventDefault();
    if (!addressId) {
      setError('请先选择收货地址');
      return;
    }
    // ⚠️ 幂等键还没生成（首屏还没跑完 effect）时不能提交——
    // 提交一个空键会让后端把每次请求都当成新订单，幂等就失效了。
    if (!idempotencyKey) {
      setError('页面还没准备好，请稍后再试');
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const response = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          addressId,
          items: toOrderItems(cart.items ?? []),
          idempotencyKey,
          ...(remark.trim() ? { remark: remark.trim() } : {}),
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new Error(payload.message ?? '下单失败');
      }

      const order = (await response.json()) as { orderNo: string };

      clearIdempotencyKey();
      router.push(`/orders/${order.orderNo}`);
    } catch (cause) {
      // ⚠️ 失败时**不**换幂等键：用户重试要用同一个键，
      // 否则第一次其实已经下单成功（只是响应没回来）时会变成两个订单。
      setError(cause instanceof Error ? cause.message : '下单失败');
    } finally {
      setBusy(false);
    }
  }

  if (!loggedIn) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">下单需要先登录。</p>
        <Button onClick={() => router.push('/login')}>去登录</Button>
      </div>
    );
  }

  /** 新增地址成功后选中新地址 */
  function setAddressesAndSelect(address: Address) {
    setAddressId(address.id);
    setShowAddressForm(false);
    router.refresh();
  }

  return (
    <form onSubmit={submitOrder} className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">收货地址</h2>
        {addresses.length === 0 && !showAddressForm && (
          <p className="text-sm text-muted-foreground">还没有收货地址。</p>
        )}
        {addresses.length > 0 && (
          <div className="flex flex-col gap-2">
            {addresses.map((address) => (
              <label
                key={address.id}
                className={[
                  'flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm',
                  addressId === address.id ? 'border-primary' : '',
                ].join(' ')}
              >
                <input
                  type="radio"
                  name="addressId"
                  value={address.id}
                  checked={addressId === address.id}
                  onChange={() => setAddressId(address.id)}
                  className="mt-1"
                />
                <span className="flex flex-col gap-0.5">
                  <span>
                    {address.receiver} {address.phone}
                    {address.isDefault && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        默认
                      </span>
                    )}
                  </span>
                  <span className="text-muted-foreground">
                    {formatAddress(address)}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}

        <button
          type="button"
          onClick={() => setShowAddressForm((prev) => !prev)}
          className="self-start text-sm underline"
        >
          {showAddressForm ? '收起' : '新增地址'}
        </button>

        {showAddressForm && (
          <AddressForm
            mode="create"
            onCreated={(address) => {
              setAddressesAndSelect(address);
            }}
          />
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">买家备注</h2>
        <Input
          value={remark}
          onChange={(event) => setRemark(event.target.value)}
          placeholder="选填，比如「工作日送货」"
          maxLength={500}
        />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">商品</h2>
        <ul className="flex flex-col gap-1 text-sm">
          {(cart.items ?? []).map((item) => (
            <li key={item.id} className="flex items-baseline justify-between gap-4">
              <span>
                {item.sku?.product.name ?? '商品已下架'}
                <span className="ml-2 text-muted-foreground">
                  {formatPrice(item.sku?.price)} × {item.quantity}
                </span>
              </span>
              <span>
                {formatPrice(itemSubtotal(item))}
              </span>
            </li>
          ))}
        </ul>
        <p className="text-sm">
          合计 {formatPrice(totalAmount(cart.items ?? []))}
        </p>
        <p className="text-xs text-muted-foreground">
          金额由服务端按下单时的 SKU 价格计算，页面上的数字不是最终金额。
        </p>
      </section>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Button type="submit" disabled={busy || !idempotencyKey}>
        {busy ? '提交中…' : '提交订单'}
      </Button>
    </form>
  );
}
