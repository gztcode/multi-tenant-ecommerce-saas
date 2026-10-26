/**
 * 护栏 M7 与白名单纪律：营销相关中转路由的**请求体白名单重建**。
 *
 * 为什么整体透传是危险的：
 * - 后端 ValidationPipe 开了 forbidNonWhitelisted，客户端多传一个字段
 *   就会被后端 400，而那种 400 在界面上只是一句没头没尾的校验失败。
 * - 更根本的问题是：**后端 DTO 哪天加了个字段，它就会静默变成客户端可写**。
 *
 * 所以这里断言 apiFetch 收到的**完整 body**——不是断言「某个字段不在」，
 * 而是断言「后端收到的 body 就正好是白名单里的那几个键，多一个都没有」。
 *
 * 特别锁住了两件事：
 * 1. **`scope` 不由客户端传**（护栏 M7）：平台券只能由平台超管创建，
 *    作用域是服务端按登录身份推导的。客户端传了会被后端 DTO 拒掉，
 *    但中转路由**根本不该把它传出去**。
 * 2. **计数不放行**：`claimedCount` / `reservedCount` / `usedCount`
 *    是服务端的账，客户端传了就是伪造额度。
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
  GET as couponsGet,
  POST as createCoupon,
} from '@/app/api/coupons/route';
import {
  DELETE as deleteCoupon,
  PATCH as patchCoupon,
} from '@/app/api/coupons/[id]/route';
import {
  GET as promotionsGet,
  POST as createPromotion,
} from '@/app/api/promotions/route';
import {
  DELETE as deletePromotion,
  PATCH as patchPromotion,
} from '@/app/api/promotions/[id]/route';

import { TEST_SESSION, postRequest } from '../../helpers/route-harness';

const authMock = vi.mocked(auth);
const apiFetchMock = vi.mocked(apiFetch);

/** 动态路由的第二个参数（Next.js 15 里 params 是 Promise） */
const params = Promise.resolve({ id: 'c-1' });

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue(TEST_SESSION as never);
  apiFetchMock.mockResolvedValue({ id: 'c-1' } as never);
});

describe('营销中转：商家侧的路径带 merchant/ 前缀', () => {
  it('券列表打到 /merchant/coupons', async () => {
    await couponsGet();

    const [path] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/merchant/coupons');
  });

  it('活动列表打到 /merchant/promotions', async () => {
    await promotionsGet();

    const [path] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/merchant/promotions');
  });

  it('改券打到 /merchant/coupons/:id', async () => {
    await patchCoupon(postRequest('http://localhost/api/coupons/c-1', {}), {
      params,
    });

    const [path] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/merchant/coupons/c-1');
  });

  it('删活动打到 /merchant/promotions/:id', async () => {
    await deletePromotion(
      new Request('http://localhost/api/promotions/p-1', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'p-1' }) },
    );

    const [path] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/merchant/promotions/p-1');
  });
});

