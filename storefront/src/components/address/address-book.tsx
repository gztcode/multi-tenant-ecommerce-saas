'use client';

import { useState } from 'react';
import { AddressForm } from '@/components/address/address-form';
import { Button } from '@/components/ui/button';
import { sanitizeAddressBody } from '@/lib/addresses';
import { formatAddress } from '@/lib/cart';
import type { Address } from '@/lib/cart';

/**
 * 地址簿：列出地址，能新增、编辑、删除、设为默认。
 *
 * ## ⚠️ 校验在**这一侧**做，不在 `AddressForm` 里
 *
 * `AddressForm` 是从结算页提取出来的共享组件，提取前结算页的行为是
 * 「留空字段照样发给后端」。把校验塞进那个组件，结算页就会多出
 * 「点了没反应（前端拦住）」的用户可见行为变更。
 *
 * 所以校验放在这里——地址簿页提交前先用 `sanitizeAddressBody`
 * （前后端共同的白名单）过一遍，不通过就把错误显示在页面上、不提交。
 * 规则仍是同一份，不会漂移。
 *
 * ## ⚠️ 「设为默认」**不做乐观更新**
 *
 * 后端有部分唯一索引（addresses_tenant_customer_default_uniq）
 * 保证默认地址唯一，且在 create/update 时会先 clearDefault。
 * 前端抢着改界面，界面显示的就与库里不一致。
 * 所以这里等 PATCH 返回后，用**服务端返回的地址**更新状态。
 *
 * ⚠️ 前端**不需要**自己先取消旧的默认——只管发 `isDefault: true`。
 */
export function AddressBook({
  initial,
  error,
}: {
  /** 服务端取到的地址列表 */
  initial: Address[];
  /** 服务端取数时的错误（加载失败不是「空」） */
  error: string | null;
}) {
  const [addresses, setAddresses] = useState<Address[]>(initial);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  /** 正在新增：展开表单 */
  const [creating, setCreating] = useState(false);
  /** 正在编辑的地址 id */
  const [editingId, setEditingId] = useState<string | null>(null);

  /**
   * 统一的请求封装：错误 message 直接可以显示给人看。
   */
  async function call(
    url: string,
    method: string,
    body?: unknown,
  ): Promise<unknown> {
    const response = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as {
        message?: string;
      };
      throw new Error(payload.message ?? '操作失败');
    }
    if (response.status === 204) return null;
    return response.json();
  }

  /**
   * 设为默认。
   *
   * ⚠️ **不做乐观更新**：等 PATCH 返回后用服务端返回的地址更新界面。
   */
  async function setDefault(id: string) {
    setBusy(true);
    setFormError(null);
    try {
      const updated = (await call(
        `/api/addresses/${encodeURIComponent(id)}`,
        'PATCH',
        { isDefault: true },
      )) as Address;
      // 用服务端返回的值更新列表：
      // 旧默认的那条按「服务端说它现在不是默认」处理，
      // 被设为默认的那条直接用服务端返回的整条记录覆盖。
      setAddresses((prev) =>
        prev.map((a) =>
          a.id === id
            ? updated
            : updated.isDefault
              ? { ...a, isDefault: false }
              : a,
        ),
      );
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : '设置默认地址失败');
    } finally {
      setBusy(false);
    }
  }

  /**
   * 删除地址。
   *
   * ⚠️ 二次确认。与 cart-list.tsx 的 `confirm('确定清空购物车？')`
   * 的既有风格一致。
   */
  async function remove(address: Address) {
    if (!confirm(`确定删除「${address.receiver} ${address.phone}」的地址？`)) {
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      await call(`/api/addresses/${encodeURIComponent(address.id)}`, 'DELETE');
      setAddresses((prev) => prev.filter((a) => a.id !== address.id));
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : '删除失败');
    } finally {
      setBusy(false);
    }
  }

  /**
   * 新增成功后：把新地址插到列表里（默认地址排最前，与后端排序一致）。
   */
  function handleCreated(address: Address) {
    setAddresses((prev) =>
      address.isDefault
        ? [address, ...prev.map((a) => ({ ...a, isDefault: false }))]
        : [...prev, address],
    );
    setCreating(false);
    setFormError(null);
  }

  /**
   * 编辑成功后：原地替换那条地址。
   */
  function handleUpdated(address: Address) {
    setAddresses((prev) =>
      prev.map((a) => (a.id === address.id ? address : a)),
    );
    setEditingId(null);
    setFormError(null);
  }

  /**
   * ⚠️ **校验在这一侧做**（见文件头的说明）。
   *
   * 用的是 `sanitizeAddressBody`——前后端共同的白名单，
   * 规则只有这一份，不会与后端漂移。
   *
   * ⚠️ 注意：这里只查「字段类型与空串」。**必填项缺不缺**由后端管
   * （中转路由 `app/api/addresses/route.ts` 里有必填检查）——
   * 规则仍然只有一份。
   */
  function validate(fields: Record<string, unknown>): string | null {
    const result = sanitizeAddressBody(fields);
    return result.ok ? null : result.message;
  }

  // ⚠️ **加载失败不是「空地址簿」**。
  //
  // 早期版本把两者混在一起显示「还没有收货地址。」——但地址其实还在库里
  // （后端 401/500 时前端拿不到 items）。用户看到「还没有收货地址」
  // 会以为地址没了，甚至重新填一遍。所以失败时显示错误，绝不谎报「空」。
  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" onClick={() => window.location.reload()}>
          重试
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {formError && <p className="text-sm text-destructive">{formError}</p>}

      {addresses.length === 0 && !creating && (
        <p className="text-sm text-muted-foreground">还没有收货地址。</p>
      )}

      <ul className="flex flex-col gap-3">
        {addresses.map((address) => (
          <li key={address.id} className="flex flex-col gap-2 rounded-md border p-3">
            <div className="flex flex-col gap-0.5 text-sm">
              <span className="flex items-center gap-2">
                <span>{address.receiver}</span>
                <span className="text-muted-foreground">{address.phone}</span>
                {address.isDefault && (
                  <span className="text-xs text-muted-foreground">默认</span>
                )}
              </span>
              <span className="text-muted-foreground">
                {formatAddress(address)}
              </span>
            </div>

            <div className="flex flex-wrap gap-3 text-sm">
              {!address.isDefault && (
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`设为默认 ${address.receiver} 的地址`}
                  onClick={() => setDefault(address.id)}
                  className="underline disabled:opacity-40"
                >
                  设为默认
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                aria-label={`编辑 ${address.receiver} 的地址`}
                onClick={() =>
                  setEditingId((prev) => (prev === address.id ? null : address.id))
                }
                className="underline disabled:opacity-40"
              >
                编辑
              </button>
              <button
                type="button"
                disabled={busy}
                aria-label={`删除 ${address.receiver} 的地址`}
                onClick={() => remove(address)}
                className="text-destructive underline disabled:opacity-40"
              >
                删除
              </button>
            </div>

            {editingId === address.id && (
              <AddressForm
                mode="edit"
                addressId={address.id}
                initial={address}
                validate={validate}
                onUpdated={handleUpdated}
              />
            )}
          </li>
        ))}
      </ul>

      {creating ? (
        <AddressForm mode="create" validate={validate} onCreated={handleCreated} />
      ) : (
        <Button
          variant="outline"
          className="self-start"
          onClick={() => setCreating(true)}
        >
          新增地址
        </Button>
      )}
    </div>
  );
}
