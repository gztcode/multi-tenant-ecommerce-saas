'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatPrice } from '@/lib/format';
import type { PublicProductDetail } from '@/lib/catalog';

/**
 * 单个 SKU 的加购数量上限（与后端 AddCartItemDto 的 MAX_CART_QUANTITY 一致）。
 *
 * ⚠️ 与中转路由的校验保持一致：超过上限的请求会被中转路由挡下（400），
 * 与其让用户点了才失败，不如在输入框上就限制住。
 */
const MAX_CART_QUANTITY = 99;

/**
 * 规格选择器。
 *
 * 「某个组合是否存在」在前端基于已下发的 SKU 列表判断，不需要额外请求——
 * 所以详情接口必须返回完整的 SKU 与规格值对应关系。
 *
 * 切换某一维度的值时，若与其他维度的当前选择组合不存在，会自动调整为可用组合。
 *
 * ## 为什么「加入购物车」按钮也在这个组件里
 *
 * 按钮要知道**当前选中的具体 SKU**，而选择状态是这里的 `useState`。
 * 把按钮拆到另一个组件，就得从 Server Component 往下传回调函数——
 * 那是 tsc 与 next build 都过得去、只有真正渲染这一页时才 500 的坑
 * （见 cart-list.tsx 顶上那段说明）。所以按钮与选择器待在一起。
 */
