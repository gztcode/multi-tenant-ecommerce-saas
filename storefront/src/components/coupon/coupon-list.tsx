'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { couponRemaining, myCouponState } from '@/lib/coupon';
import { formatPrice } from '@/lib/format';
import type { AvailableCoupon, MyCoupon } from '@/lib/coupon';

/**
 * 领券中心：可领取的券 + 我持有的券。
 *
 * ⚠️ **逻辑内嵌在组件内部，没有从 Server Component 往下传回调**——
 * Server → Client 传函数在 tsc 与 next build 下都能过，
 * 只有真正渲染这一页时才 500（阶段 2b 踩过）。
 */

/** 我持有的券的状态文案 */
const STATE_LABEL: Record<'AVAILABLE' | 'USED_UP' | 'EXPIRED', string> = {
  AVAILABLE: '可用',
  USED_UP: '已用完',
  EXPIRED: '已过期',
};

/**
 * 日期的展示。
 *
 * ⚠️ **直接截 ISO 字符串，不走 `toLocaleDateString`**：
 * 那个函数按**运行机器的时区**格式化，服务器与浏览器的时区不一致时
 * 会渲染出不同的日期，hydration 就对不上了（订单页的
 * `toLocaleString('zh-CN')` 有同样的隐患，但那是既有代码，不在这里动）。
 */
function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

export function CouponList({
  available,
  mine,
  now,
}: {
  available: AvailableCoupon[];
  mine: MyCoupon[];
  /** 当前时刻（ISO 字符串）——由服务端算好传下来，两边用的是同一个值 */
  now: string;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<'available' | 'mine'>('available');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const nowDate = new Date(now);

  /**
   * 领券。
   *
   * ⚠️ **请求体只带 `couponId`**：面额与门槛一律由后端从库里读，
   * 客户端算的优惠额一律不信（护栏 M1 / M2）。
   */
  async function claim(couponId: string) {
    setBusyId(couponId);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch('/api/coupons/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ couponId }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new Error(payload.message ?? '领取失败');
      }

      setMessage('领取成功，结算时就能用这张券');
      // ⚠️ 领完之后列表变了，要让 Server Component 重新取数
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '领取失败');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setTab('available')}
          className={[
            'rounded-md border px-3 py-1 text-sm',
            tab === 'available' ? 'border-primary text-primary' : '',
          ].join(' ')}
        >
          可领取（{available.length}）
        </button>
        <button
          type="button"
          onClick={() => setTab('mine')}
          className={[
            'rounded-md border px-3 py-1 text-sm',
            tab === 'mine' ? 'border-primary text-primary' : '',
          ].join(' ')}
        >
          我的券（{mine.length}）
        </button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {message && <p className="text-sm text-muted-foreground">{message}</p>}

      {tab === 'available' ? (
        available.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            暂时没有可领取的优惠券。
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {available.map((coupon) => {
              const remaining = couponRemaining(coupon);
              const soldOut = remaining === 0;
              return (
                <li
                  key={coupon.id}
                  className="flex items-start justify-between gap-4 rounded-lg border p-4"
                >
                  <div className="flex flex-col gap-1">
                    <span className="font-medium">{coupon.name}</span>
                    <span className="text-sm text-muted-foreground">
                      减 {formatPrice(coupon.value)}
                      {coupon.minAmount > 0
                        ? `，满 ${formatPrice(coupon.minAmount)} 可用`
                        : '，无门槛'}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      有效期至 {formatDate(coupon.endsAt)}
                      {remaining === null
                        ? ' · 不限量'
                        : ` · 剩余 ${remaining} 张`}
                    </span>
                  </div>
                  <Button
                    disabled={busyId === coupon.id || soldOut}
                    onClick={() => claim(coupon.id)}
                  >
                    {busyId === coupon.id
                      ? '领取中…'
                      : soldOut
                        ? '已领完'
                        : '立即领取'}
                  </Button>
                </li>
              );
            })}
          </ul>
        )
      ) : mine.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          还没有优惠券，去「可领取」里领一张。
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {mine.map((coupon) => (
            <li
              key={coupon.id}
              className="flex items-start justify-between gap-4 rounded-lg border p-4"
            >
              <div className="flex flex-col gap-1">
                <span className="font-medium">{coupon.name}</span>
                <span className="text-sm text-muted-foreground">
                  减 {formatPrice(coupon.value)}
                  {coupon.minAmount > 0
                    ? `，满 ${formatPrice(coupon.minAmount)} 可用`
                    : '，无门槛'}
                </span>
                <span className="text-xs text-muted-foreground">
                  有效期至 {formatDate(coupon.endsAt)}
                </span>
              </div>
              <span className="rounded-md border px-2 py-1 text-xs">
                {STATE_LABEL[myCouponState(coupon, nowDate)]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