describe('护栏 M7：创建券的请求体白名单重建', () => {
  it('只把 code / name / value / minAmount / startsAt / endsAt 发给后端', async () => {
    const response = await createCoupon(
      postRequest('http://localhost/api/coupons', {
        code: 'SAVE10',
        name: '满100减10',
        description: '新客专享',
        value: 1000,
        minAmount: 10000,
        perUserLimit: 1,
        totalLimit: 100,
        startsAt: '2026-01-01T00:00:00.000Z',
        endsAt: '2026-12-31T23:59:59.000Z',
      }),
    );

    expect(response.status).toBe(201);
    expect(apiFetchMock).toHaveBeenCalledWith('/merchant/coupons', {
      method: 'POST',
      body: {
        code: 'SAVE10',
        name: '满100减10',
        description: '新客专享',
        value: 1000,
        minAmount: 10000,
        perUserLimit: 1,
        totalLimit: 100,
        startsAt: '2026-01-01T00:00:00.000Z',
        endsAt: '2026-12-31T23:59:59.000Z',
      },
      token: TEST_SESSION.accessToken,
    });
  });

  it('scope / tenantId / 计数不进后端请求体', async () => {
    await createCoupon(
      postRequest('http://localhost/api/coupons', {
        code: 'SAVE10',
        name: '满100减10',
        value: 1000,
        minAmount: 10000,
        startsAt: '2026-01-01T00:00:00.000Z',
        endsAt: '2026-12-31T23:59:59.000Z',
        scope: 'PLATFORM',
        tenantId: 'other-tenant',
        claimedCount: 99999,
        reservedCount: 99999,
        usedCount: 99999,
      }),
    );

    const [, options] = apiFetchMock.mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('scope');
    expect(body).not.toHaveProperty('tenantId');
    expect(body).not.toHaveProperty('claimedCount');
    expect(body).not.toHaveProperty('reservedCount');
    expect(body).not.toHaveProperty('usedCount');
    expect(Object.keys(body).sort()).toEqual([
      'code',
      'endsAt',
      'minAmount',
      'name',
      'startsAt',
      'value',
    ]);
  });

  it('type 不进后端请求体（本阶段固定 FIXED）', async () => {
    await createCoupon(
      postRequest('http://localhost/api/coupons', {
        code: 'SAVE10',
        name: '满100减10',
        type: 'PERCENT',
        value: 1000,
        minAmount: 10000,
        startsAt: '2026-01-01T00:00:00.000Z',
        endsAt: '2026-12-31T23:59:59.000Z',
      }),
    );

    const [, options] = apiFetchMock.mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('type');
  });

  it('金额字段必须是整数分：负数 / 小数 → 400，且不调后端', async () => {
    const bad = [
      { value: -1 },
      { value: 10.5 },
      { minAmount: -1 },
      { minAmount: 10.5 },
    ];

    for (const override of bad) {
      apiFetchMock.mockClear();
      const response = await createCoupon(
        postRequest('http://localhost/api/coupons', {
          code: 'SAVE10',
          name: '满100减10',
          value: 1000,
          minAmount: 10000,
          startsAt: '2026-01-01T00:00:00.000Z',
          endsAt: '2026-12-31T23:59:59.000Z',
          ...override,
        }),
      );

      expect(response.status).toBe(400);
      expect(apiFetchMock).not.toHaveBeenCalled();
    }
  });

  it('面额为 0 → 400（0 元面额的券没有意义）', async () => {
    const response = await createCoupon(
      postRequest('http://localhost/api/coupons', {
        code: 'SAVE10',
        name: '满100减10',
        value: 0,
        minAmount: 0,
        startsAt: '2026-01-01T00:00:00.000Z',
        endsAt: '2026-12-31T23:59:59.000Z',
      }),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('畸形请求体 → 400，且不调后端', async () => {
    const malformed: Array<[string, unknown]> = [
      ['数组', ['a']],
      ['字符串', 'not-an-object'],
      ['null', null],
    ];

    for (const [, payload] of malformed) {
      apiFetchMock.mockClear();
      const response = await createCoupon(
        postRequest('http://localhost/api/coupons', payload),
      );

      expect(response.status).toBe(400);
      expect(apiFetchMock).not.toHaveBeenCalled();
    }
  });

  it('缺券码 → 400，且不调后端', async () => {
    const response = await createCoupon(
      postRequest('http://localhost/api/coupons', {
        name: '满100减10',
        value: 1000,
        minAmount: 10000,
        startsAt: '2026-01-01T00:00:00.000Z',
        endsAt: '2026-12-31T23:59:59.000Z',
      }),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe('改券：状态与字段的白名单', () => {
  it('只改状态时 body 里只有 status', async () => {
    const response = await patchCoupon(
      postRequest('http://localhost/api/coupons/c-1', { status: 'PAUSED' }),
      { params },
    );

    expect(response.status).toBe(200);
    const [, options] = apiFetchMock.mock.calls[0];
    expect(options?.body).toEqual({ status: 'PAUSED' });
  });

  it('scope 与计数不进后端请求体', async () => {
    await patchCoupon(
      postRequest('http://localhost/api/coupons/c-1', {
        status: 'ACTIVE',
        scope: 'PLATFORM',
        claimedCount: 1,
        reservedCount: 1,
        usedCount: 1,
        tenantId: 'other-tenant',
      }),
      { params },
    );

    const [, options] = apiFetchMock.mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['status']);
  });

  it('status 只允许 ACTIVE / PAUSED（EXPIRED 是系统算出来的展示态）', async () => {
    const response = await patchCoupon(
      postRequest('http://localhost/api/coupons/c-1', { status: 'EXPIRED' }),
      { params },
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe('创建满减活动：请求体白名单重建', () => {
  it('只把 name / minAmount / discountAmount / startsAt / endsAt 发给后端', async () => {
    const response = await createPromotion(
      postRequest('http://localhost/api/promotions', {
        name: '满200减30',
        description: '双十一',
        minAmount: 20000,
        discountAmount: 3000,
        startsAt: '2026-01-01T00:00:00.000Z',
        endsAt: '2026-12-31T23:59:59.000Z',
      }),
    );

    expect(response.status).toBe(201);
    expect(apiFetchMock).toHaveBeenCalledWith('/merchant/promotions', {
      method: 'POST',
      body: {
        name: '满200减30',
        description: '双十一',
        minAmount: 20000,
        discountAmount: 3000,
        startsAt: '2026-01-01T00:00:00.000Z',
        endsAt: '2026-12-31T23:59:59.000Z',
      },
      token: TEST_SESSION.accessToken,
    });
  });

  it('tenantId / status 不进创建请求体（新活动一律 ACTIVE）', async () => {
    await createPromotion(
      postRequest('http://localhost/api/promotions', {
        name: '满200减30',
        minAmount: 20000,
        discountAmount: 3000,
        startsAt: '2026-01-01T00:00:00.000Z',
        endsAt: '2026-12-31T23:59:59.000Z',
        tenantId: 'other-tenant',
        status: 'PAUSED',
      }),
    );

    const [, options] = apiFetchMock.mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('tenantId');
    expect(body).not.toHaveProperty('status');
  });

  it('减免金额为负 / 小数 → 400，且不调后端', async () => {
    for (const discountAmount of [-1, 30.5]) {
      apiFetchMock.mockClear();
      const response = await createPromotion(
        postRequest('http://localhost/api/promotions', {
          name: '满200减30',
          minAmount: 20000,
          discountAmount,
          startsAt: '2026-01-01T00:00:00.000Z',
          endsAt: '2026-12-31T23:59:59.000Z',
        }),
      );

      expect(response.status).toBe(400);
      expect(apiFetchMock).not.toHaveBeenCalled();
    }
  });

  it('改活动只允许 ACTIVE / PAUSED', async () => {
    const response = await patchPromotion(
      postRequest('http://localhost/api/promotions/p-1', { status: 'EXPIRED' }),
      { params: Promise.resolve({ id: 'p-1' }) },
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe('营销中转：删除返回 204（无内容）', () => {
  it('删券 → 204 且响应体为空', async () => {
    const response = await deleteCoupon(
      new Request('http://localhost/api/coupons/c-1', { method: 'DELETE' }),
      { params },
    );

    expect(response.status).toBe(204);
    // ⚠️ 后端删券返回 204（无内容），中转路由不能 `NextResponse.json(result)`：
    // result 是 undefined，构造 JSON 响应会抛异常——删除其实成功了，
    // 界面却只会看到一句「后端服务不可用」。
    expect(await response.text()).toBe('');
  });

  it('删活动 → 204 且响应体为空', async () => {
    const response = await deletePromotion(
      new Request('http://localhost/api/promotions/p-1', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'p-1' }) },
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
  });
});

describe('营销中转：未登录不碰后端', () => {
  it('GET 券列表 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await couponsGet();

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('POST 创建券 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await createCoupon(
      postRequest('http://localhost/api/coupons', {
        code: 'SAVE10',
        name: '满100减10',
        value: 1000,
        minAmount: 10000,
        startsAt: '2026-01-01T00:00:00.000Z',
        endsAt: '2026-12-31T23:59:59.000Z',
      }),
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('DELETE 删券 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await deleteCoupon(
      new Request('http://localhost/api/coupons/c-1', { method: 'DELETE' }),
      { params },
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
