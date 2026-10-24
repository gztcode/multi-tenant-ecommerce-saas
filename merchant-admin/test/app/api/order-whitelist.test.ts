/**
 * 护栏 2：中转路由的**请求体白名单**——订单的发货与退款请求体必须重建。
 *
 * 为什么整体透传是危险的：
 * - 后端 ValidationPipe 开了 forbidNonWhitelisted，客户端多传一个字段
 *   就会被后端 400，而那种 400 在界面上只是一句没头没尾的校验失败。
 * - 更根本的问题是：后端 DTO 哪天加了个字段（哪怕只是内部用的），
 *   整体透传就让它静默变成了客户端可写。
 *
 * 所以这里断言 apiFetch 收到的**完整 body**——不是断言「某个字段不在」，
 * 而是断言「后端收到的 body 就正好是白名单里的那几个键，多一个都没有」。
 *
 * 另外还锁住了两件容易改错的事：
 * 1. **商家侧的路径带 `merchant/` 前缀**——写成 `/orders` 会打到消费者侧
 *    的路由上（鉴权方式不同，会被挡住）。
 * 2. **退款不接受金额字段**——接受的话「退 1 分钱」会把整单标成 REFUNDED。
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

import { GET as ordersGet } from '@/app/api/orders/route';
import { POST as refundPost } from '@/app/api/orders/[orderNo]/refund/route';
import { POST as shipPost } from '@/app/api/orders/[orderNo]/ship/route';

import { TEST_SESSION, getRequest, postRequest } from '../../helpers/route-harness';

const authMock = vi.mocked(auth);
const apiFetchMock = vi.mocked(apiFetch);

/** 动态路由的第二个参数（Next.js 15 里 params 是 Promise） */
const params = Promise.resolve({ orderNo: 'ORDER-1' });

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue(TEST_SESSION as never);
  apiFetchMock.mockResolvedValue({ orderNo: 'ORDER-1' } as never);
});

describe('订单中转：路径带 merchant/ 前缀', () => {
  it('订单列表打到 /merchant/orders', async () => {
    await ordersGet(getRequest('http://localhost/api/orders'));

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    const [path] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/merchant/orders');
  });

  it('发货打到 /merchant/orders/:orderNo/ship', async () => {
    await shipPost(
      postRequest('http://localhost/api/orders/ORDER-1/ship', {
        trackingNo: 'SF123',
      }),
      { params },
    );

    const [path] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/merchant/orders/ORDER-1/ship');
  });

  it('退款打到 /merchant/orders/:orderNo/refund', async () => {
    await refundPost(
      postRequest('http://localhost/api/orders/ORDER-1/refund', {}),
      { params },
    );

    const [path] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/merchant/orders/ORDER-1/refund');
  });
});

