/**
 * 平台超管后台的计费中转路由：**请求体白名单重建**与**query 白名单**。
 *
 * 为什么整体透传是危险的：
 * - 后端 ValidationPipe 开了 forbidNonWhitelisted，客户端多传一个字段
 *   就会被后端 400，而那种 400 在界面上只是一句没头没尾的校验失败。
 * - 更根本的问题是：**后端 DTO 哪天加了个字段，它就会静默变成客户端可写**。
 *
 * 所以这里断言 apiFetch 收到的**完整 body**——不是断言「某个字段不在」，
 * 而是断言「后端收到的 body 就正好是白名单里的那几个键，多一个都没有」。
 *
 * 计费这块特别锁住了三件容易改错的事：
 * 1. **套餐是平台的数据，不带 tenantId**：放行了 tenantId 等于允许把套餐
 *    挂到某个租户名下，那不是「多传了一个字段」，那是改掉了数据模型。
 * 2. **`status` 不放行**：上下架走专门的 DELETE（下架），不靠客户端传
 *    `status` 改 —— 否则「编辑套餐」这个动作就能顺手把套餐下架了。
 * 3. **报表的 query 也白名单**：只放行 `from` / `to`，
 *    其余参数（比如 `tenantId`）**不转发**。
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

import { GET as plansGet, POST as createPlanPost } from '@/app/api/billing/plans/route';
import {
  DELETE as disablePlanDelete,
  PATCH as updatePlanPatch,
} from '@/app/api/billing/plans/[id]/route';
import { GET as subscriptionsGet } from '@/app/api/billing/subscriptions/route';
import { GET as reportsGet } from '@/app/api/billing/reports/route';

import { TEST_SESSION, getRequest, postRequest } from '../../helpers/route-harness';

const authMock = vi.mocked(auth);
const apiFetchMock = vi.mocked(apiFetch);

/** 动态路由的第二个参数（Next.js 15 里 params 是 Promise） */
const planParams = Promise.resolve({ id: 'plan-1' });

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue(TEST_SESSION as never);
  apiFetchMock.mockResolvedValue({ id: 'x' } as never);
});

describe('计费中转：各 GET 路由打到正确的后端路径', () => {
  it('套餐列表打到 /platform/plans', async () => {
    await plansGet();

    const [path] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/platform/plans');
  });

  it('订阅列表打到 /platform/subscriptions', async () => {
    await subscriptionsGet();

    const [path] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/platform/subscriptions');
  });

  it('报表打到 /platform/reports（不带 query 时路径里不能有多余的 ?）', async () => {
    await reportsGet(getRequest('http://localhost/api/billing/reports'));

    const [path] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/platform/reports');
  });
});

describe('计费中转：写操作的路径', () => {
  it('创建套餐打到 /platform/plans 并用 POST', async () => {
    await createPlanPost(
      postRequest('http://localhost/api/billing/plans', {
        code: 'PRO',
        name: '专业版',
        price: 9900,
        periodDays: 30,
        commissionBps: 500,
      }),
    );

    const [path, options] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/platform/plans');
    expect(options?.method).toBe('POST');
  });

  it('改套餐打到 /platform/plans/:id 并用 PATCH', async () => {
    await updatePlanPatch(
      postRequest('http://localhost/api/billing/plans/plan-1', { price: 19900 }),
      { params: planParams },
    );

    const [path, options] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/platform/plans/plan-1');
    expect(options?.method).toBe('PATCH');
  });

  it('下架套餐打到 /platform/plans/:id 并用 DELETE', async () => {
    await disablePlanDelete(
      new Request('http://localhost/api/billing/plans/plan-1', {
        method: 'DELETE',
      }),
      { params: planParams },
    );

    const [path, options] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/platform/plans/plan-1');
    expect(options?.method).toBe('DELETE');
  });
});

