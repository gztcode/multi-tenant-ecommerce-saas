'use client';

import { useMemo, useState } from 'react';
import { formatPrice } from '@/lib/format';
import type { PublicProductDetail } from '@/lib/catalog';

/**
 * 规格选择器。
 *
 * 「某个组合是否存在」在前端基于已下发的 SKU 列表判断，不需要额外请求——
 * 所以详情接口必须返回完整的 SKU 与规格值对应关系。
 *
 * 切换某一维度的值时，若与其他维度的当前选择组合不存在，会自动调整为可用组合。
 */
export function SpecSelector({ product }: { product: PublicProductDetail }) {
  const [selected, setSelected] = useState<Record<string, string>>({});

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
    </div>
  );
}