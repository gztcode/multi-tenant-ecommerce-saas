'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ORDER_STATUS_LABEL } from '@/lib/cart';
import type { OrderStatus } from '@/lib/cart';

/**
 * 游客订单查询页（阶段 11）。
 *
 * 「订单号 + 收货手机号」双因子查询，结果只有状态/金额/件数/时间——
 * 这是后端与 BFF 的共同投影边界，本页**拿不到也不展示**收货人信息。
 * 完整详情仍要求登录后到「我的订单」看（页面底部给出入口）。
 */

type LookupResult = {
  orderNo: string;
  status: string;
  totalAmount: number;
  itemCount: number;
  createdAt: string;
  paidAt: string | null;
};

function formatMoney(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

export default function OrderLookupPage() {
  const [orderNo, setOrderNo] = useState('');
  const [phone, setPhone] = useState('');
  const [result, setResult] = useState<LookupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setResult(null);
    setSubmitting(true);
    try {
      const response = await fetch('/api/orders/guest-lookup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orderNo: orderNo.trim(), phone: phone.trim() }),
      });
      const payload = (await response.json().catch(() => null)) as
        | (LookupResult & { message?: string })
        | { message: string }
        | null;
      if (!response.ok) {
        setError(payload?.message ?? '查询失败，请稍后再试');
        return;
      }
      setResult(payload as LookupResult);
    } catch {
      setError('网络异常，请稍后再试');
    } finally {
      setSubmitting(false);
    }
  }

  const statusLabel =
    result && result.status in ORDER_STATUS_LABEL
      ? ORDER_STATUS_LABEL[result.status as OrderStatus]
      : result?.status;

  return (
    <div className="mx-auto max-w-md space-y-6 px-4 py-10">
      <Card>
        <CardHeader>
          <CardTitle>订单查询</CardTitle>
          <CardDescription>
            输入订单号和下单时填写的收货手机号，查看订单当前状态。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="orderNo">订单号</Label>
              <Input
                id="orderNo"
                value={orderNo}
                onChange={(e) => setOrderNo(e.target.value)}
                placeholder="例如 202611070001"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="phone">收货手机号</Label>
              <Input
                id="phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="下单时填写的手机号"
                required
              />
            </div>
            {error !== null && (
              <p className="text-sm text-red-600" role="alert">
                {error}
              </p>
            )}
            <Button type="submit" disabled={submitting} className="w-full">
              {submitting ? '查询中…' : '查询'}
            </Button>
          </form>
        </CardContent>
      </Card>

      {result !== null && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{result.orderNo}</CardTitle>
            <CardDescription>查询到以下订单</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">状态</span>
              <span>{statusLabel}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">金额</span>
              <span>{formatMoney(result.totalAmount)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">件数</span>
              <span>{result.itemCount}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">下单时间</span>
              <span>{formatDate(result.createdAt)}</span>
            </div>
            {result.paidAt !== null && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">支付时间</span>
                <span>{formatDate(result.paidAt)}</span>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <p className="text-center text-sm text-muted-foreground">
        需要查看详情或申请售后？{' '}
        <Link href="/orders" className="text-primary underline">
          登录后到「我的订单」
        </Link>
      </p>
    </div>
  );
}
