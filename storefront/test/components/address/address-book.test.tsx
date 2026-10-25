// @vitest-environment jsdom
/**
 * 护栏 7 / 8：地址簿的四条关键行为。
 *
 * ⚠️ **这份测试不能少**——设计文档 §6.3 的失败注入
 * #10（「设为默认」改成乐观更新）与 #11（去掉删除的二次确认）
 * **挂在这份测试上**。没有它，这两条注入就没有测试可挂，
 * 验收时会误判成「注入没生效」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AddressBook } from '@/components/address/address-book';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const ADDRESS_A = {
  id: 'a1',
  receiver: '张三',
  phone: '13800000000',
  province: '浙江省',
  city: '杭州市',
  district: '西湖区',
  detail: '文一西路 100 号',
  isDefault: false,
};

const ADDRESS_B = {
  id: 'a2',
  receiver: '李四',
  phone: '13900000000',
  province: '江苏省',
  city: '南京市',
  district: '鼓楼区',
  detail: '中山路 200 号',
  isDefault: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('地址簿', () => {
  it('「设为默认」要等 PATCH 返回后才更新界面（护栏 7 / L9）', async () => {
    // ⚠️ 关键：PATCH 的响应**延后**返回。
    // 若实现是乐观更新（先改界面再发请求），那么在响应回来之前
    // 界面上的「默认」标记就已经变了——这条用例会挂。
    let resolvePatch: (r: Response) => void = () => {};
    const patched = new Promise<Response>((resolve) => {
      resolvePatch = resolve;
    });
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/a1')) return patched;
      return Promise.resolve(jsonResponse({ ok: true }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<AddressBook initial={[ADDRESS_A, ADDRESS_B]} error={null} />);

    // 初始：a2 是默认，a1 不是
    expect(screen.getByText('默认')).toBeTruthy();
    expect(screen.getAllByText('默认')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: '设为默认 张三 的地址' }));

    // PATCH 还没返回 → 界面**不该**变
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // 默认标记仍然只有一条，且仍然是李四那条
    expect(screen.getAllByText('默认')).toHaveLength(1);

    // PATCH 返回（服务端说 a1 现在是默认）
    resolvePatch(jsonResponse({ ...ADDRESS_A, isDefault: true }));
    await waitFor(() => {
      // 界面已更新：张三那条是默认了
      expect(
        screen.getByRole('button', { name: '设为默认 张三 的地址' }),
      ).toBeTruthy();
    });
    // 张三那条不再显示「设为默认」按钮（它已经是默认了）
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: '设为默认 张三 的地址' }),
      ).toBeNull(),
    );
    expect(screen.getAllByText('默认')).toHaveLength(1);
  });

  it('「删除」点第一次不调 DELETE，第二次才调（护栏 7 / L10）', async () => {
    // ⚠️ 这是失败注入 #11 的挂点。
    const confirmSpy = vi
      .spyOn(window, 'confirm')
      .mockReturnValueOnce(false) // 第一次点：用户取消
      .mockReturnValueOnce(true); // 第二次点：用户确认
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<AddressBook initial={[ADDRESS_A, ADDRESS_B]} error={null} />);

    await user.click(screen.getByRole('button', { name: '删除 张三 的地址' }));

    // 第一次：用户取消 → **不发 DELETE**
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();

    // 第二次：用户确认 → 才发 DELETE
    await user.click(screen.getByRole('button', { name: '删除 张三 的地址' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/addresses/a1');
    expect(init.method).toBe('DELETE');
  });

  it('删除成功后列表里移除该项', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<AddressBook initial={[ADDRESS_A, ADDRESS_B]} error={null} />);

    expect(screen.getByText('张三')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '删除 张三 的地址' }));

    await waitFor(() => expect(screen.queryByText('张三')).toBeNull());
    // 另一条还在
    expect(screen.getByText('李四')).toBeTruthy();
  });

  it('加载失败时显示错误，而不是谎报「空」', async () => {
    render(<AddressBook initial={[]} error="地址簿加载失败" />);

    expect(screen.getByText('地址簿加载失败')).toBeTruthy();
    // ⚠️ 不能显示「还没有收货地址。」——那是谎报
    expect(screen.queryByText('还没有收货地址。')).toBeNull();
  });

  it('地址簿为空时显示「还没有收货地址。」并能展开新增表单', async () => {
    const user = userEvent.setup();
    render(<AddressBook initial={[]} error={null} />);

    expect(screen.getByText('还没有收货地址。')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '新增地址' }));
    expect(screen.getByLabelText('收件人')).toBeTruthy();
  });
});
