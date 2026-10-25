'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { formatPrice } from '@/components/product/format';
import { centsToYuan, yuanToCents } from '@/lib/money';
import {
  PROMOTION_STATUS_LABEL,
  fromLocalDateTimeInput,
  toLocalDateTimeInput,
  type Promotion,
} from '@/lib/marketing';

/**
 * 满减活动列表与表单：新建、编辑、暂停 / 启用、删除。
 *
 * 所有写操作都走同源的 /api/** 中转（不是直连后端）：
 * 后端没开 CORS，客户端直连会被预检拦掉成 `Failed to fetch`，
 * 而且 accessToken 不该进客户端代码。中转路由在服务端用 auth() 取 token。
 *
 * 保存后调 router.refresh() 让 Server Component 重新取列表——
 * 列表是服务端渲染的，本组件不持有它的副本，避免两份状态不同步。
 */

/** 表单里的值（金额用「元」，提交前才转成「分」） */
interface PromotionForm {
  name: string;
  description: string;
  /** 门槛（元） */
  minAmount: string;
  /** 减免金额（元） */
  discountAmount: string;
  /** 生效开始（datetime-local 的本地时间格式） */
  startsAt: string;
  /** 生效结束（datetime-local 的本地时间格式） */
  endsAt: string;
}

const EMPTY_FORM: PromotionForm = {
  name: '',
  description: '',
  minAmount: '',
  discountAmount: '',
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
 * 其余地方一律整数分。转换失败返回错误文案，**不猜**。
 */
function buildPayload(
  form: PromotionForm,
): { body: Record<string, unknown> } | { error: string } {
  const discountAmount = yuanToCents(form.discountAmount);
  if (discountAmount === null || discountAmount < 1) {
    return { error: '减免金额必须是大于 0 的金额，最多两位小数' };
  }
  const minAmount = form.minAmount.trim() === '' ? 0 : yuanToCents(form.minAmount);
  if (minAmount === null) {
    return { error: '门槛必须是非负金额，最多两位小数' };
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
    name: form.name.trim(),
    minAmount,
    discountAmount,
    startsAt,
    endsAt,
  };
  if (form.description.trim() !== '') {
    body.description = form.description.trim();
  }
  return { body };
}

export function PromotionManager({ initial }: { initial: Promotion[] }) {
  const router = useRouter();
  /** 正在编辑的活动；null = 没有编辑表单打开着 */
  const [editing, setEditing] = useState<Promotion | null>(null);
  /** 是否在新建 */
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<PromotionForm>(EMPTY_FORM);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function openCreate() {
    setEditing(null);
    setCreating(true);
    setForm(EMPTY_FORM);
    setMessage(null);
  }

  function openEdit(promotion: Promotion) {
    setCreating(false);
    setEditing(promotion);
    setMessage(null);
    setForm({
      name: promotion.name,
      description: promotion.description ?? '',
      // ⚠️ 展示时用「元」，提交时再转回「分」
      minAmount: centsToYuan(promotion.minAmount),
      discountAmount: centsToYuan(promotion.discountAmount),
      startsAt: toLocalDateTimeInput(promotion.startsAt),
      endsAt: toLocalDateTimeInput(promotion.endsAt),
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
        editing ? `/api/promotions/${editing.id}` : '/api/promotions',
        {
          method: editing ? 'PATCH' : 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(built.body),
        },
      );
      const failure = await readResponse(
        response,
        editing ? '保存失败' : '创建失败',
      );
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
  async function toggleStatus(promotion: Promotion) {
    const next = promotion.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';
    setMessage(null);
    try {
      const response = await fetch(`/api/promotions/${promotion.id}`, {
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

  async function remove(promotion: Promotion) {
    if (!confirm(`确定删除满减活动「${promotion.name}」？`)) {
      return;
    }
    setMessage(null);
    try {
      const response = await fetch(`/api/promotions/${promotion.id}`, {
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
          {editing ? `编辑「${editing.name}」` : '新建满减活动'}
        </p>

        <div className="flex flex-wrap gap-2">
          <input
            value={form.name}
            aria-label="活动名称"
            placeholder="活动名称（如 满200减30）"
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="rounded-md border px-2 py-1 text-sm"
          />
        </div>

        <div className="flex flex-wrap gap-2">
          <label className="flex items-center gap-1 text-sm">
            门槛（元）
            <input
              value={form.minAmount}
              aria-label="门槛（元）"
              placeholder="200"
              onChange={(e) => setForm({ ...form, minAmount: e.target.value })}
              className="w-24 rounded-md border px-2 py-1 text-sm"
            />
          </label>
          <label className="flex items-center gap-1 text-sm">
            减免（元）
            <input
              value={form.discountAmount}
              aria-label="减免金额（元）"
              placeholder="30"
              onChange={(e) =>
                setForm({ ...form, discountAmount: e.target.value })
              }
              className="w-24 rounded-md border px-2 py-1 text-sm"
            />
          </label>
        </div>

        <input
          value={form.description}
          aria-label="活动说明"
          placeholder="活动说明（选填）"
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
          还没有满减活动。活动自动生效，消费者不需要领取。
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {initial.map((promotion) => (
            <li
              key={promotion.id}
              className="flex flex-col gap-2 rounded-lg border p-4"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex flex-col gap-1">
                  <span className="font-medium">{promotion.name}</span>
                  <span className="text-sm text-muted-foreground">
                    减 {formatPrice(promotion.discountAmount)}
                    {promotion.minAmount > 0
                      ? `，满 ${formatPrice(promotion.minAmount)} 可用`
                      : '，无门槛'}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(promotion.startsAt).toLocaleString('zh-CN')} 至{' '}
                    {new Date(promotion.endsAt).toLocaleString('zh-CN')}
                  </span>
                </div>
                <span className="rounded-md border px-2 py-1 text-xs">
                  {PROMOTION_STATUS_LABEL[promotion.status] ?? promotion.status}
                </span>
              </div>
              <div className="flex gap-3 text-xs">
                <button
                  type="button"
                  onClick={() => openEdit(promotion)}
                  className="underline"
                >
                  编辑
                </button>
                <button
                  type="button"
                  onClick={() => toggleStatus(promotion)}
                  className="underline"
                >
                  {promotion.status === 'ACTIVE' ? '暂停' : '启用'}
                </button>
                <button
                  type="button"
                  onClick={() => remove(promotion)}
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
          新建满减活动
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
