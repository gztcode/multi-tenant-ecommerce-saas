'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { formatPrice } from '@/components/product/format';
import { ORDER_STATUS_LABEL, ORDER_STATUS_OPTIONS } from '@/components/order/types';
import type { MerchantOrder, OrderStatus } from '@/components/order/types';

/**
 * 商家侧订单列表：按状态、时间筛选 + 分页。
 *
 * 筛选与分页都走 URL 查询串（同商品列表那一套）：筛选与分页都是
 * 「服务端重新渲染列表」的输入，分成两套状态迟早会不一致
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
  initial: MerchantOrder[];
  total: number;
  page: number;
  pageSize: number;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  function applyFilter(form: HTMLFormElement) {
    const data = new FormData(form);
    const params = new URLSearchParams();

    const status = data.get('status');
    if (typeof status === 'string' && status) {
      params.set('status', status);
    }
    const from = data.get('from');
    if (typeof from === 'string' && from) {
      params.set('from', from);
    }
    const to = data.get('to');
    if (typeof to === 'string' && to) {
      params.set('to', to);
    }
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
      {/* 筛选是纯服务端渲染的：提交后查询串变化，Server Component 重新取数。
          用 onSubmit + preventDefault 而不是普通 GET 表单跳转，是为了在客户端
          导航（保留页面状态），并且能把空值从查询串里剔掉。 */}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          applyFilter(event.currentTarget);
        }}
        className="flex flex-wrap items-end gap-2"
      >
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          状态
          <select
            name="status"
            defaultValue={searchParams.get('status') ?? ''}
            className="rounded-md border px-2 py-1 text-sm"
          >
            {ORDER_STATUS_OPTIONS.map((option) => (
              <option key={option.value || 'all'} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          下单时间从
          <input
            type="date"
            name="from"
            defaultValue={searchParams.get('from') ?? ''}
            className="rounded-md border px-2 py-1 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          到
          <input
            type="date"
            name="to"
            defaultValue={searchParams.get('to') ?? ''}
            className="rounded-md border px-2 py-1 text-sm"
          />
        </label>
        <button
          type="submit"
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
        >
          筛选
        </button>
      </form>

      <p className="text-xs text-muted-foreground">共 {total} 个订单</p>

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left">
            <th>订单号</th>
            <th>状态</th>
            <th>金额</th>
            <th>件数</th>
            <th>收货人</th>
            <th>下单时间</th>
          </tr>
        </thead>
        <tbody>
          {initial.length === 0 ? (
            <tr>
              <td colSpan={6} className="py-4 text-muted-foreground">
                没有符合条件的订单。
              </td>
            </tr>
          ) : (
            initial.map((order) => (
              <tr key={order.id} className="border-b">
                <td>
                  <Link href={`/orders/${order.orderNo}`} className="underline">
                    {order.orderNo}
                  </Link>
                </td>
                <td>{ORDER_STATUS_LABEL[order.status as OrderStatus]}</td>
                <td>{formatPrice(order.totalAmount)}</td>
                <td>{order.itemCount}</td>
                <td>
                  {order.receiverName} {order.receiverPhone}
                </td>
                <td className="text-muted-foreground">
                  {new Date(order.createdAt).toLocaleString('zh-CN')}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <p className="text-muted-foreground">
            第 {page} / {totalPages} 页
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
