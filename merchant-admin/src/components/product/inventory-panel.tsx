'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

interface SkuRow {
  skuId: string;
  code: string | null;
  stock: number;
  status: string;
}

interface Movement {
  id: string;
  skuId: string;
  type: string;
  quantity: number;
  stockBefore: number;
  stockAfter: number;
  reason: string | null;
  createdAt: string;
}

const TYPE_LABEL: Record<string, string> = {
  INITIAL: '初始建仓',
  ADJUST_IN: '入库',
  ADJUST_OUT: '出库',
  CHECK: '盘点',
};

/** 统一的中转路由响应解析：错误 message 直接可以显示给人看 */
async function readResponse(response: Response, fallback: string): Promise<string | null> {
  const payload = (await response.json().catch(() => ({}))) as { message?: string };
  return response.ok ? null : (payload.message ?? fallback);
}

/**
 * 库存调整与流水台账。
 *
 * 库存**只能**从这里改——每一次改动都会留下一条流水（append-only）。
 * 流水没有修改与删除接口，这是审计要求。
 *
 * 写操作走同源的 /api/** 中转：后端没开 CORS，客户端直连会被预检拦掉
 * （Failed to fetch，带不回任何后端错误信息），而且 accessToken 不该进客户端。
 * 超量出库这类提示正是靠中转把后端 message 原样带回来的。
 */
export function InventoryPanel({ skus }: { skus: SkuRow[] }) {
  const router = useRouter();
  // 默认选中第一个 SKU。没有 productId 时 skus 为空，skuId 保持空串，
  // 流水区改为展示「没有商品参数」的说明而不是空表格。
  const [skuId, setSkuId] = useState(skus[0]?.skuId ?? '');
  const [type, setType] = useState<'ADJUST_IN' | 'ADJUST_OUT' | 'CHECK'>('ADJUST_IN');
  const [quantity, setQuantity] = useState(0);
  const [reason, setReason] = useState('');
  const [movements, setMovements] = useState<Movement[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [movementsHint, setMovementsHint] = useState<string | null>(null);

  const loadMovements = useCallback(async (targetSkuId: string) => {
    if (!targetSkuId) {
      setMovements([]);
      setMovementsHint('没有商品参数，先从商品编辑页进来才能看某个 SKU 的流水。');
      return;
    }
    try {
      const response = await fetch(
        `/api/inventory/movements?skuId=${encodeURIComponent(targetSkuId)}&pageSize=50`,
      );
      if (!response.ok) {
        // 流水拉不到不阻塞调整操作：调整台账是主任务，流水是附带的。
        setMovementsHint(
          (await readResponse(response, '流水加载失败')) ?? '流水加载失败',
        );
        return;
      }
      const payload = (await response.json()) as { items?: Movement[] };
      setMovements(payload.items ?? []);
      setMovementsHint(null);
    } catch {
      setMovementsHint('流水加载失败');
    }
  }, []);

  // 首屏就把流水拉出来。少了这一步，进页面时时间线是空的，
  // 要先手动切一次 SKU 才看得到历史。
  useEffect(() => {
    void loadMovements(skus[0]?.skuId ?? '');
    // 只在挂载时跑一次：之后由 onChange / 提交调整显式重载，
    // 刻意不把 skuId 放进依赖，否则每次换选中项都会重置成第一个。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function adjust() {
    if (!skuId) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/inventory/adjustments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          skuId,
          type,
          quantity,
          ...(reason ? { reason } : {}),
        }),
      });
      const failure = await readResponse(response, '调整失败');
      if (failure) throw new Error(failure);

      setMessage('已调整');
      await loadMovements(skuId);
      // 重新取服务端数据，让 SKU 的当前库存跟上刚提交的调整。
      router.refresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '调整失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {skus.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h3 className="font-medium">库存调整</h3>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-sm">
              <span>SKU</span>
              <select
                value={skuId}
                aria-label="SKU"
                onChange={(e) => {
                  setSkuId(e.target.value);
                  setMessage(null);
                  void loadMovements(e.target.value);
                }}
                className="rounded-md border px-2 py-1"
              >
                {skus.map((sku) => (
                  <option key={sku.skuId} value={sku.skuId}>
                    {sku.code ?? sku.skuId}（当前 {sku.stock}
                    {sku.status === 'INACTIVE' ? '，已停用' : ''}）
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span>类型</span>
              <select
                value={type}
                aria-label="类型"
                onChange={(e) =>
                  setType(e.target.value as 'ADJUST_IN' | 'ADJUST_OUT' | 'CHECK')
                }
                className="rounded-md border px-2 py-1"
              >
                <option value="ADJUST_IN">入库</option>
                <option value="ADJUST_OUT">出库</option>
                <option value="CHECK">盘点</option>
              </select>
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span>{type === 'CHECK' ? '盘点后库存' : '数量'}</span>
              <input
                type="number"
                min={0}
                value={quantity}
                aria-label={type === 'CHECK' ? '盘点后库存' : '数量'}
                onChange={(e) => setQuantity(Number(e.target.value))}
                className="w-28 rounded-md border px-2 py-1"
              />
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span>原因</span>
              <input
                value={reason}
                aria-label="原因"
                placeholder="可选，写进流水里备查"
                onChange={(e) => setReason(e.target.value)}
                className="rounded-md border px-2 py-1"
              />
            </label>

            <button
              type="button"
              onClick={adjust}
              disabled={busy || !skuId}
              className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-40"
            >
              {busy ? '提交中…' : '提交调整'}
            </button>
          </div>
          {message && (
            <p
              role="alert"
              className={
                message === '已调整'
                  ? 'text-sm text-muted-foreground'
                  : 'text-sm text-destructive'
              }
            >
              {message}
            </p>
          )}
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">
          没有可调整的 SKU：库存页需要带上商品参数才能列出该商品的 SKU。
        </p>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="font-medium">库存流水</h3>
        {movementsHint ? (
          <p className="text-sm text-muted-foreground">{movementsHint}</p>
        ) : movements.length === 0 ? (
          <p className="text-sm text-muted-foreground">还没有流水记录。</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th>时间</th>
                <th>类型</th>
                <th>变动</th>
                <th>前 → 后</th>
                <th>原因</th>
              </tr>
            </thead>
            <tbody>
              {movements.map((movement) => (
                <tr key={movement.id} className="border-b">
                  <td>{new Date(movement.createdAt).toLocaleString('zh-CN')}</td>
                  <td>{TYPE_LABEL[movement.type] ?? movement.type}</td>
                  <td>
                    {movement.quantity > 0 ? '+' : ''}
                    {movement.quantity}
                  </td>
                  <td>
                    {movement.stockBefore} → {movement.stockAfter}
                  </td>
                  <td>{movement.reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}