/**
 * 审计 §九「三端 BFF 路由系统扫描」的测试钉子化——merchant-admin 写操作护栏。
 *
 * 覆盖三类护栏，每个路由至少两用例：
 * 1. **未登录 → 401 且不调后端**：只断言 401 不够——未登录时若先调后端再把
 *    后端的错误转成 401，状态码照样是 401，但 accessToken 已在后端露过面。
 *    所以同时断言 apiFetch 调用次数为 0。
 * 2. **已登录 → 打到正确后端路径 + method**。
 * 3. **带 body 的路由 → 白名单重建**：断言后端收到的**完整 body**（`toEqual`），
 *    不是断言「某个字段不在」——「不含某字段」可以通过「全都丢弃」的实现。
 *
 * 为什么整体透传是危险的：后端 ValidationPipe 开了 forbidNonWhitelisted，
 * 客户端多传一个字段就会被后端 400；更根本的是后端 DTO 哪天加了字段，
 * 整体透传就让它静默变成客户端可写。
 *
 * ⚠️ 这些路由的**生产代码已存在且合规**，本文件是纯补缺，首次运行应直接全绿。
 *
 * 本文件只补**现有测试未钉子化**的写操作路由；billing / coupon / order / payout
 * 的白名单已在 billing-whitelist / coupon-whitelist / order-whitelist /
 * payout-route 里覆盖，这里不重复。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/auth', () => ({
  auth: vi.fn(),
}));

// ⚠️ 保留实际 ApiError：products/import 与 stores/me 用 `instanceof ApiError`
// 判断错误来源，只 mock 掉 apiFetch 会破坏该分支。
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

import { PATCH as categoryPatch, DELETE as categoryDelete } from '@/app/api/categories/[id]/route';
import { POST as inventoryAdjustPost } from '@/app/api/inventory/adjustments/route';
import { POST as mediaConfirmPost } from '@/app/api/media/[id]/confirm/route';
import { POST as returnInventoryPost } from '@/app/api/orders/[orderNo]/return-inventory/route';
import { PUT as productMediaPut } from '@/app/api/products/[id]/media/route';
import { PATCH as productPatch, DELETE as productDelete } from '@/app/api/products/[id]/route';
import { PATCH as skuPatch } from '@/app/api/products/[id]/skus/[skuId]/route';
import { PUT as specsPut } from '@/app/api/products/[id]/specs/route';
import { POST as importPost } from '@/app/api/products/import/route';
import { PATCH as storePatch } from '@/app/api/stores/me/route';
// 补缺：coupons / promotions 的未登录护栏在现有文件里只测了部分方法。
import { PATCH as couponPatch } from '@/app/api/coupons/[id]/route';
import { PATCH as promotionPatch, DELETE as promotionDelete } from '@/app/api/promotions/[id]/route';

import { TEST_SESSION, postRequest } from '../../helpers/route-harness';

const authMock = vi.mocked(auth);
const apiFetchMock = vi.mocked(apiFetch);

/** 动态路由的第二个参数（Next.js 15 里 params 是 Promise） */
const categoryParams = Promise.resolve({ id: 'c-1' });
const mediaParams = Promise.resolve({ id: 'm-12345678' });
const orderParams = Promise.resolve({ orderNo: 'ORDER-1' });
const productParams = Promise.resolve({ id: 'p-1' });
// ⚠️ 商品媒体路由用 ID_PATTERN 校验商品 id（≥8 位），用短的 'p-1' 会 400。
const productMediaParams = Promise.resolve({ id: 'p-12345678' });
const skuParams = Promise.resolve({ id: 'p-1', skuId: 'sku-1' });
const specsParams = Promise.resolve({ id: 'p-1' });
const promotionParams = Promise.resolve({ id: 'promo-1' });

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue(TEST_SESSION as never);
  apiFetchMock.mockResolvedValue({ ok: true } as never);
});

/** 构造一个 DELETE 请求。 */
function deleteRequest(url: string): Request {
  return new Request(url, { method: 'DELETE' });
}