describe('订单中转：请求体白名单重建', () => {
  it('发货只发 trackingNo 与 remark', async () => {
    const response = await shipPost(
      postRequest('http://localhost/api/orders/ORDER-1/ship', {
        trackingNo: 'SF123',
        remark: '顺丰',
        // 这些都不该透传：
        status: 'SHIPPED',
        totalAmount: 1,
        tenantId: 'other-tenant',
        orderNo: 'ORDER-2',
      }),
      { params },
    );

    expect(response.status).toBe(201);
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/merchant/orders/ORDER-1/ship',
      {
        method: 'POST',
        body: { trackingNo: 'SF123', remark: '顺丰' },
        token: TEST_SESSION.accessToken,
      },
    );
  });

  it('发货的 trackingNo 缺失时 400，且不调后端', async () => {
    const response = await shipPost(
      postRequest('http://localhost/api/orders/ORDER-1/ship', {
        remark: '没有单号',
      }),
      { params },
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('发货请求体里的状态与金额不进后端', async () => {
    await shipPost(
      postRequest('http://localhost/api/orders/ORDER-1/ship', {
        trackingNo: 'SF123',
        status: 'COMPLETED',
        totalAmount: 99999,
      }),
      { params },
    );

    const [, options] = apiFetchMock.mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('status');
    expect(body).not.toHaveProperty('totalAmount');
    expect(Object.keys(body).sort()).toEqual(['trackingNo']);
  });

  it('退款只发 reason', async () => {
    const response = await refundPost(
      postRequest('http://localhost/api/orders/ORDER-1/refund', {
        reason: '买家不想要了',
        // 这些都不该透传：
        amount: 1,
        totalAmount: 99999,
        status: 'REFUNDED',
        tenantId: 'other-tenant',
      }),
      { params },
    );

    expect(response.status).toBe(200);
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/merchant/orders/ORDER-1/refund',
      {
        method: 'POST',
        body: { reason: '买家不想要了' },
        token: TEST_SESSION.accessToken,
      },
    );
  });

  it('退款不接受金额字段（否则「退 1 分钱」会把整单标成已退款）', async () => {
    await refundPost(
      postRequest('http://localhost/api/orders/ORDER-1/refund', {
        amount: 1,
        totalAmount: 99999,
      }),
      { params },
    );

    const [, options] = apiFetchMock.mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('amount');
    expect(body).not.toHaveProperty('totalAmount');
  });

  it('退款不带 reason 时 body 是空对象（不是 undefined）', async () => {
    await refundPost(
      postRequest('http://localhost/api/orders/ORDER-1/refund', {}),
      { params },
    );

    const [, options] = apiFetchMock.mock.calls[0];
    expect(options?.body).toEqual({});
  });

  it('退款的非法 JSON 请求体 → 400，且不调后端', async () => {
    const response = await refundPost(
      postRequest('http://localhost/api/orders/ORDER-1/refund', 'not-json'),
      { params },
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  // 护栏 3：数组 / 字符串 / null 请求体一律 400
  const malformed: Array<[string, unknown]> = [
    ['数组', ['a']],
    ['字符串', 'not-an-object'],
    ['null', null],
  ];

  for (const [label, payload] of malformed) {
    it(`退款收到${label}请求体 → 400，且不调后端`, async () => {
      const response = await refundPost(
        postRequest('http://localhost/api/orders/ORDER-1/refund', payload),
        { params },
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { message?: unknown };
      expect(body.message).toBe('请求体必须是 JSON 对象');
      expect(apiFetchMock).not.toHaveBeenCalled();
    });
  }

  it('发货收到数组请求体 → 400，且不调后端', async () => {
    const response = await shipPost(
      postRequest('http://localhost/api/orders/ORDER-1/ship', ['a']),
      { params },
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe('订单中转：查询参数白名单', () => {
  it('白名单内的参数被原样保留', async () => {
    await ordersGet(
      getRequest(
        'http://localhost/api/orders?status=PAID&from=2026-10-01&to=2026-10-31&page=2&pageSize=20',
      ),
    );

    const [path] = apiFetchMock.mock.calls[0];
    expect(path).toContain('status=PAID');
    expect(path).toContain('from=2026-10-01');
    expect(path).toContain('to=2026-10-31');
    expect(path).toContain('page=2');
    expect(path).toContain('pageSize=20');
  });

  it('未知 query 参数不进后端请求的 URL', async () => {
    await ordersGet(
      getRequest(
        'http://localhost/api/orders?status=PAID&customerId=someone&evil=1',
      ),
    );

    const [path] = apiFetchMock.mock.calls[0];
    expect(path).not.toContain('customerId');
    expect(path).not.toContain('evil');
    expect(path).toContain('status=PAID');
  });

  it('没有任何参数时 URL 不带问号', async () => {
    await ordersGet(getRequest('http://localhost/api/orders'));

    const [path] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/merchant/orders');
  });
});

describe('订单中转：未登录不碰后端', () => {
  it('GET /api/orders → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await ordersGet(getRequest('http://localhost/api/orders'));

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('POST 发货 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await shipPost(
      postRequest('http://localhost/api/orders/ORDER-1/ship', {
        trackingNo: 'SF123',
      }),
      { params },
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('POST 退款 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await refundPost(
      postRequest('http://localhost/api/orders/ORDER-1/refund', {}),
      { params },
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
