'use client';

import { useState } from 'react';
import { CouponManager } from '@/components/marketing/coupon-manager';
import { PromotionManager } from '@/components/marketing/promotion-manager';
import type { Coupon, Promotion } from '@/lib/marketing';

/**
 * 营销页的两个页签：优惠券与满减活动。
 *
 * ⚠️ **逻辑内嵌在组件内部，没有从 Server Component 往下传回调**——
 * Server → Client 传函数在 tsc 与 next build 下都能过，
 * 只有真正渲染这一页时才 500（阶段 2b 踩过）。
 */
export function MarketingPanel({
  coupons,
  promotions,
  couponPage,
  couponPageSize,
  couponTotal,
}: {
  coupons: Coupon[];
  promotions: Promotion[];
  /** 券列表的分页状态（服务端渲染，翻页走 URL 查询串） */
  couponPage: number;
  couponPageSize: number;
  couponTotal: number;
}) {
  const [tab, setTab] = useState<'coupons' | 'promotions'>('coupons');

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setTab('coupons')}
          className={[
            'rounded-md border px-3 py-1 text-sm',
            tab === 'coupons' ? 'border-primary text-primary' : '',
          ].join(' ')}
        >
          优惠券（{coupons.length}）
        </button>
        <button
          type="button"
          onClick={() => setTab('promotions')}
          className={[
            'rounded-md border px-3 py-1 text-sm',
            tab === 'promotions' ? 'border-primary text-primary' : '',
          ].join(' ')}
        >
          满减活动（{promotions.length}）
        </button>
      </div>

      {tab === 'coupons' ? (
        <CouponManager
          initial={coupons}
          page={couponPage}
          pageSize={couponPageSize}
          total={couponTotal}
        />
      ) : (
        <PromotionManager initial={promotions} />
      )}
    </div>
  );
}