describe('计费中转：下架套餐返回 204', () => {
  it('⚠️ 响应体为空（不能 NextResponse.json(undefined)）', async () => {
    const response = await disablePlanDelete(
      new Request('http://localhost/api/billing/plans/plan-1', {
        method: 'DELETE',
      }),
      { params: planParams },
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
  });
});

describe('计费中转：创建套餐的请求体白名单', () => {
  it('只发白名单里的那几个字段', async () => {
    const response = await createPlanPost(
      postRequest('http://localhost/api/billing/plans', {
        code: 'PRO',
        name: '专业版',
        description: '面向成长中的商家',
        price: 9900,
        periodDays: 30,
        trialDays: 14,
        commissionBps: 500,
        maxProducts: 100,
        maxSkus: 500,
        maxStores: 1,
        features: { marketing: true },
      }),
    );

    expect(response.status).toBe(201);
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/platform/plans',
      {
        method: 'POST',
        body: {
          code: 'PRO',
          name: '专业版',
          description: '面向成长中的商家',
          price: 9900,
          periodDays: 30,
          trialDays: 14,
          commissionBps: 500,
          maxProducts: 100,
          maxSkus: 500,
          maxStores: 1,
          features: { marketing: true },
        },
        token: TEST_SESSION.accessToken,
      },
    );
  });

  it('⚠️ 身份字段与服务端字段都不进请求体', async () => {
    await createPlanPost(
      postRequest('http://localhost/api/billing/plans', {
        code: 'PRO',
        name: '专业版',
        price: 9900,
        periodDays: 30,
        commissionBps: 500,
        // 以下这些都该被丢弃：
        tenantId: 'other-tenant',
        id: 'plan-owned-by-someone-else',
        status: 'DISABLED',
        sortOrder: 99,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        // 以及一个后端 DTO 里根本没有的字段：
        secretFlag: true,
      }),
    );

    const [, options] = apiFetchMock.mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'code',
      'commissionBps',
      'name',
      'periodDays',
      'price',
    ]);
  });

  it('code 与 name 会被 trim', async () => {
    await createPlanPost(
      postRequest('http://localhost/api/billing/plans', {
        code: '  PRO  ',
        name: '  专业版  ',
        price: 9900,
        periodDays: 30,
        commissionBps: 500,
      }),
    );

    const [, options] = apiFetchMock.mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    expect(body.code).toBe('PRO');
    expect(body.name).toBe('专业版');
  });
});

describe('计费中转：创建套餐的非法值 → 400 且不调后端', () => {
  const invalid: Array<[string, Record<string, unknown>]> = [
    ['price 为负数', { price: -1 }],
    ['price 是小数', { price: 99.5 }],
    ['price 是字符串', { price: '9900' }],
    ['commissionBps 超过 10000', { commissionBps: 10001 }],
    ['commissionBps 是小数', { commissionBps: 5.5 }],
    ['periodDays 为 0', { periodDays: 0 }],
    ['periodDays 为 400', { periodDays: 400 }],
    ['maxStores 为 0', { maxStores: 0 }],
    ['features 的值不是布尔', { features: { marketing: 'yes' } }],
    ['features 是数组', { features: ['marketing'] }],
    ['features 是 null', { features: null }],
    ['description 不是字符串', { description: 123 }],
    ['code 是空串', { code: '   ' }],
    ['name 是空串', { name: '   ' }],
  ];

  for (const [label, override] of invalid) {
    it(`${label} → 400，且不调后端`, async () => {
      const response = await createPlanPost(
        postRequest('http://localhost/api/billing/plans', {
          code: 'PRO',
          name: '专业版',
          price: 9900,
          periodDays: 30,
          commissionBps: 500,
          ...override,
        }),
      );

      expect(response.status).toBe(400);
      expect(apiFetchMock).not.toHaveBeenCalled();
    });
  }

  it('features 缺省时不进请求体', async () => {
    await createPlanPost(
      postRequest('http://localhost/api/billing/plans', {
        code: 'PRO',
        name: '专业版',
        price: 9900,
        periodDays: 30,
        commissionBps: 500,
      }),
    );

    const [, options] = apiFetchMock.mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('features');
  });
});

