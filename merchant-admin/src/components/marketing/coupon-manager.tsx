'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { formatPrice } from '@/components/product/format';
import { centsToYuan, yuanToCents } from '@/lib/money';
import {
  COUPON_STATUS_LABEL,
  fromLocalDateTimeInput,
  toLocalDateTimeInput,
  type Coupon,
} from '@/lib/marketing';

/**
 * 优惠券列表与表单：新建、编辑、暂停 / 启用、删除。
 *
 * 所有写操作都走同源的 /api/** 中转（不是直连后端）：
 * 后端没开 CORS，客户端直连会被预检拦掉成 `Failed to fetch`，
 * 而且 accessToken 不该进客户端代码。中转路由在服务端用 auth() 取 token。
 *
 * 保存后调 router.refresh() 让 Server Component 重新取列表——
 * 列表是服务端渲染的，本组件不持有它的副本，避免两份状态不同步。
 */

/** 表单里的值（金额用「元」，提交前才转成「分」） */
interface CouponForm {
  code: string;
  name: string;
  description: string;
  /** 面额（元） */
  value: string;
  /** 使用门槛（元） */
  minAmount: string;
  /** 每用户限领张数；空 = 不限 */
  perUserLimit: string;
  /** 总发放上限；空 = 不限 */
  totalLimit: string;
  /** 生效开始（datetime-local 的本地时间格式） */
  startsAt: string;
  /** 生效结束（datetime-local 的本地时间格式） */
  endsAt: string;
}

const EMPTY_FORM: CouponForm = {
  code: '',
  name: '',
  description: '',
  value: '',
  minAmount: '',
  perUserLimit: '',
  totalLimit: '',
  startsAt: '',
  endsAt: '',
};

/** 统一的中转路由响应解析：错误 message 直接可以显示给人看 */
async function readResponse(
  response: Response,
  fallback: string,
): Promise<string | null> {
  const payload = (await response.json().catch(() => ({}))) as {
    message?: string;
  };
  return response.ok ? null : (payload.message ?? fallback);
}

/**
 * 表单 → 请求体。
 *
 * ⚠️ **金额在这里才从「元」转成「分」**：转换只在表单的边界做，
 * 其余地方一律整数分。转换失败返回错误文案，**不猜**——
 * 猜出来的面额会直接变成用户的钱。
 */
function buildPayload(
  form: CouponForm,
): { body: Record<string, unknown> } | { error: string } {
  const value = yuanToCents(form.value);
  if (value === null || value < 1) {
    return { error: '面额必须是大于 0 的金额，最多两位小数' };
  }
  const minAmount = form.minAmount.trim() === '' ? 0 : yuanToCents(form.minAmount);
  if (minAmount === null) {
    return { error: '使用门槛必须是非负金额，最多两位小数' };
  }

  const startsAt = fromLocalDateTimeInput(form.startsAt);
  if (!startsAt) {
    return { error: '请填写生效开始时间' };
  }
  const endsAt = fromLocalDateTimeInput(form.endsAt);
  if (!endsAt) {
    return { error: '请填写生效结束时间' };
  }

  const body: Record<string, unknown> = {
    code: form.code.trim(),
    name: form.name.trim(),
    value,
    minAmount,
    startsAt,
    endsAt,
  };
  if (form.description.trim() !== '') {
    body.description = form.description.trim();
  }

  // ⚠️ **空 = 不限**：不放这个键，而不是放 0（0 会被后端判为非法）。
  if (form.perUserLimit.trim() !== '') {
    const perUserLimit = Number(form.perUserLimit.trim());
    if (!Number.isInteger(perUserLimit) || perUserLimit < 1) {
      return { error: '每用户限领张数必须是大于等于 1 的整数' };
    }
    body.perUserLimit = perUserLimit;
  }
  if (form.totalLimit.trim() !== '') {
    const totalLimit = Number(form.totalLimit.trim());
    if (!Number.isInteger(totalLimit) || totalLimit < 1) {
      return { error: '总发放上限必须是大于等于 1 的整数' };
    }
    body.totalLimit = totalLimit;
  }

  return { body };
}

