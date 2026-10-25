'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { Address } from '@/lib/cart';

/**
 * 地址表单（新增 / 编辑）。
 *
 * ## 为什么从结算页提取出来
 *
 * 六个必填字段复制一遍必然漂移——结算页与地址簿页各写一份，
 * 过几个月就会变成「结算页多一个字段、地址簿页少一个字段」。
 * 提取后两个地方共用同一个组件。
 *
 * ## ⚠️ 这里**不做校验**
 *
 * 校验放在 `AddressBook` 那一侧做，不放在这个共享组件里。
 *
 * 原因：结算页现在的内联表单**没有**前端校验——留空字段照样发给后端，
 * 由后端返回错误。如果把校验塞进这个共享组件，结算页就会多出
 * 「点了没反应（前端拦住）」的行为，那是**用户可见的行为变更**，
 * 而阶段 3 验收场景 13 测的就是结算页新增地址这条路径。
 *
 * 所以：**这个组件的行为与提取前的结算页版本完全一致**。
 * 地址簿页需要的校验由 `AddressBook` 通过 `validate` 回调提供
 * ——规则仍是同一份（前后端共同的白名单），只是入口不在一处。
 *
 * `validate` 不传时**完全不做校验**（结算页就是这种用法）。
 */

/** 表单里的六个字段 */
interface FormState {
  receiver: string;
  phone: string;
  province: string;
  city: string;
  district: string;
  detail: string;
  // ⚠️ 索引签名：为了让 `FormState` 能传给
  // `validate?: (fields: Record<string, unknown>) => string | null`
  // （`sanitizeAddressBody` 收的就是 `Record<string, unknown>`）。
  [field: string]: string;
}

/** 空表单 */
const EMPTY_FORM: FormState = {
  receiver: '',
  phone: '',
  province: '',
  city: '',
  district: '',
  detail: '',
};

export function AddressForm({
  mode,
  addressId,
  initial,
  validate,
  onCreated,
  onUpdated,
}: {
  mode: 'create' | 'edit';
  /** mode 为 'edit' 时必填 */
  addressId?: string;
  /** mode 为 'edit' 时的初始值 */
  initial?: Address;
  /**
   * 提交前的校验。返回错误消息表示**不通过**，不提交；返回 null 表示通过。
   *
   * ⚠️ **不传就没有任何前端校验**——结算页就是这种用法（行为不变）。
   * 地址簿页由 `AddressBook` 传入基于 `sanitizeAddressBody` 的校验。
   */
  validate?: (fields: Record<string, unknown>) => string | null;
  onCreated?: (address: Address) => void;
  onUpdated?: (address: Address) => void;
}) {
  const [form, setForm] = useState<FormState>(() =>
    initial
      ? {
          receiver: initial.receiver,
          phone: initial.phone,
          province: initial.province,
          city: initial.city,
          district: initial.district,
          detail: initial.detail,
        }
      : EMPTY_FORM,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update(field: keyof FormState, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();

    // ⚠️ 校验在前端做（只有调用方传了 validate 才有）。
    // 不通过就不发请求——这是地址簿页与结算页的差别。
    const invalid = validate?.(form);
    if (invalid) {
      setError(invalid);
      return;
    }

    setBusy(true);
    setError(null);

    try {
      // ⚠️ 编辑态才带 id；新增态走 /api/addresses。
      const editing = mode === 'edit' && addressId;
      const response = await fetch(
        editing ? `/api/addresses/${encodeURIComponent(addressId)}` : '/api/addresses',
        {
          method: editing ? 'PATCH' : 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(form),
        },
      );
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new Error(payload.message ?? (editing ? '保存地址失败' : '新增地址失败'));
      }
      const address = (await response.json()) as Address;
      if (editing) {
        onUpdated?.(address);
      } else {
        onCreated?.(address);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '新增地址失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      // ⚠️ 传了 validate 就关掉浏览器的原生校验（`required`）。
      //
      // 不关的话浏览器会先拦下提交、弹一个**本地化**的原生提示，
      // 我们的 `validate` 根本不会被调用——界面上看不到
      // 「收件人 必须是非空字符串」这样的中文提示（设计文档 §4.4b 手测场景 9）。
      //
      // 不传 validate 时**保持原样**（原生 required 照旧）——
      // 结算页的行为一个字都不许变。
      noValidate={Boolean(validate)}
      className="flex flex-col gap-2 rounded-md border p-3"
    >
      <div className="grid gap-2 md:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="receiver">收件人</Label>
          <Input
            id="receiver"
            value={form.receiver}
            onChange={(event) => update('receiver', event.target.value)}
            required
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="phone">手机号</Label>
          <Input
            id="phone"
            value={form.phone}
            onChange={(event) => update('phone', event.target.value)}
            required
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="province">省份</Label>
          <Input
            id="province"
            value={form.province}
            onChange={(event) => update('province', event.target.value)}
            required
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="city">城市</Label>
          <Input
            id="city"
            value={form.city}
            onChange={(event) => update('city', event.target.value)}
            required
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="district">区 / 县</Label>
          <Input
            id="district"
            value={form.district}
            onChange={(event) => update('district', event.target.value)}
            required
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="detail">详细地址</Label>
          <Input
            id="detail"
            value={form.detail}
            onChange={(event) => update('detail', event.target.value)}
            required
          />
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Button type="submit" variant="outline" disabled={busy} className="self-start">
        {busy ? '保存中…' : '保存地址'}
      </Button>
    </form>
  );
}
