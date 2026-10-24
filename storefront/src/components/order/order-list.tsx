'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ORDER_STATUS_LABEL, ORDER_STATUS_OPTIONS } from '@/lib/cart';
import type { Order, OrderStatus } from '@/lib/cart';

/**
 * 消费者的「我的订单」列表。
 *
 * 筛选走 URL 查询串（同 merchant-admin 的商品列表那一套）：
 * 筛选是「服务端重新渲染列表」的输入，分成两套状态迟早会不一致
 * （筛选变了但 page 还停在第 5 页，第 5 页可能已经越界）。
 *
 * 逻辑内嵌在组件内部，没有从 Server Component 往下传回调——
 * Server → Client 传函数在 tsc 与 next build 下都能过，
 * 只有真正渲染这一页时才 500。
 */
export function OrderList({
  initial,
  total,
  page,
  pageSize,
}: {
  initial: Order[];
  total: number;
  page: number;
  pageSize: number;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  function applyStatus(status: string) {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    const suffix = params.toString();
    router.push(`/orders${suffix ? `?${suffix}` : ''}`);
  }

  function goPage(target: number) {
    const params = new URLSearchParams(searchParams.toString());
    params.set('page', String(Math.max(1, target)));
    const suffix = params.toString();
    router.push(`/orders${suffix ? `?${suffix}` : ''}`);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        {ORDER_STATUS_OPTIONS.map((option) => {
          const active =
            (searchParams.get('status') ?? '') === option.value;
          return (
            <button
              key={option.value || 'all'}
              type="button"
              onClick={() => applyStatus(option.value)}
              className={[
                'rounded-md border px-3 py-1 text-sm',
                active ? 'border-primary bg-primary text-primary-foreground' : '',
              ].join(' ')}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      {initial.length === 0 ? (
        <p className="text-sm text-muted-foreground">还没有订单。</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th>订单号</th>
              <th>状态</th>
              <th>金额</th>
              <th>收货人</th>
              <th>下单时间</th>
            </tr>
          </thead>
          <tbody>
            {initial.map((order) => (
              <tr key={order.id} className="border-b">
                <td>
                  <Link
                    href={`/orders/${order.orderNo}`}
                    className="font-mono underline"
                  >
                    {order.orderNo}
                  </Link>
                </td>
                <td>{ORDER_STATUS_LABEL[order.status as OrderStatus]}</td>
                <td>¥{(order.totalAmount / 100).toFixed(2)}</td>
                <td>
                  {order.receiverName} {order.receiverPhone}
                </td>
                <td className="text-muted-foreground">
                  {new Date(order.createdAt).toLocaleString('zh-CN')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <p className="text-muted-foreground">
            共 {total} 个订单 · 第 {page} / {totalPages} 页
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => goPage(page - 1)}
              className="rounded border px-3 py-1 disabled:opacity-40"
            >
              上一页
            </button>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => goPage(page + 1)}
              className="rounded border px-3 py-1 disabled:opacity-40"
            >
              下一页
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