export function SpecSelector({ product }: { product: PublicProductDetail }) {
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [quantity, setQuantity] = useState(1);
  const [adding, setAdding] = useState(false);
  const [addResult, setAddResult] = useState<
    { ok: true } | { ok: false; message: string }
  | null>(null);

  // 每个规格值 id → 它属于哪些 SKU
  const skusByValue = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const sku of product.skus) {
      for (const sv of sku.specValues) {
        const list = map.get(sv.valueId) ?? [];
        list.push(sku.id);
        map.set(sv.valueId, list);
      }
    }
    return map;
  }, [product.skus]);

  /**
   * 判断「一组已选值」能否凑出一个存在的 SKU。
   *
   * 只有一个 SKU 且它没有任何规格值（无规格商品）时，
   * chosen 是空集、size 是 0，与 skus[0].specValues 长度相等，判定成立。
   */
  function combinationExists(chosen: Set<string>): boolean {
    return product.skus.some((sku) => {
      const ids = sku.specValues.map((sv) => sv.valueId);
      return ids.length === chosen.size && ids.every((id) => chosen.has(id));
    });
  }

  // 当前选择下命中的 SKU
  const currentSku = useMemo(() => {
    if (product.skus.length === 0) return null;
    const chosen = new Set(Object.values(selected));
    if (chosen.size !== product.specs.length) return null;
    return (
      product.skus.find((sku) => {
        const ids = sku.specValues.map((sv) => sv.valueId);
        return (
          ids.length === chosen.size &&
          ids.every((id) => chosen.has(id))
        );
      }) ?? null
    );
  }, [product.skus, product.specs.length, selected]);

  /**
   * 某个值能否选中：选它之后，其余维度是否还能凑出存在的组合。
   */
  function isSelectable(specId: string, valueId: string): boolean {
    const candidate = { ...selected, [specId]: valueId };
    const chosen = new Set(Object.values(candidate));
    if (chosen.size === product.specs.length) {
      return combinationExists(chosen);
    }
    // 还有维度没选：只要这个值属于至少一个 SKU 就可选
    return (skusByValue.get(valueId) ?? []).length > 0;
  }

  function isSelectableWith(
    specId: string,
    valueId: string,
    candidate: Record<string, string>,
  ): boolean {
    const probe = { ...candidate, [specId]: valueId };
    const chosen = new Set(Object.values(probe));
    if (chosen.size !== product.specs.length) {
      return (skusByValue.get(valueId) ?? []).length > 0;
    }
    return combinationExists(chosen);
  }

  function select(specId: string, valueId: string) {
    const candidate = { ...selected, [specId]: valueId };
    // 调整其余维度，使组合存在
    for (const spec of product.specs) {
      if (candidate[spec.id]) continue;
      const usable = spec.values.find((v) =>
        isSelectableWith(spec.id, v.id, candidate),
      );
      if (usable) candidate[spec.id] = usable.id;
    }
    setSelected(candidate);
  }

  /**
   * 加入购物车。
   *
   * 调同源的 `/api/cart/items` 中转路由（浏览器不能直连后端：没开 CORS）。
   * 游客也能加购——中转路由把后端种下的 `cart_token` 写进响应的
   * `Set-Cookie`，浏览器就拿到了自己的游客车。
   */
  async function addToCart() {
    if (!currentSku || adding) return;
    setAdding(true);
    setAddResult(null);
    try {
      const response = await fetch('/api/cart/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ skuId: currentSku.id, quantity }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new Error(payload.message ?? '加入购物车失败');
      }
      setAddResult({ ok: true });
    } catch (cause) {
      setAddResult({
        ok: false,
        message: cause instanceof Error ? cause.message : '加入购物车失败',
      });
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {product.specs.map((spec) => (
        <div key={spec.id} className="flex flex-col gap-2">
          <span className="text-sm font-medium">{spec.name}</span>
          <div className="flex flex-wrap gap-2">
            {spec.values.map((value) => {
              const enabled = isSelectable(spec.id, value.id);
              const active = selected[spec.id] === value.id;
              return (
                <button
                  key={value.id}
                  type="button"
                  disabled={!enabled}
                  onClick={() => select(spec.id, value.id)}
                  className={[
                    'rounded-md border px-3 py-1 text-sm',
                    active
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'hover:border-primary',
                    !enabled ? 'cursor-not-allowed opacity-40' : '',
                  ].join(' ')}
                >
                  {value.value}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-semibold text-primary">
          {currentSku
            ? formatPrice(currentSku.price)
            : formatPrice(product.minPrice)}
        </span>
        {currentSku?.comparePrice && currentSku.comparePrice > currentSku.price && (
          <span className="text-sm text-muted-foreground line-through">
            {formatPrice(currentSku.comparePrice)}
          </span>
        )}
      </div>

      {currentSku && (
        <p className="text-sm text-muted-foreground">
          {currentSku.stock > 0 ? `库存 ${currentSku.stock} 件` : '暂时缺货'}
        </p>
      )}

      {/* 加购区：没选出具体的 SKU 之前按钮不可用 */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">数量</span>
          <Input
            type="number"
            min={1}
            max={MAX_CART_QUANTITY}
            value={quantity}
            disabled={!currentSku || adding}
            aria-label="购买数量"
            onChange={(event) => {
              const next = Number.parseInt(event.target.value, 10);
              // 输入框可能被清空或填成非数字：此时先按住上一个有效值，
              // 等用户填完合法的数字再更新。
              if (Number.isFinite(next)) {
                setQuantity(Math.min(Math.max(next, 1), MAX_CART_QUANTITY));
              }
            }}
            className="w-20"
          />
        </div>

        <Button
          type="button"
          disabled={!currentSku || currentSku.stock <= 0 || adding}
          onClick={addToCart}
          className="self-start"
        >
          {adding ? '加入中…' : '加入购物车'}
        </Button>

        {!currentSku ? (
          <p className="text-sm text-muted-foreground">
            请先选择商品规格。
          </p>
        ) : currentSku.stock <= 0 ? (
          <p className="text-sm text-muted-foreground">该商品暂时缺货。</p>
        ) : null}

        {addResult?.ok === true && (
          <div className="flex items-center gap-2">
            <p className="text-sm text-primary">已加入购物车。</p>
            <Link href="/cart" className="text-sm underline">
              去购物车
            </Link>
          </div>
        )}
        {addResult?.ok === false && (
          <p className="text-sm text-destructive">{addResult.message}</p>
        )}
      </div>
    </div>
  );
}