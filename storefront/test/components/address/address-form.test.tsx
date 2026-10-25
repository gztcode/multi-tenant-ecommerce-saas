// @vitest-environment jsdom
/**
 * 护栏 8：地址表单的提交目标与 `sanitizeAddressBody` 一致。
 *
 * ⚠️ **不要另写一套规则**。`sanitizeAddressBody`
 * （storefront/src/lib/addresses.ts）是前后端共同的白名单，
 * 它已有 7 条单元测试（storefront/test/lib/addresses.test.ts）守着。
 * 前端表单直接复用它的判定，前后端规则就不会漂移。
 *
 * ⚠️ **表单本身不做校验**（校验在 `AddressBook` 那一侧做）——
 * 否则结算页会因为提取组件而多出「留空字段被前端拦住」的行为变更。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AddressForm } from '@/components/address/address-form';
import { sanitizeAddressBody } from '@/lib/addresses';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 一条完整的地址 */
const VALID = {
  receiver: '张三',
  phone: '13800000000',
  province: '浙江省',
  city: '杭州市',
  district: '西湖区',
  detail: '文一西路 100 号',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('地址表单', () => {
  it('新增时提交全部六个字段', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'a1', ...VALID }));
    vi.stubGlobal('fetch', fetchMock);

    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<AddressForm mode="create" onCreated={onCreated} />);

    await user.type(screen.getByLabelText('收件人'), VALID.receiver);
    await user.type(screen.getByLabelText('手机号'), VALID.phone);
    await user.type(screen.getByLabelText('省份'), VALID.province);
    await user.type(screen.getByLabelText('城市'), VALID.city);
    await user.type(screen.getByLabelText('区 / 县'), VALID.district);
    await user.type(screen.getByLabelText('详细地址'), VALID.detail);
    await user.click(screen.getByRole('button', { name: '保存地址' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/addresses');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(VALID);
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it('编辑时提交到 PATCH /api/addresses/:id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'a1', ...VALID }));
    vi.stubGlobal('fetch', fetchMock);

    const onUpdated = vi.fn();
    const user = userEvent.setup();
    render(
      <AddressForm
        mode="edit"
        addressId="a1"
        initial={{ id: 'a1', ...VALID, isDefault: false }}
        onUpdated={onUpdated}
      />,
    );

    await user.click(screen.getByRole('button', { name: '保存地址' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/addresses/a1');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual(VALID);
    expect(onUpdated).toHaveBeenCalledTimes(1);
  });

  it('表单自身不做 JS 校验：不传 validate 时不拦提交（结算页行为不变）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'a1', ...VALID }));
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<AddressForm mode="create" onCreated={vi.fn()} />);

    // 六个字段都填上——没有 validate 时组件自己不加任何 JS 校验，
    // 提交请求照发（结算页就是这个形态：它不传 validate）。
    await user.type(screen.getByLabelText('收件人'), VALID.receiver);
    await user.type(screen.getByLabelText('手机号'), VALID.phone);
    await user.type(screen.getByLabelText('省份'), VALID.province);
    await user.type(screen.getByLabelText('城市'), VALID.city);
    await user.type(screen.getByLabelText('区 / 县'), VALID.district);
    await user.type(screen.getByLabelText('详细地址'), VALID.detail);
    await user.click(screen.getByRole('button', { name: '保存地址' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it('传了 validate 时，校验不通过就不发请求（地址簿页的前端校验）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 'a1', ...VALID }));
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(
      <AddressForm
        mode="create"
        validate={(fields) => {
          const result = sanitizeAddressBody(fields);
          return result.ok ? null : result.message;
        }}
        onCreated={vi.fn()}
      />,
    );

    await user.type(screen.getByLabelText('收件人'), VALID.receiver);
    await user.click(screen.getByRole('button', { name: '保存地址' }));

    // 校验不通过 → 不发请求，且显示中文错误
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await screen.findByText('手机号 必须是非空字符串')).toBeTruthy();
  });

  it('后端拒绝时显示后端返回的 message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ message: '手机号格式不正确' }, 400)),
    );

    const user = userEvent.setup();
    render(<AddressForm mode="create" onCreated={vi.fn()} />);

    await user.type(screen.getByLabelText('收件人'), VALID.receiver);
    await user.type(screen.getByLabelText('手机号'), VALID.phone);
    await user.type(screen.getByLabelText('省份'), VALID.province);
    await user.type(screen.getByLabelText('城市'), VALID.city);
    await user.type(screen.getByLabelText('区 / 县'), VALID.district);
    await user.type(screen.getByLabelText('详细地址'), VALID.detail);
    await user.click(screen.getByRole('button', { name: '保存地址' }));

    expect(await screen.findByText('手机号格式不正确')).toBeTruthy();
  });
});
