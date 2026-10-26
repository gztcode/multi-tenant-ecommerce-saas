/**
 * 护栏 M1 / M2 / M9 与白名单纪律：计费中转路由的**请求体白名单重建**。
 *
 * 为什么整体透传是危险的：
 * - 后端 ValidationPipe 开了 forbidNonWhitelisted，客户端多传一个字段
 *   就会被后端 400，而那种 400 在界面上只是一句没头没尾的校验失败。
 * - 更根本的问题是：**后端 DTO 哪天加了个字段，它就会静默变成客户端可写**。
 *
 * 所以这里断言 apiFetch 收到的**完整 body**——不是断言「某个字段不在」，
 * 而是断言「后端收到的 body 就正好是白名单里的那几个键，多一个都没有」。
 *
 * 计费这块特别锁住了四件容易改错的事：
 * 1. **订阅只发 `planId`**：价格、抽佣率、额度、功能开关全部从库里读。
 *    客户端传了 `price` 就是「自己给自己打折」。
 * 2. **付账单只发 `channel`**：金额只从账单读。带上金额就是「付 1 分钱
 *    把一年期的账结了」。
 * 3. **绑支付方式不接受 `token`**：token 必须由渠道给。客户端传 token
 *    就能绑一张不属于自己的卡，自动续费时扣的是别人的钱。
 * 4. **账单号与支付方式 id 来自 URL**：不是请求体。请求体里带一个
 *    「替别的店铺付账」的账单号是越权尝试。
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

import { GET as plansGet } from '@/app/api/billing/plans/route';
import {
  GET as subscriptionGet,
  PATCH as changePlanPatch,
  POST as subscribePost,
} from '@/app/api/billing/subscription/route';
import { GET as invoicesGet } from '@/app/api/billing/invoices/route';
import { POST as payInvoicePost } from '@/app/api/billing/invoices/[number]/pay/route';
import {
  GET as paymentMethodsGet,
  POST as createPaymentMethodPost,
} from '@/app/api/billing/payment-methods/route';
import { DELETE as removePaymentMethod } from '@/app/api/billing/payment-methods/[id]/route';
import { POST as setDefaultPaymentMethod } from '@/app/api/billing/payment-methods/[id]/default/route';

import { TEST_SESSION, postRequest } from '../../helpers/route-harness';

const authMock = vi.mocked(auth);
const apiFetchMock = vi.mocked(apiFetch);

/** 动态路由的第二个参数（Next.js 15 里 params 是 Promise） */
const invoiceParams = Promise.resolve({ number: 'INV-2026-001' });
const methodParams = Promise.resolve({ id: 'pm-1' });

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue(TEST_SESSION as never);
  apiFetchMock.mockResolvedValue({ id: 'x' } as never);
});

describe('计费中转：各 GET 路由打到正确的后端路径', () => {
  it('套餐列表打到 /billing/plans', async () => {
    await plansGet();

    const [path] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/billing/plans');
  });

  it('当前订阅打到 /billing/subscription', async () => {
    await subscriptionGet();

    const [path] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/billing/subscription');
  });

  it('账单列表打到 /billing/invoices', async () => {
    await invoicesGet();

    const [path] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/billing/invoices');
  });

  it('支付方式列表打到 /billing/payment-methods', async () => {
    await paymentMethodsGet();

    const [path] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/billing/payment-methods');
  });
});