/** 构造一个 PUT 请求。 */
function putRequest(url: string, body?: unknown): Request {
  return new Request(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('分类写操作：PATCH /api/categories/[id]', () => {
  it('未登录 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await categoryPatch(
      postRequest('http://localhost/api/categories/c-1', { name: '男装' }),
      { params: categoryParams },
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('已登录 → 打到 /catalog/categories/:id 且用 PATCH', async () => {
    await categoryPatch(
      postRequest('http://localhost/api/categories/c-1', { name: '男装', sort: 1 }),
      { params: categoryParams },
    );

    const [path, options] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/catalog/categories/c-1');
    expect(options?.method).toBe('PATCH');
    expect(options?.token).toBe(TEST_SESSION.accessToken);
  });

  it('白名单重建：只发 name / sort，slug / parentId / 身份字段不进后端', async () => {
    const response = await categoryPatch(
      postRequest('http://localhost/api/categories/c-1', {
        name: '男装',
        sort: 1,
        // 这些都不该透传：
        slug: 'mens',
        parentId: 'cat-9',
        tenantId: 'other-tenant',
        id: 'client-supplied-id',
      }),
      { params: categoryParams },
    );

    expect(response.status).toBe(200);
    expect(apiFetchMock).toHaveBeenCalledWith('/catalog/categories/c-1', {
      method: 'PATCH',
      body: { name: '男装', sort: 1 },
      token: TEST_SESSION.accessToken,
    });
  });
});

describe('分类写操作：DELETE /api/categories/[id]', () => {
  it('未登录 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await categoryDelete(
      deleteRequest('http://localhost/api/categories/c-1'),
      { params: categoryParams },
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('已登录 → 打到 /catalog/categories/:id 且用 DELETE，返回 204', async () => {
    const response = await categoryDelete(
      deleteRequest('http://localhost/api/categories/c-1'),
      { params: categoryParams },
    );

    const [path, options] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/catalog/categories/c-1');
    expect(options?.method).toBe('DELETE');
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
  });
});

describe('库存调整：POST /api/inventory/adjustments', () => {
  it('未登录 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await inventoryAdjustPost(
      postRequest('http://localhost/api/inventory/adjustments', {
        type: 'ADJUST_IN',
        skuId: 'sku-1',
        quantity: 5,
      }),
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('已登录 → 打到 /inventory/adjustments 且用 POST', async () => {
    await inventoryAdjustPost(
      postRequest('http://localhost/api/inventory/adjustments', {
        type: 'CHECK',
        skuId: 'sku-1',
        quantity: 3,
      }),
    );

    const [path, options] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/inventory/adjustments');
    expect(options?.method).toBe('POST');
    expect(options?.token).toBe(TEST_SESSION.accessToken);
  });

  it('白名单重建：只发 type / skuId / quantity / reason，stock / 身份字段不进后端', async () => {
    const response = await inventoryAdjustPost(
      postRequest('http://localhost/api/inventory/adjustments', {
        type: 'ADJUST_OUT',
        skuId: 'sku-1',
        quantity: 5,
        reason: '盘点损耗',
        // 这些都不该透传（库存只能走这条口，透传 stock 是越权面）：
        stock: 999,
        tenantId: 'other-tenant',
        version: 7,
      }),
    );

    expect(response.status).toBe(201);
    expect(apiFetchMock).toHaveBeenCalledWith('/inventory/adjustments', {
      method: 'POST',
      body: {
        type: 'ADJUST_OUT',
        skuId: 'sku-1',
        quantity: 5,
        reason: '盘点损耗',
      },
      token: TEST_SESSION.accessToken,
    });
  });

  it('缺 type 时 400，且不调后端（type 是语义开关，必传）', async () => {
    const response = await inventoryAdjustPost(
      postRequest('http://localhost/api/inventory/adjustments', {
        skuId: 'sku-1',
        quantity: 5,
      }),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe('媒体确认：POST /api/media/[id]/confirm', () => {
  it('未登录 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await mediaConfirmPost(
      postRequest('http://localhost/api/media/m-12345678/confirm', {}),
      { params: mediaParams },
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('已登录 → 打到 /media/:id/confirm 且用 POST（无请求体）', async () => {
    const response = await mediaConfirmPost(
      postRequest('http://localhost/api/media/m-12345678/confirm', {}),
      { params: mediaParams },
    );

    const [path, options] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/media/m-12345678/confirm');
    expect(options?.method).toBe('POST');
    expect(options?.token).toBe(TEST_SESSION.accessToken);
    // ⚠️ 路由没有请求体：连 body 字段都不该出现在 apiFetch 的 options 里。
    expect(options).not.toHaveProperty('body');
    expect(response.status).toBe(201);
  });

  it('id 明显不是媒体 id 时 400，且不调后端', async () => {
    const response = await mediaConfirmPost(
      postRequest('http://localhost/api/media/bad/confirm', {}),
      { params: Promise.resolve({ id: 'bad' }) },
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe('退货入库：POST /api/orders/[orderNo]/return-inventory', () => {
  it('未登录 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await returnInventoryPost(
      postRequest('http://localhost/api/orders/ORDER-1/return-inventory', {
        orderId: 'order-1',
        items: [{ skuId: 'sku-1', quantity: 2 }],
      }),
      { params: orderParams },
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('已登录 → 打到 /inventory/returns 且用 POST', async () => {
    await returnInventoryPost(
      postRequest('http://localhost/api/orders/ORDER-1/return-inventory', {
        orderId: 'order-1',
        items: [{ skuId: 'sku-1', quantity: 2 }],
      }),
      { params: orderParams },
    );

    const [path, options] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/inventory/returns');
    expect(options?.method).toBe('POST');
    expect(options?.token).toBe(TEST_SESSION.accessToken);
  });

  it('白名单重建：只发 orderId / items / reason，items 元素里多余的 stock 被丢弃', async () => {
    const response = await returnInventoryPost(
      postRequest('http://localhost/api/orders/ORDER-1/return-inventory', {
        orderId: 'order-1',
        items: [
          {
            skuId: 'sku-1',
            quantity: 2,
            // 这些都不该透传（库存由后端按入库明细算）：
            stock: 999,
            id: 'client-supplied-id',
          },
        ],
        reason: '买家退货',
        // 顶层多余字段同样丢弃：
        stock: 999,
        tenantId: 'other-tenant',
      }),
      { params: orderParams },
    );

    expect(response.status).toBe(201);
    expect(apiFetchMock).toHaveBeenCalledWith('/inventory/returns', {
      method: 'POST',
      body: {
        orderId: 'order-1',
        items: [{ skuId: 'sku-1', quantity: 2 }],
        reason: '买家退货',
      },
      token: TEST_SESSION.accessToken,
    });
  });
});

describe('商品媒体：PUT /api/products/[id]/media', () => {
  it('未登录 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await productMediaPut(
      putRequest('http://localhost/api/products/p-1/media', {
        mediaIds: ['m-12345678'],
      }),
      { params: productParams },
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('已登录 → 打到 /catalog/products/:id/media 且用 PUT', async () => {
    await productMediaPut(
      putRequest('http://localhost/api/products/p-12345678/media', {
        mediaIds: ['m-12345678'],
      }),
      { params: productMediaParams },
    );

    const [path, options] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/catalog/products/p-12345678/media');
    expect(options?.method).toBe('PUT');
    expect(options?.token).toBe(TEST_SESSION.accessToken);
  });

  it('白名单重建：只发 mediaIds（去重保留顺序），sort / status / 身份字段不进后端', async () => {
    const response = await productMediaPut(
      putRequest('http://localhost/api/products/p-12345678/media', {
        mediaIds: ['m-12345678', 'm-87654321', 'm-12345678'],
        // 这些都不该透传（排序、状态由服务端维护）：
        sort: [2, 1],
        status: 'CONFIRMED',
        tenantId: 'other-tenant',
      }),
      { params: productMediaParams },
    );

    expect(response.status).toBe(200);
    expect(apiFetchMock).toHaveBeenCalledWith('/catalog/products/p-12345678/media', {
      method: 'PUT',
      // ⚠️ 重复项被去重但保留顺序：同一个媒体传两次会让后端的 sort 重排
      // 与界面上看到的封面顺序不一致。
      body: { mediaIds: ['m-12345678', 'm-87654321'] },
      token: TEST_SESSION.accessToken,
    });
  });
});

describe('商品更新：PATCH /api/products/[id]', () => {
  it('已登录 → 打到 /catalog/products/:id 且用 PATCH，白名单重建', async () => {
    const response = await productPatch(
      postRequest('http://localhost/api/products/p-1', {
        version: 1,
        name: 'T恤',
        subtitle: '纯棉',
        status: 'PUBLISHED',
        // 这些都不该透传（slug 改旧链接失效 / minPrice 派生 / 身份字段）：
        slug: 'evil-slug',
        minPrice: 100,
        tenantId: 'other-tenant',
        id: 'client-supplied-id',
      }),
      { params: productParams },
    );

    expect(response.status).toBe(200);
    expect(apiFetchMock).toHaveBeenCalledWith('/catalog/products/p-1', {
      method: 'PATCH',
      body: {
        version: 1,
        name: 'T恤',
        subtitle: '纯棉',
        status: 'PUBLISHED',
      },
      token: TEST_SESSION.accessToken,
    });
  });

  it('version 缺失时 400，且不调后端（乐观锁必传）', async () => {
    const response = await productPatch(
      postRequest('http://localhost/api/products/p-1', { name: 'T恤' }),
      { params: productParams },
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe('商品删除：DELETE /api/products/[id]', () => {
  it('已登录 → 打到 /catalog/products/:id 且用 DELETE，返回 204', async () => {
    const response = await productDelete(
      deleteRequest('http://localhost/api/products/p-1'),
      { params: productParams },
    );

    const [path, options] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/catalog/products/p-1');
    expect(options?.method).toBe('DELETE');
    expect(options?.token).toBe(TEST_SESSION.accessToken);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
  });
});

describe('SKU 更新：PATCH /api/products/[id]/skus/[skuId]', () => {
  it('未登录 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await skuPatch(
      postRequest('http://localhost/api/products/p-1/skus/sku-1', {
        price: 100,
      }),
      { params: skuParams },
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('已登录 → 打到 /catalog/products/:id/skus/:skuId 且用 PATCH', async () => {
    await skuPatch(
      postRequest('http://localhost/api/products/p-1/skus/sku-1', {
        price: 100,
      }),
      { params: skuParams },
    );

    const [path, options] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/catalog/products/p-1/skus/sku-1');
    expect(options?.method).toBe('PATCH');
    expect(options?.token).toBe(TEST_SESSION.accessToken);
  });

  it('白名单重建：只发 price / comparePrice / code / status，stock 不进后端', async () => {
    const response = await skuPatch(
      postRequest('http://localhost/api/products/p-1/skus/sku-1', {
        price: 100,
        comparePrice: 200,
        code: 'SKU-1',
        status: 'ACTIVE',
        // ⚠️ 库存只能通过库存调整接口改，透传 stock 是越权面：
        stock: 999,
        tenantId: 'other-tenant',
        version: 7,
      }),
      { params: skuParams },
    );

    expect(response.status).toBe(200);
    expect(apiFetchMock).toHaveBeenCalledWith('/catalog/products/p-1/skus/sku-1', {
      method: 'PATCH',
      body: {
        price: 100,
        comparePrice: 200,
        code: 'SKU-1',
        status: 'ACTIVE',
      },
      token: TEST_SESSION.accessToken,
    });
  });
});

describe('规格矩阵：PUT /api/products/[id]/specs', () => {
  it('未登录 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await specsPut(
      putRequest('http://localhost/api/products/p-1/specs', {
        version: 1,
        specs: [{ name: '颜色', values: ['红色'] }],
      }),
      { params: specsParams },
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('已登录 → 打到 /catalog/products/:id/specs 且用 PUT', async () => {
    await specsPut(
      putRequest('http://localhost/api/products/p-1/specs', {
        version: 1,
        specs: [{ name: '颜色', values: ['红色'] }],
      }),
      { params: specsParams },
    );

    const [path, options] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/catalog/products/p-1/specs');
    expect(options?.method).toBe('PUT');
    expect(options?.token).toBe(TEST_SESSION.accessToken);
  });

  it('白名单重建：值归一成 { value }、去重、丢弃 value.id / spec.extra、sort 缺省用下标', async () => {
    const response = await specsPut(
      putRequest('http://localhost/api/products/p-1/specs', {
        version: 1,
        specs: [
          {
            name: '颜色',
            sort: 0,
            values: [
              { value: '红色', id: 'value-owned-by-someone-else' },
              '红色',
              '蓝色',
            ],
            // 不该透传：
            extra: 'x',
          },
          {
            name: '尺码',
            // sort 缺省 → 按数组下标补 1
            values: [{ value: 'S' }, { value: 'M' }],
          },
        ],
        tenantId: 'other-tenant',
      }),
      { params: specsParams },
    );

    expect(response.status).toBe(200);
    expect(apiFetchMock).toHaveBeenCalledWith('/catalog/products/p-1/specs', {
      method: 'PUT',
      body: {
        version: 1,
        specs: [
          {
            name: '颜色',
            values: [{ value: '红色' }, { value: '蓝色' }],
            sort: 0,
          },
          {
            name: '尺码',
            values: [{ value: 'S' }, { value: 'M' }],
            sort: 1,
          },
        ],
      },
      token: TEST_SESSION.accessToken,
    });
  });
});

describe('商品导入：POST /api/products/import', () => {
  const csv = [
    '名称,slug,品类id,描述性属性JSON',
    'T恤,t-shirt,cat-1,"{""color"":""白""}"',
  ].join('\n');

  it('未登录 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await importPost(
      postRequest('http://localhost/api/products/import', { csv }),
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('已登录 → 每行打到 /catalog/products 且用 POST，白名单重建（只发 CreateProductDto 认识的字段）', async () => {
    const response = await importPost(
      postRequest('http://localhost/api/products/import', {
        csv,
        // ⚠️ 请求体整体按白名单重建：只取 csv，其余字段全部丢弃。
        status: 'PUBLISHED',
        tenantId: 'other-tenant',
      }),
    );

    expect(response.status).toBe(200);
    // 1 行数据 = 1 次后端调用
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    const [path, options] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/catalog/products');
    expect(options?.method).toBe('POST');
    expect(options?.token).toBe(TEST_SESSION.accessToken);
    // ⚠️ 新建商品一律 DRAFT：status 由服务端管，不能由客户端带。
    expect(options?.body).toEqual({
      name: 'T恤',
      slug: 't-shirt',
      categoryId: 'cat-1',
      attributes: { color: '白' },
    });
    expect(options?.body).not.toHaveProperty('status');
    expect(options?.body).not.toHaveProperty('tenantId');
  });

  it('缺 csv 字段时 400，且不调后端', async () => {
    const response = await importPost(
      postRequest('http://localhost/api/products/import', { status: 'PUBLISHED' }),
    );

    expect(response.status).toBe(400);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe('店铺设置：PATCH /api/stores/me', () => {
  it('未登录 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await storePatch(
      postRequest('http://localhost/api/stores/me', { name: '新店名' }),
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('已登录 → 打到 /stores/me 且用 PATCH', async () => {
    await storePatch(
      postRequest('http://localhost/api/stores/me', { name: '新店名' }),
    );

    const [path, options] = apiFetchMock.mock.calls[0];
    expect(path).toBe('/stores/me');
    expect(options?.method).toBe('PATCH');
    expect(options?.token).toBe(TEST_SESSION.accessToken);
  });

  it('白名单重建：只发 name / themeTokens，身份字段不进后端', async () => {
    const response = await storePatch(
      postRequest('http://localhost/api/stores/me', {
        name: '新店名',
        themeTokens: { primary: '#fff' },
        // 这些都不该透传：
        tenantId: 'other-tenant',
        id: 'store-owned-by-someone-else',
        status: 'ACTIVE',
      }),
    );

    expect(response.status).toBe(200);
    expect(apiFetchMock).toHaveBeenCalledWith('/stores/me', {
      method: 'PATCH',
      body: { name: '新店名', themeTokens: { primary: '#fff' } },
      token: TEST_SESSION.accessToken,
    });
  });
});

describe('营销写操作未登录（补缺：现有文件只测了部分方法）', () => {
  it('PATCH /api/coupons/[id] 未登录 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await couponPatch(
      postRequest('http://localhost/api/coupons/c-1', { status: 'PAUSED' }),
      { params: categoryParams },
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('PATCH /api/promotions/[id] 未登录 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await promotionPatch(
      postRequest('http://localhost/api/promotions/promo-1', { status: 'PAUSED' }),
      { params: promotionParams },
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('DELETE /api/promotions/[id] 未登录 → 401 且不调后端', async () => {
    authMock.mockResolvedValue(null as never);

    const response = await promotionDelete(
      deleteRequest('http://localhost/api/promotions/promo-1'),
      { params: promotionParams },
    );

    expect(response.status).toBe(401);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