export function CouponManager({ initial }: { initial: Coupon[] }) {
  const router = useRouter();
  /** 正在编辑的券；null = 没有编辑表单打开着 */
  const [editing, setEditing] = useState<Coupon | null>(null);
  /** 是否在新建 */
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<CouponForm>(EMPTY_FORM);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function openCreate() {
    setEditing(null);
    setCreating(true);
    setForm(EMPTY_FORM);
    setMessage(null);
  }

  function openEdit(coupon: Coupon) {
    setCreating(false);
    setEditing(coupon);
    setMessage(null);
    setForm({
      code: coupon.code,
      name: coupon.name,
      description: coupon.description ?? '',
      // ⚠️ 展示时用「元」，提交时再转回「分」
      value: centsToYuan(coupon.value),
      minAmount: centsToYuan(coupon.minAmount),
      perUserLimit:
        coupon.perUserLimit === null ? '' : String(coupon.perUserLimit),
      totalLimit: coupon.totalLimit === null ? '' : String(coupon.totalLimit),
      startsAt: toLocalDateTimeInput(coupon.startsAt),
      endsAt: toLocalDateTimeInput(coupon.endsAt),
    });
  }

  function closeForm() {
    setCreating(false);
    setEditing(null);
    setForm(EMPTY_FORM);
    setMessage(null);
  }

  async function submit() {
    const built = buildPayload(form);
    if ('error' in built) {
      setMessage(built.error);
      return;
    }

    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        editing ? `/api/coupons/${editing.id}` : '/api/coupons',
        {
          method: editing ? 'PATCH' : 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(built.body),
        },
      );
      const failure = await readResponse(response, editing ? '保存失败' : '创建失败');
      if (failure) throw new Error(failure);

      closeForm();
      router.refresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  /** 暂停 / 启用：只改状态，其余字段一律不动 */
  async function toggleStatus(coupon: Coupon) {
    const next = coupon.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';
    setMessage(null);
    try {
      const response = await fetch(`/api/coupons/${coupon.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      const failure = await readResponse(response, '操作失败');
      if (failure) throw new Error(failure);
      router.refresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '操作失败');
    }
  }

  async function remove(coupon: Coupon) {
    if (!confirm(`确定删除优惠券「${coupon.name}」？删除后消费者就领不到了。`)) {
      return;
    }
    setMessage(null);
    try {
      const response = await fetch(`/api/coupons/${coupon.id}`, {
        method: 'DELETE',
      });
      const failure = await readResponse(response, '删除失败');
      if (failure) throw new Error(failure);
      router.refresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '删除失败');
    }
  }

  function renderForm() {
    return (
      <div className="flex flex-col gap-3 rounded-lg border p-4">
        <p className="text-sm font-medium">
          {editing ? `编辑「${editing.name}」` : '新建优惠券'}
        </p>

        <div className="flex flex-wrap gap-2">
          <input
            value={form.code}
            aria-label="券码"
            placeholder="券码（如 SAVE10）"
            onChange={(e) => setForm({ ...form, code: e.target.value })}
            className="rounded-md border px-2 py-1 text-sm"
          />
          <input
            value={form.name}
            aria-label="券名称"
            placeholder="券名称（如 满100减10）"
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="rounded-md border px-2 py-1 text-sm"
          />
        </div>

        <div className="flex flex-wrap gap-2">
          <label className="flex items-center gap-1 text-sm">
            面额（元）
            <input
              value={form.value}
              aria-label="面额（元）"
              placeholder="10"
              onChange={(e) => setForm({ ...form, value: e.target.value })}
              className="w-24 rounded-md border px-2 py-1 text-sm"
            />
          </label>
          <label className="flex items-center gap-1 text-sm">
            门槛（元）
            <input
              value={form.minAmount}
              aria-label="使用门槛（元）"
              placeholder="100"
              onChange={(e) => setForm({ ...form, minAmount: e.target.value })}
              className="w-24 rounded-md border px-2 py-1 text-sm"
            />
          </label>
          <label className="flex items-center gap-1 text-sm">
            每用户限领
            <input
              value={form.perUserLimit}
              aria-label="每用户限领张数"
              placeholder="不限"
              onChange={(e) =>
                setForm({ ...form, perUserLimit: e.target.value })
              }
              className="w-20 rounded-md border px-2 py-1 text-sm"
            />
          </label>
          <label className="flex items-center gap-1 text-sm">
            总发放上限
            <input
              value={form.totalLimit}
              aria-label="总发放上限"
              placeholder="不限"
              onChange={(e) => setForm({ ...form, totalLimit: e.target.value })}
              className="w-20 rounded-md border px-2 py-1 text-sm"
            />
          </label>
        </div>

        <input
          value={form.description}
          aria-label="券说明"
          placeholder="券说明（选填）"
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          className="rounded-md border px-2 py-1 text-sm"
        />

        <div className="flex flex-wrap gap-2">
          <label className="flex items-center gap-1 text-sm">
            生效开始
            <input
              type="datetime-local"
              value={form.startsAt}
              aria-label="生效开始时间"
              onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
              className="rounded-md border px-2 py-1 text-sm"
            />
          </label>
          <label className="flex items-center gap-1 text-sm">
            生效结束
            <input
              type="datetime-local"
              value={form.endsAt}
              aria-label="生效结束时间"
              onChange={(e) => setForm({ ...form, endsAt: e.target.value })}
              className="rounded-md border px-2 py-1 text-sm"
            />
          </label>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-40"
          >
            {busy ? '提交中…' : '保存'}
          </button>
          <button
            type="button"
            onClick={closeForm}
            className="rounded-md border px-3 py-1.5 text-sm"
          >
            取消
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {initial.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          还没有优惠券，先建一张让消费者领。
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {initial.map((coupon) => (
            <li
              key={coupon.id}
              className="flex flex-col gap-2 rounded-lg border p-4"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex flex-col gap-1">
                  <span className="font-medium">
                    {coupon.name}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {coupon.code}
                    </span>
                  </span>
                  <span className="text-sm text-muted-foreground">
                    减 {formatPrice(coupon.value)}
                    {coupon.minAmount > 0
                      ? `，满 ${formatPrice(coupon.minAmount)} 可用`
                      : '，无门槛'}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    已领 {coupon.claimedCount} 张 · 预占 {coupon.reservedCount} · 已核销{' '}
                    {coupon.usedCount}
                    {coupon.totalLimit === null
                      ? ' · 不限量'
                      : ` · 上限 ${coupon.totalLimit} 张`}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(coupon.startsAt).toLocaleString('zh-CN')} 至{' '}
                    {new Date(coupon.endsAt).toLocaleString('zh-CN')}
                  </span>
                </div>
                <span className="rounded-md border px-2 py-1 text-xs">
                  {COUPON_STATUS_LABEL[coupon.status] ?? coupon.status}
                </span>
              </div>
              <div className="flex gap-3 text-xs">
                <button
                  type="button"
                  onClick={() => openEdit(coupon)}
                  className="underline"
                >
                  编辑
                </button>
                <button
                  type="button"
                  onClick={() => toggleStatus(coupon)}
                  className="underline"
                >
                  {coupon.status === 'ACTIVE' ? '暂停' : '启用'}
                </button>
                <button
                  type="button"
                  onClick={() => remove(coupon)}
                  className="text-destructive underline"
                >
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {creating || editing ? (
        renderForm()
      ) : (
        <button
          type="button"
          onClick={openCreate}
          className="w-fit rounded-md border px-3 py-1.5 text-sm"
        >
          新建优惠券
        </button>
      )}

      {message && (
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
      )}
    </div>
  );
}
