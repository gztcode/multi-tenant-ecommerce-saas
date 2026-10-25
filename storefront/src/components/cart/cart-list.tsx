'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { itemSubtotal, totalAmount, totalQuantity } from '@/lib/cart';
import { formatPrice } from '@/lib/format';
import type { Cart } from '@/lib/cart';

/**
 * 购物车列表：读车、改数量、删除、清空、去结算。
 *
 * ## 为什么数据是**客户端**取的
 *
 * 游客购物车靠 `cart_token` cookie 定位。后端第一次访问时会**种下**这个
 * cookie（HttpOnly），而 Next.js **只允许在 Server Action 或 Route Handler
 * 里写 cookie**——在 Server Component 的渲染过程中调 `cookies().set()`
 * 会抛 `ReadonlyRequestCookiesError`（渲染阶段抛错，整页 500；
 * 但 `tsc` 与 `next build` 都过得去，属于阶段 2b 踩过的那类坑）。
 *
 * 所以这里走同源的 `/api/cart` 中转（Route Handler）：它把后端种下的
 * `Set-Cookie` 原样写进响应头，浏览器就拿到了。
 *
 * 所有写操作也走同一个中转——浏览器不能直连后端（没有 CORS），
 * 中转路由在服务端用 session 里的 accessToken 与浏览器的 cart_token
 * 去调后端。
 *
 * 逻辑内嵌在组件内部，没有从 Server Component 往下传回调：
 * Server → Client 传函数（事件处理器）在 tsc 与 next build 下都能过，
 * 只有真正渲染这一页时才 500。
 *
 * ⚠️ **购物车不是订单**——条目上带的商品名与单价只是**展示**信息
 * （下单时的快照由后端写进 `order_items`）。所以这里的合计金额是
 * 估算值：真实金额由后端在下单时按当时的 SKU 价格算。
 */
export function CartList() {
  const router = useRouter();
  const [cart, setCart] = useState<Cart | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * 统一的请求封装：错误 message 直接可以显示给人看。
   *
   * 返回 null 表示「后端没给响应体」（204）。
   */
  const call = useCallback(
    async (
      url: string,
      method: string,
      body?: unknown,
    ): Promise<Cart | null> => {
      const response = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new Error(payload.message ?? '操作失败');
      }
      if (response.status === 204) return null;
      return (await response.json()) as Cart;
    },
    [],
  );

  // 首次加载。放在客户端是因为中转路由的 Set-Cookie 只能在
  // Route Handler 的响应里送到浏览器（见上面的说明）。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await call('/api/cart', 'GET');
        if (!cancelled) setCart(result);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : '购物车加载失败');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [call]);

  async function changeQuantity(itemId: string, quantity: number) {
    if (quantity < 1) return;
    setBusy(true);
    setError(null);
    try {
      const next = await call(`/api/cart/items/${itemId}`, 'PATCH', { quantity });
      if (next) setCart(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '修改数量失败');
    } finally {
      setBusy(false);
    }
  }

  async function removeItem(itemId: string) {
    setBusy(true);
    setError(null);
    try {
      await call(`/api/cart/items/${itemId}`, 'DELETE');
      // 后端返回 204（没有响应体），本地直接把这一条摘掉
      setCart((prev) =>
        prev
          ? { ...prev, items: prev.items.filter((item) => item.id !== itemId) }
          : prev,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '删除失败');
    } finally {
      setBusy(false);
    }
  }

  async function clearCart() {
    if (!confirm('确定清空购物车？')) return;
    setBusy(true);
    setError(null);
    try {
      await call('/api/cart', 'DELETE');
      setCart((prev) => (prev ? { ...prev, items: [] } : prev));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '清空失败');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">购物车加载中…</p>;
  }

  const items = cart?.items ?? [];

  // ⚠️ **加载失败不是「空购物车」**。
  //
  // 早期版本把「空」与「加载失败」混在一起显示「购物车是空的。」——
  // 但车其实还在库里（后端 401/500 时前端拿不到 items）。
  // 用户看到「购物车是空的」会以为东西没了，甚至重新加一遍。
  // 所以失败时显示错误，绝不谎报「空」。
  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" onClick={() => router.refresh()}>
          重试
        </Button>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">购物车是空的。</p>
        <Button variant="outline" onClick={() => router.push('/')}>
          去逛逛
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {error && <p className="text-sm text-destructive">{error}</p>}

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left">
            <th>商品</th>
            <th className="w-24">单价</th>
            <th className="w-32">数量</th>
            <th className="w-24">小计</th>
            <th className="w-20">操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} className="border-b">
              <td>
                <div>{item.sku?.product.name ?? '商品已下架'}</div>
                <div className="font-mono text-xs text-muted-foreground">
                  {item.skuId}
                </div>
              </td>
              <td>{formatPrice(item.sku?.price)}</td>
              <td>
                <Input
                  type="number"
                  min={1}
                  max={99}
                  defaultValue={item.quantity}
                  aria-label={`${item.sku?.product.name ?? item.skuId} 的数量`}
                  disabled={busy}
                  onBlur={(event) => {
                    const next = Number.parseInt(event.target.value, 10);
                    if (Number.isFinite(next) && next !== item.quantity) {
                      changeQuantity(item.id, next);
                    }
                  }}
                  className="w-24"
                />
              </td>
              <td>{formatPrice(itemSubtotal(item))}</td>
              <td>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => removeItem(item.id)}
                  className="text-destructive underline disabled:opacity-40"
                >
                  删除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm text-muted-foreground">
            共 {totalQuantity(items)} 件
          </span>
          <span className="text-sm">
            合计 {formatPrice(totalAmount(items))}
          </span>
          <span className="text-xs text-muted-foreground">
            金额为估算值，实际以提交订单时为准
          </span>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" disabled={busy} onClick={clearCart}>
            清空购物车
          </Button>
          <Button disabled={busy} onClick={() => router.push('/checkout')}>
            去结算
          </Button>
        </div>
      </div>
    </div>
  );
}