describe('计费中转：写操作的路径', () => {
  it('订阅打到 /billing/subscription', async () => {
    await subscribePost(
      postRequest('http://localhost/api/billing/subscription', {
        planId: 'plan-1',
      }),
    );

    const [path] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/billing/subscription');
  });

  it('付账单打到 /billing/invoices/:number/pay', async () => {
    await payInvoicePost(
      postRequest('http://localhost/api/billing/invoices/INV-2026-001/pay', {
        channel: 'FAKE',
      }),
      { params: invoiceParams },
    );

    const [path] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/billing/invoices/INV-2026-001/pay');
  });

  it('绑支付方式打到 /billing/payment-methods', async () => {
    await createPaymentMethodPost(
      postRequest('http://localhost/api/billing/payment-methods', {
        type: 'CARD',
        channel: 'FAKE',
      }),
    );

    const [path] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/billing/payment-methods');
  });

  it('解绑支付方式打到 /billing/payment-methods/:id', async () => {
    await removePaymentMethod(
      new Request('http://localhost/api/billing/payment-methods/pm-1', {
        method: 'DELETE',
      }),
      { params: methodParams },
    );

    const [path] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/billing/payment-methods/pm-1');
  });

  it('设为默认打到 /billing/payment-methods/:id/default', async () => {
    await setDefaultPaymentMethod(
      postRequest('http://localhost/api/billing/payment-methods/pm-1/default', {}),
      { params: methodParams },
    );

    const [path] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/billing/payment-methods/pm-1/default');
  });
});

