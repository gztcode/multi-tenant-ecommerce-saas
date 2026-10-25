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
import { couponUsable, previewBreakdown } from '@/lib/coupon';
import { formatPrice } from '@/lib/format';
import type { Address, Cart } from '@/lib/cart';
import type { CouponPreview } from '@/lib/coupon';

/**
 * 结算表单：选地址、填备注、选优惠券、提交下单。
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
 *
 * ## 优惠券与幂等键的关系
 *
 * ⚠️ **优惠券的选择不进幂等键**：改了券再提交，用的是**同一个**键 →
 * 后端返回**第一次的订单**（幂等键命中），券也是那一次的。
 *
 * 这是幂等的正确语义（同一个键 = 同一次下单尝试），所以**不**在改券时
 * 换键——换了键就会在第一次其实已经下单成功的情况下变成两个订单，
 * 而两个订单抢同一批库存，第二个多半因库存被占而失败。
 * 提交失败后页面会给用户一句提示，让他知道这次仍会命中上一次的订单。
 *
 * ## 金额是估算值
 *
 * ⚠️ 页面上的优惠金额来自**后端算好的预览**（`GET /coupons/preview`），
 * 原价用的是购物车里的 SKU 价格。下单时服务端会锁住 SKU 按**实时价**
 * 重算，所以真实金额以**下单响应**为准，页面要提示「以提交时为准」。
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
  preview,
}: {
  cart: Cart;
  addresses: Address[];
  /** 是否已登录（没登录不能下单——后端整组挂 JwtAuthGuard） */
  loggedIn: boolean;
  /**
   * 优惠预览（后端算好的估算值）。
   *
   * ⚠️ **null 表示预览没拿到**（未登录或后端出错）：这时不显示优惠行，
   * 也不给用户选券——不是「显示 0 优惠」，那会骗人。
   */
  preview: CouponPreview | null;
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
  /**
   * 选中的券 id；空串 = **自动选择最优券**。
   *
   * ⚠️ **空串不是「不使用优惠券」**：后端在没收到 `couponId` 时会
   * 自动取最优券（`api/src/modules/coupon/coupon.service.ts` 的
   * `computeForOrder`）。前端要是显示「不使用优惠券」却让后端自动用了券，
   * 界面上的实付就和真实实付对不上（护栏 M17）。
   */
  const [couponId, setCouponId] = useState<string>('');
  /** 上一次提交有没有失败——用来提示「改了券也会命中上一次的订单」 */
  const [submitFailed, setSubmitFailed] = useState(false);

  const cartTotal = totalAmount(cart.items ?? []);
  /** 四行金额（预览拿不到时是 null，页面退回显示原价） */
  const breakdown = preview ? previewBreakdown(preview, couponId) : null;
  /**
   * **活动后**的金额。
   *
   * ⚠️ **只用来给「不可用」的券写一句说明文案，不参与任何计算**——
   * 能不能用是后端引擎说了算（`couponUsable` 判的是引擎算出的减免额）。
   * 这里复算一遍门槛只是为了告诉用户「差多少」，文案错了也只是
   * 说明得不准，不影响能不能用。
   */
  const afterPromotion = preview
    ? preview.originalAmount - preview.promotionDiscountAmount
    : 0;

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
          // ⚠️ **只传 id**：面额与门槛一律由后端从库里读（护栏 M1 / M2）。
          // 选了具体的券才传；空串（自动选择最优）不传——
          // 后端收到没有 couponId 的请求时会自己挑最优的那张。
          ...(couponId ? { couponId } : {}),
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
      setSubmitFailed(true);
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
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">优惠券</h2>
        {!preview ? (
          <p className="text-sm text-muted-foreground">
            优惠信息加载失败，暂时不能使用优惠券。
          </p>
        ) : preview.coupons.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无可用的优惠券。</p>
        ) : (
          <select
            value={couponId}
            onChange={(event) => setCouponId(event.target.value)}
            aria-label="优惠券"
            className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {/* ⚠️ **默认项是「自动选择最优」，不是「不使用优惠券」**：
                后端在没收到 couponId 时会自己挑最优的那张券，
                默认项写成「不使用」会让界面上的实付和真实实付对不上（M17）。 */}
            <option value="">
              自动选择最优
              {preview.bestCouponDiscountAmount > 0
                ? `（减 ${formatPrice(preview.bestCouponDiscountAmount)}）`
                : ''}
            </option>
            {preview.coupons.map((coupon) => {
              const usable = couponUsable(coupon);
              return (
                <option key={coupon.id} value={coupon.id} disabled={!usable}>
                  {coupon.name}
                  {usable
                    ? `（减 ${formatPrice(coupon.discountAmount)}）`
                    : coupon.minAmount > afterPromotion
                      ? `（未满 ${formatPrice(coupon.minAmount)} 门槛）`
                      : '（本次不可用）'}
                </option>
              );
            })}
          </select>
        )}
        {submitFailed && (
          <p className="text-xs text-muted-foreground">
            上一次提交没拿到结果。这次仍复用同一个幂等键——如果订单其实已经生成，返回的会是上一次的订单（用的也是上一次的优惠券）。
          </p>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">金额</h2>
        <dl className="flex flex-col gap-1 text-sm">
          <div className="flex items-baseline justify-between">
            <dt className="text-muted-foreground">商品原价</dt>
            <dd>{formatPrice(cartTotal)}</dd>
          </div>
          {breakdown && breakdown.promotionDiscountAmount > 0 && (
            <div className="flex items-baseline justify-between">
              <dt className="text-muted-foreground">
                活动减免
                {preview?.promotionName ? `（${preview.promotionName}）` : ''}
              </dt>
              <dd>-{formatPrice(breakdown.promotionDiscountAmount)}</dd>
            </div>
          )}
          {breakdown && breakdown.couponDiscountAmount > 0 && (
            <div className="flex items-baseline justify-between">
              <dt className="text-muted-foreground">优惠券</dt>
              <dd>-{formatPrice(breakdown.couponDiscountAmount)}</dd>
            </div>
          )}
          <div className="flex items-baseline justify-between font-medium">
            <dt>实付金额</dt>
            <dd>
              {formatPrice(breakdown ? breakdown.payableAmount : cartTotal)}
            </dd>
          </div>
        </dl>
        <p className="text-xs text-muted-foreground">
          金额由服务端按下单时的 SKU 价格计算，页面上的数字不是最终金额，以提交时为准。
        </p>
      </section>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Button type="submit" disabled={busy || !idempotencyKey}>
        {busy ? '提交中…' : '提交订单'}
      </Button>
    </form>
  );
}
