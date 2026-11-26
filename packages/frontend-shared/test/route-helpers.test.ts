/**
 * 前端 Route Handler 的公共小工具。
 *
 * ⚠️ 这几个函数决定了「错误怎么出这个门」：
 * - 后端的 `ApiError` 要**保留**状态码与业务消息（前端才能区分 409 / 401）；
 * - 其它异常一律 502 + 固定中文，**不把内部错误原文透给浏览器**
 *   （原文里可能带 SQL、路径、上游主机名）。
 */
import { describe, expect, it } from 'vitest';

import { ApiError } from '../src/api-client';
import {
  readJson,
  toErrorResponse,
  unauthorizedResponse,
} from '../src/route-helpers';

function postRequest(body: BodyInit | null): Request {
  return new Request('http://localhost:3001/api/orders', {
    method: 'POST',
    body,
  });
}

describe('readJson', () => {
  it('解析合法的 JSON 请求体', async () => {
    await expect(readJson(postRequest('{"skuId":"sku-1","quantity":2}'))).resolves.toEqual({
      skuId: 'sku-1',
      quantity: 2,
    });
  });

  it('JSON 里的原始值照原样返回', async () => {
    await expect(readJson(postRequest('null'))).resolves.toBeNull();
    await expect(readJson(postRequest('123'))).resolves.toBe(123);
    await expect(readJson(postRequest('"text"'))).resolves.toBe('text');
  });

  it('⚠️ 非法 JSON → null（调用方必须自己能拒绝 null）', async () => {
    await expect(readJson(postRequest('{'))).resolves.toBeNull();
    await expect(readJson(postRequest('not json'))).resolves.toBeNull();
  });

  it('空请求体 → null', async () => {
    await expect(readJson(postRequest(null))).resolves.toBeNull();
    await expect(readJson(postRequest(''))).resolves.toBeNull();
  });

  it('请求体已被读过 → null（不抛「body used already」）', async () => {
    const request = postRequest('{"a":1}');
    await readJson(request);

    await expect(readJson(request)).resolves.toBeNull();
  });
});

describe('toErrorResponse', () => {
  it('ApiError 保留状态码与业务消息', async () => {
    const response = toErrorResponse(
      new ApiError(409, 'CATEGORY_HAS_CHILDREN', '该分类下还有子分类，请先处理子分类'),
    );

    expect(response.status).toBe(409);
    expect(response.headers.get('content-type')).toContain('application/json');
    await expect(response.json()).resolves.toEqual({
      message: '该分类下还有子分类，请先处理子分类',
      code: 'CATEGORY_HAS_CHILDREN',
    });
  });

  it('401 的 ApiError 原样出（本地化在 ApiError 造出来时已经做过）', async () => {
    const response = toErrorResponse(new ApiError(401, 'UNAUTHENTICATED', '未登录或登录已过期'));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      message: '未登录或登录已过期',
      code: 'UNAUTHENTICATED',
    });
  });

  it('⚠️ ApiError 的 details 不外泄', async () => {
    const response = toErrorResponse(
      new ApiError(422, 'VALIDATION', '参数不合法', { internalField: 'should-not-leak' }),
    );

    const body = await response.json();
    expect(body).toEqual({ message: '参数不合法', code: 'VALIDATION' });
    expect(JSON.stringify(body)).not.toContain('should-not-leak');
  });

  it('其它异常一律 502 + 固定中文，不带原文', async () => {
    const response = toErrorResponse(new Error('connect ECONNREFUSED 10.0.0.5:5432'));

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body).toEqual({ message: '后端服务不可用' });
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
  });

  it('非 Error 的抛出值也按 502 处理', async () => {
    for (const thrown of ['boom', null, undefined, 42, { status: 409, code: 'FAKE' }]) {
      const response = toErrorResponse(thrown);
      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toEqual({ message: '后端服务不可用' });
    }
  });
});

describe('unauthorizedResponse', () => {
  it('401 + 固定的中文文案', async () => {
    const response = unauthorizedResponse();

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ message: '未登录或登录已过期' });
  });
});