describe('计费中转：description 允许 null（清空套餐说明）', () => {
  it('description 为 null → 放行，且 body 里带着 description: null', async () => {
    const response = await createPlanPost(
      postRequest('http://localhost/api/billing/plans', {
        code: 'PRO',
        name: '专业版',
        description: null,
        price: 9900,
        periodDays: 30,
        commissionBps: 500,
      }),
    );

    expect(response.status).toBe(201);
    const [, options] = apiFetchMock.mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    expect(body.description).toBeNull();
  });

  it('⚠️ PATCH 传 description: null → 放行（改套餐时能清空说明）', async () => {
    const response = await updatePlanPatch(
      postRequest('http://localhost/api/billing/plans/plan-1', {
        description: null,
      }),
      { params: planParams },
    );

    expect(response.status).toBe(200);
    const [, options] = apiFetchMock.mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    expect(body.description).toBeNull();
  });

  it('description 是数字 → 400 且不调后端', async () => {
    const response = await createPlanPost(
      postRequest('http://localhost/api/billing/plans', {
        code: 'PRO',
        name: '专业版',
        description: 123,
        price: 9900,
        periodDays: 30,
        commissionBps: 500,
      }),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe('计费中转：超长的字段 → 400 且不调后端（对齐后端 DTO 的 MaxLength）', () => {
  it('code 超过 64 个字符 → 400 且不调后端', async () => {
    const response = await createPlanPost(
      postRequest('http://localhost/api/billing/plans', {
        code: 'C'.repeat(65),
        name: '专业版',
        price: 9900,
        periodDays: 30,
        commissionBps: 500,
      }),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('name 超过 100 个字符 → 400 且不调后端', async () => {
    const response = await createPlanPost(
      postRequest('http://localhost/api/billing/plans', {
        code: 'PRO',
        name: '名'.repeat(101),
        price: 9900,
        periodDays: 30,
        commissionBps: 500,
      }),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('description 超过 500 个字符 → 400 且不调后端', async () => {
    const response = await createPlanPost(
      postRequest('http://localhost/api/billing/plans', {
        code: 'PRO',
        name: '专业版',
        description: '说'.repeat(501),
        price: 9900,
        periodDays: 30,
        commissionBps: 500,
      }),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('刚好在上限上（code 64 个字符）→ 放行', async () => {
    const response = await createPlanPost(
      postRequest('http://localhost/api/billing/plans', {
        code: 'C'.repeat(64),
        name: '专业版',
        price: 9900,
        periodDays: 30,
        commissionBps: 500,
      }),
    );

    expect(response.status).toBe(201);
  });
});

describe('计费中转：创建套餐的必填项缺失 → 400 且不调后端', () => {
  const required = ['code', 'name', 'price', 'periodDays', 'commissionBps'];

  for (const key of required) {
    it(`缺 ${key} → 400，且不调后端`, async () => {
      const payload: Record<string, unknown> = {
        code: 'PRO',
        name: '专业版',
        price: 9900,
        periodDays: 30,
        commissionBps: 500,
      };
      delete payload[key];

      const response = await createPlanPost(
        postRequest('http://localhost/api/billing/plans', payload),
      );

      expect(response.status).toBe(400);
      expect(apiFetchMock).not.toHaveBeenCalled();
    });
  }
});

describe('计费中转：畸形请求体 → 400 且不调后端', () => {
  const malformed: Array<[string, unknown]> = [
    ['数组', ['a']],
    ['字符串', 'not-an-object'],
    ['null', null],
  ];

  for (const [label, payload] of malformed) {
    it(`创建套餐收到${label}请求体 → 400，且不调后端`, async () => {
      const response = await createPlanPost(
        postRequest('http://localhost/api/billing/plans', payload),
      );

      expect(response.status).toBe(400);
      expect(apiFetchMock).not.toHaveBeenCalled();
    });
  }

  it('创建套餐收到非法 JSON → 400，且不调后端', async () => {
    const response = await createPlanPost(
      postRequest('http://localhost/api/billing/plans', 'not-json'),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe('计费中转：修改套餐的请求体白名单', () => {
  it('只改一个字段时，body 里只有那个字段', async () => {
    const response = await updatePlanPatch(
      postRequest('http://localhost/api/billing/plans/plan-1', {
        price: 19900,
      }),
      { params: planParams },
    );

    expect(response.status).toBe(200);
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/platform/plans/plan-1',
      {
        method: 'PATCH',
        body: { price: 19900 },
        token: TEST_SESSION.accessToken,
      },
    );
  });

  it('⚠️ tenantId 与 status 不进请求体', async () => {
    await updatePlanPatch(
      postRequest('http://localhost/api/billing/plans/plan-1', {
        price: 19900,
        tenantId: 'other-tenant',
        status: 'DISABLED',
        sortOrder: 99,
        id: 'plan-owned-by-someone-else',
      }),
      { params: planParams },
    );

    const [, options] = apiFetchMock.mock.calls[0];
    const body = options?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['price']);
  });

  it('缺字段不是错误（PATCH 是部分更新）', async () => {
    const response = await updatePlanPatch(
      postRequest('http://localhost/api/billing/plans/plan-1', {}),
      { params: planParams },
    );

    expect(response.status).toBe(200);
    const [, options] = apiFetchMock.mock.calls[0];
    expect(options?.body).toEqual({});
  });

  it('非法值同样 400 且不调后端', async () => {
    const response = await updatePlanPatch(
      postRequest('http://localhost/api/billing/plans/plan-1', {
        price: -1,
      }),
      { params: planParams },
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('畸形请求体 → 400，且不调后端', async () => {
    const response = await updatePlanPatch(
      postRequest('http://localhost/api/billing/plans/plan-1', ['a']),
      { params: planParams },
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe('计费中转：报表的 query 白名单', () => {
  it('给了 from / to → 转发到后端路径的 query 里', async () => {
    await reportsGet(
      getRequest(
        'http://localhost/api/billing/reports?from=2026-01-01T00:00:00.000Z&to=2026-02-01T00:00:00.000Z',
      ),
    );

    const [path] = apiFetchMock.mock.calls[0];
    expect(path).toBe(
      '/platform/reports?from=2026-01-01T00%3A00%3A00.000Z&to=2026-02-01T00%3A00%3A00.000Z',
    );
  });

  it('⚠️ 其它 query 参数不转发', async () => {
    await reportsGet(
      getRequest(
        'http://localhost/api/billing/reports?from=2026-01-01T00:00:00.000Z&tenantId=tenant-1&secretFlag=1',
      ),
    );

    const [path] = apiFetchMock.mock.calls[0];
    expect(path).not.toContain('tenantId');
    expect(path).not.toContain('secretFlag');
    expect(path).toBe('/platform/reports?from=2026-01-01T00%3A00%3A00.000Z');
  });

  it('from 格式非法 → 400 且不调后端', async () => {
    const response = await reportsGet(
      getRequest('http://localhost/api/billing/reports?from=not-a-date'),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('to 格式非法 → 400 且不调后端', async () => {
    const response = await reportsGet(
      getRequest('http://localhost/api/billing/reports?to=not-a-date'),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('⚠️ from 不带时区 → 400 且不调后端', async () => {
    // `2026-01-01` 是 `<input type="date">` 的输出，它不带时区。
    // 它被 `new Date()` 解析成 UTC 零点，而 `2026-01-01T00:00:00` 是本地零点，
    // 两者差一个时区偏移 —— 混着用会让「同一天」有时差 8 小时。
    // 必须在**转发给后端之前**就拒掉（后端 `@IsDateString()` 同样只认 ISO）。
    const response = await reportsGet(
      getRequest('http://localhost/api/billing/reports?from=2026-01-01'),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('⚠️ to 不带时区 → 400 且不调后端', async () => {
    const response = await reportsGet(
      getRequest('http://localhost/api/billing/reports?to=2026-01-31'),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('from 带 Z → 放行并转发到后端路径的 query 里', async () => {
    await reportsGet(
      getRequest(
        'http://localhost/api/billing/reports?from=2026-01-01T00:00:00.000Z&to=2026-02-01T00:00:00.000Z',
      ),
    );

    const [path] = apiFetchMock.mock.calls[0];
    expect(path).toBe(
      '/platform/reports?from=2026-01-01T00%3A00%3A00.000Z&to=2026-02-01T00%3A00%3A00.000Z',
    );
  });

  it('from 带时区偏移 → 放行', async () => {
    await reportsGet(
      getRequest(
        'http://localhost/api/billing/reports?from=2026-01-01T00:00:00%2B08:00&to=2026-02-01T00:00:00%2B08:00',
      ),
    );

    const [path] = apiFetchMock.mock.calls[0];
    expect(path).toContain('from=2026-01-01T00%3A00%3A00%2B08%3A00');
  });

  it('⚠️ 少零的日期（2026-1-1）→ 400 且不调后端', async () => {
    const response = await reportsGet(
      getRequest('http://localhost/api/billing/reports?from=2026-1-1'),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('⚠️ 斜杠分隔的日期（2026/01/01）→ 400 且不调后端', async () => {
    const response = await reportsGet(
      getRequest('http://localhost/api/billing/reports?from=2026/01/01'),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('⚠️ 不带时区的时间（2026-01-01T00:00:00）→ 400 且不调后端', async () => {
    const response = await reportsGet(
      getRequest('http://localhost/api/billing/reports?from=2026-01-01T00:00:00'),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('from >= to → 400 且不调后端', async () => {
    const response = await reportsGet(
      getRequest(
        'http://localhost/api/billing/reports?from=2026-02-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z',
      ),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('from == to → 400 且不调后端（区间是左闭右开，相等即空区间）', async () => {
    const response = await reportsGet(
      getRequest(
        'http://localhost/api/billing/reports?from=2026-01-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z',
      ),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('没给 from / to → 路径里不带 query', async () => {
    await reportsGet(getRequest('http://localhost/api/billing/reports'));

    const [path] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/platform/reports');
  });
});

describe('计费中转：未登录不碰后端', () => {
  it('GET 套餐列表 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await plansGet();

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('GET 订阅列表 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await subscriptionsGet();

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('GET 报表 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await reportsGet(getRequest('http://localhost/api/billing/reports'));

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('POST 创建套餐 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await createPlanPost(
      postRequest('http://localhost/api/billing/plans', {
        code: 'PRO',
        name: '专业版',
        price: 9900,
        periodDays: 30,
        commissionBps: 500,
      }),
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('PATCH 修改套餐 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await updatePlanPatch(
      postRequest('http://localhost/api/billing/plans/plan-1', { price: 19900 }),
      { params: planParams },
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('DELETE 下架套餐 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await disablePlanDelete(
      new Request('http://localhost/api/billing/plans/plan-1', {
        method: 'DELETE',
      }),
      { params: planParams },
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