describe('计费中转：订阅的请求体白名单', () => {
  it('只发 planId', async () => {
    const response = await subscribePost(
      postRequest('http://localhost/api/billing/subscription', {
        planId: 'plan-1',
      }),
    );

    expect(response.status).toBe(200);
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/billing/subscription',
      {
        method: 'POST',
        body: { planId: 'plan-1' },
        token: TEST_SESSION.accessToken,
      },
    );
  });

  it('⚠️ 价格、抽佣率、额度、功能开关都不进后端（否则就是自己给自己打折）', async () => {
    await subscribePost(
      postRequest('http://localhost/api/billing/subscription', {
        planId: 'plan-1',
        // 这些都该被丢弃：
        price: 0,
        commissionBps: 0,
        maxProducts: 999999,
        maxSkus: 999999,
        maxStores: 999999,
        features: { marketing: true },
        status: 'ACTIVE',
        tenantId: 'other-tenant',
        trialDays: 3650,
      }),
    );

    const [, options] = apiFetchMock.mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['planId']);
  });

  it('planId 缺失时 400，且不调后端', async () => {
    const response = await subscribePost(
      postRequest('http://localhost/api/billing/subscription', {
        price: 100,
      }),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('planId 为空串时 400，且不调后端', async () => {
    const response = await subscribePost(
      postRequest('http://localhost/api/billing/subscription', {
        planId: '   ',
      }),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe('计费中转：换套餐（PATCH）的请求体白名单', () => {
  it('打到 /billing/subscription 且用 PATCH', async () => {
    await changePlanPatch(
      postRequest('http://localhost/api/billing/subscription', {
        planId: 'plan-2',
      }),
    );

    const [path, options] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/billing/subscription');
    expect(options?.method).toBe('PATCH');
  });

  it('只发 planId', async () => {
    const response = await changePlanPatch(
      postRequest('http://localhost/api/billing/subscription', {
        planId: 'plan-2',
      }),
    );

    expect(response.status).toBe(200);
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/billing/subscription',
      {
        method: 'PATCH',
        body: { planId: 'plan-2' },
        token: TEST_SESSION.accessToken,
      },
    );
  });

  it('⚠️ 价格、抽佣率、额度、功能开关都不进后端', async () => {
    await changePlanPatch(
      postRequest('http://localhost/api/billing/subscription', {
        planId: 'plan-2',
        price: 0,
        commissionBps: 0,
        maxProducts: 999999,
        maxSkus: 999999,
        maxStores: 999999,
        features: { marketing: true },
        tenantId: 'other-tenant',
      }),
    );

    const [, options] = apiFetchMock.mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['planId']);
  });

  it('planId 缺失时 400，且不调后端', async () => {
    const response = await changePlanPatch(
      postRequest('http://localhost/api/billing/subscription', {
        price: 100,
      }),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('planId 为空串时 400，且不调后端', async () => {
    const response = await changePlanPatch(
      postRequest('http://localhost/api/billing/subscription', {
        planId: '   ',
      }),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('畸形请求体 → 400，且不调后端', async () => {
    for (const payload of [['a'], 'not-an-object', null]) {
      const response = await changePlanPatch(
        postRequest('http://localhost/api/billing/subscription', payload),
      );

      expect(response.status).toBe(400);
    }
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('未登录 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await changePlanPatch(
      postRequest('http://localhost/api/billing/subscription', {
        planId: 'plan-2',
      }),
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe('计费中转：付账单的请求体白名单', () => {
  it('只发 channel', async () => {
    const response = await payInvoicePost(
      postRequest('http://localhost/api/billing/invoices/INV-2026-001/pay', {
        channel: 'FAKE',
      }),
      { params: invoiceParams },
    );

    expect(response.status).toBe(200);
    const [, options] = apiFetchMock.mock.calls[0];
    expect(Object.keys(options?.body as Record<string, unknown>).sort()).toEqual([
      'channel',
    ]);
  });

  it('⚠️ 金额字段不进后端（金额只从账单读）', async () => {
    await payInvoicePost(
      postRequest('http://localhost/api/billing/invoices/INV-2026-001/pay', {
        channel: 'FAKE',
        amount: 1,
        price: 1,
        totalAmount: 1,
        number: 'OTHER-INVOICE',
        tenantId: 'other-tenant',
      }),
      { params: invoiceParams },
    );

    const [, options] = apiFetchMock.mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['channel']);
  });

  it('不传 channel 时 body 是空对象（后端用默认渠道）', async () => {
    await payInvoicePost(
      postRequest('http://localhost/api/billing/invoices/INV-2026-001/pay', {}),
      { params: invoiceParams },
    );

    const [, options] = apiFetchMock.mock.calls[0];
    expect(options?.body).toEqual({});
  });

  it('channel 传了非字符串时 400，且不调后端', async () => {
    const response = await payInvoicePost(
      postRequest('http://localhost/api/billing/invoices/INV-2026-001/pay', {
        channel: 123,
      }),
      { params: invoiceParams },
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('⚠️ 返回的 payUrl 是绝对地址（相对路径打到商家后台会 404）', async () => {
    // ⚠️ 后端给的 payUrl 是**相对路径**（`/api/v1/pay/fake/xxx`），
    // 支付页在**后端**上，直接丢给浏览器会打到商家后台的域名上。
    apiFetchMock.mockResolvedValue({
      paymentId: 'pay-1',
      payUrl: '/api/v1/pay/fake/fake_pay_1',
      amount: 9900,
      invoiceNumber: 'INV-2026-001',
    } as never);

    const response = await payInvoicePost(
      postRequest('http://localhost/api/billing/invoices/INV-2026-001/pay', {
        channel: 'FAKE',
      }),
      { params: invoiceParams },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { payUrl?: string };
    expect(body.payUrl).toBeTruthy();
    expect(body.payUrl).toMatch(/^https?:\/\//);
    // ⚠️ **不能把 `/api/v1` 拼两遍**
    expect(body.payUrl).not.toContain('/api/v1/api/v1');
    expect(body.payUrl).toContain('/api/v1/pay/fake/fake_pay_1');
  });
});

describe('计费中转：绑支付方式的请求体白名单', () => {
  it('只发 type 与 channel', async () => {
    const response = await createPaymentMethodPost(
      postRequest('http://localhost/api/billing/payment-methods', {
        type: 'CARD',
        channel: 'FAKE',
      }),
    );

    expect(response.status).toBe(200);
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/billing/payment-methods',
      {
        method: 'POST',
        body: { type: 'CARD', channel: 'FAKE' },
        token: TEST_SESSION.accessToken,
      },
    );
  });

  it('⚠️ token 不进后端（token 必须由渠道给）', async () => {
    await createPaymentMethodPost(
      postRequest('http://localhost/api/billing/payment-methods', {
        type: 'CARD',
        channel: 'FAKE',
        // 客户端塞一个 token 进来 = 绑一张不属于自己的卡
        token: 'tok_someone_elses_card',
      }),
    );

    const [, options] = apiFetchMock.mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['channel', 'type']);
    expect(body).not.toHaveProperty('token');
  });

  it('⚠️ 身份字段不进后端', async () => {
    await createPaymentMethodPost(
      postRequest('http://localhost/api/billing/payment-methods', {
        type: 'CARD',
        channel: 'FAKE',
        tenantId: 'other-tenant',
        isDefault: true,
        provider: 'FAKE',
        id: 'pm-owned-by-someone-else',
      }),
    );

    const [, options] = apiFetchMock.mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['channel', 'type']);
  });

  it('type 不是合法枚举时 400，且不调后端', async () => {
    const response = await createPaymentMethodPost(
      postRequest('http://localhost/api/billing/payment-methods', {
        type: 'CRYPTO',
        channel: 'FAKE',
      }),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('channel 缺失时 400，且不调后端', async () => {
    const response = await createPaymentMethodPost(
      postRequest('http://localhost/api/billing/payment-methods', {
        type: 'CARD',
      }),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe('计费中转：畸形请求体 → 400 且不调后端', () => {
  const malformed: Array<[string, unknown]> = [
    ['数组', ['a']],
    ['字符串', 'not-an-object'],
    ['null', null],
  ];

  for (const [label, payload] of malformed) {
    it(`订阅收到${label}请求体 → 400，且不调后端`, async () => {
      const response = await subscribePost(
        postRequest('http://localhost/api/billing/subscription', payload),
      );

      expect(response.status).toBe(400);
      expect(apiFetchMock).not.toHaveBeenCalled();
    });

    it(`绑支付方式收到${label}请求体 → 400，且不调后端`, async () => {
      const response = await createPaymentMethodPost(
        postRequest('http://localhost/api/billing/payment-methods', payload),
      );

      expect(response.status).toBe(400);
      expect(apiFetchMock).not.toHaveBeenCalled();
    });

    it(`付账单收到${label}请求体 → 400，且不调后端`, async () => {
      const response = await payInvoicePost(
        postRequest('http://localhost/api/billing/invoices/INV-2026-001/pay', payload),
        { params: invoiceParams },
      );

      expect(response.status).toBe(400);
      expect(apiFetchMock).not.toHaveBeenCalled();
    });
  }

  it('订阅收到非法 JSON → 400，且不调后端', async () => {
    const response = await subscribePost(
      postRequest('http://localhost/api/billing/subscription', 'not-json'),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('绑支付方式收到非法 JSON → 400，且不调后端', async () => {
    const response = await createPaymentMethodPost(
      postRequest('http://localhost/api/billing/payment-methods', 'not-json'),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe('计费中转：未登录不碰后端', () => {
  it('GET /api/billing/plans → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await plansGet();

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('GET /api/billing/subscription → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await subscriptionGet();

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('GET /api/billing/invoices → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await invoicesGet();

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('GET /api/billing/payment-methods → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await paymentMethodsGet();

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('POST 订阅 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await subscribePost(
      postRequest('http://localhost/api/billing/subscription', {
        planId: 'plan-1',
      }),
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('POST 付账单 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await payInvoicePost(
      postRequest('http://localhost/api/billing/invoices/INV-2026-001/pay', {}),
      { params: invoiceParams },
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('POST 绑支付方式 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await createPaymentMethodPost(
      postRequest('http://localhost/api/billing/payment-methods', {
        type: 'CARD',
        channel: 'FAKE',
      }),
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('DELETE 支付方式 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await removePaymentMethod(
      new Request('http://localhost/api/billing/payment-methods/pm-1', {
        method: 'DELETE',
      }),
      { params: methodParams },
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('POST 设为默认 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await setDefaultPaymentMethod(
      postRequest('http://localhost/api/billing/payment-methods/pm-1/default', {}),
      { params: methodParams },
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
