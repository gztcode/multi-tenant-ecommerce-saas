/**
 * 护栏 M1 / M2 / M9 与白名单纪律：收款账户中转路由的**请求体白名单重建**。
 *
 * ⚠️ **收款账户是钱的去向**：请求体多透传一个字段，可能就意味着
 * 「把账号改到别人卡上」。所以这里断言 apiFetch 收到的**完整 body** ——
 * 不是断言「某个字段不在」，而是断言「后端收到的 body 就正好是
 * 白名单里的那几个键，多一个都没有」。
 *
 * ⚠️ **后端 ValidationPipe 开了 forbidNonWhitelisted**：整体透传多传一个
 * 字段就是 400，而那种 400 在界面上只是一句没头没尾的校验失败。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-client')>(
    '@/lib/api-client',
  );
  return {
    ...actual,
    apiFetch: vi.fn(),
  };
});

import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';

import {
  GET as accountGet,
  PUT as accountPut,
} from '@/app/api/merchant/payout-account/route';

import { TEST_SESSION } from '../../helpers/route-harness';

const authMock = vi.mocked(auth);
const apiFetchMock = vi.mocked(apiFetch);

/**
 * 构造一个 PUT 请求。body 传原始字符串以便构造非法 JSON。
 *
 * ⚠️ **不复用 harness 里的 `postRequest`**：那个固定发 POST，
 *    这里要的就是 PUT。
 */
function putRequest(url: string, body?: unknown): Request {
  return new Request(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue(TEST_SESSION as never);
  apiFetchMock.mockResolvedValue({ accountName: '张三' } as never);
});

describe('收款账户中转：请求体白名单', () => {
  it('账号有值时只发开户人、开户行、账号三个字段', async () => {
    await accountPut(
      putRequest('http://localhost/api/merchant/payout-account', {
        accountName: '张三',
        bankName: '招商银行',
        accountNo: '6225880000000000',
        tenantId: 'other-tenant',
        maskedAccountNo: '****0000',
      }),
    );

    const [, options] = apiFetchMock.mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'accountName',
      'accountNo',
      'bankName',
    ]);
  });

  it('⚠️ 账号留空 → 不带 accountNo 这个键（不是传空串）', async () => {
    await accountPut(
      putRequest('http://localhost/api/merchant/payout-account', {
        accountName: '张三',
        bankName: '招商银行',
        accountNo: '',
      }),
    );

    const [, options] = apiFetchMock.mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    // ⚠️ **必须是「键不存在」而不是「值为空串」**：
    //    后端「留空 = 不修改这一项」靠的就是「没这个键」；
    //    传空串会被当成「把账号清成空」。
    expect(Object.keys(body).sort()).toEqual(['accountName', 'bankName']);
    expect(body).not.toHaveProperty('accountNo');
  });

  it('⚠️ 账号是纯空白 → 同样不带 accountNo 这个键', async () => {
    await accountPut(
      putRequest('http://localhost/api/merchant/payout-account', {
        accountName: '张三',
        bankName: '招商银行',
        accountNo: '   ',
      }),
    );

    const [, options] = apiFetchMock.mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['accountName', 'bankName']);
  });

  it('⚠️ 身份字段与脱敏字段都不进后端', async () => {
    await accountPut(
      putRequest('http://localhost/api/merchant/payout-account', {
        accountName: '张三',
        bankName: '招商银行',
        accountNo: '6225880000000000',
        tenantId: 'other-tenant',
        id: 'acct-owned-by-someone-else',
        maskedAccountNo: '****0000',
      }),
    );

    const [, options] = apiFetchMock.mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('tenantId');
    expect(body).not.toHaveProperty('id');
    expect(body).not.toHaveProperty('maskedAccountNo');
  });

  it('用 PUT 方法打到 /merchant/payout-account', async () => {
    await accountPut(
      putRequest('http://localhost/api/merchant/payout-account', {
        accountName: '张三',
        bankName: '招商银行',
        accountNo: '6225880000000000',
      }),
    );

    const [path, options] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/merchant/payout-account');
    expect(options?.method).toBe('PUT');
    expect(options?.token).toBe(TEST_SESSION.accessToken);
  });

  it('缺开户人或开户行 → 400 且不调后端', async () => {
    // ⚠️ **账号不再是必填**：后端「留空 = 不修改原账号」，
    //    所以只有开户人 / 开户行才是中转这一层能判定的缺字段。
    for (const payload of [
      { accountName: '张三' },
      { bankName: '招商银行' },
      { accountName: '张三', bankName: '' },
      { accountName: '', bankName: '招商银行' },
    ]) {
      const response = await accountPut(
        putRequest('http://localhost/api/merchant/payout-account', payload),
      );

      expect(response.status).toBe(400);
    }
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('⚠️ 只缺账号 → 不 400（透传给后端，由后端在首次设置时报 400）', async () => {
    const response = await accountPut(
      putRequest('http://localhost/api/merchant/payout-account', {
        accountName: '张三',
        bankName: '招商银行',
      }),
    );

    // ⚠️ **中转不替后端做「首次设置必须填账号」的判断**：
    //    中转分不清「首次设置」与「改开户人姓名」两种场景，
    //    猜错就会把商家改开户人姓名的请求挡掉。
    expect(response.status).toBe(200);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it('空白字段 → 400 且不调后端', async () => {
    const response = await accountPut(
      putRequest('http://localhost/api/merchant/payout-account', {
        accountName: '   ',
        bankName: '招商银行',
        accountNo: '6225880000000000',
      }),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('畸形请求体 → 400 且不调后端', async () => {
    for (const payload of [['a'], 'not-an-object', null]) {
      const response = await accountPut(
        putRequest('http://localhost/api/merchant/payout-account', payload),
      );

      expect(response.status).toBe(400);
    }
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('非法 JSON → 400 且不调后端', async () => {
    const response = await accountPut(
      putRequest('http://localhost/api/merchant/payout-account', 'not-json'),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('未登录 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await accountGet();

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('未登录时 PUT 也 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await accountPut(
      putRequest('http://localhost/api/merchant/payout-account', {
        accountName: '张三',
        bankName: '招商银行',
        accountNo: '6225880000000000',
      }),
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
