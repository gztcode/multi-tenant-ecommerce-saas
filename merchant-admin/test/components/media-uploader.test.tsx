// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MediaUploader } from '@/components/product/media-uploader';

/** 造一个满足组件 Response 用法的最小响应对象 */
function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status });
}

/**
 * 可编程的 XMLHttpRequest 假实现：send 时由静态 onSend 决定何时触发 onload，
 * 从而精确控制「直传完成」的时刻（组件用 XHR 而非 fetch，见 media-uploader.tsx 注释）。
 */
class MockXHR {
  static instances: MockXHR[] = [];
  static onSend: ((xhr: MockXHR, body: unknown) => void) | null = null;

  status = 0;
  url = '';
  method = '';
  headers: Record<string, string> = {};
  body: unknown = null;
  upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;

  constructor() {
    MockXHR.instances.push(this);
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }

  send(body: unknown) {
    this.body = body;
    MockXHR.onSend?.(this, body);
  }
}

/** 按文件名区分媒体 id 的 fetch 假实现，覆盖签发 / confirm / 写回三个端点 */
function makeFetchMock() {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/media/upload-url') {
      const body = JSON.parse(String(init?.body)) as { filename: string };
      const id = body.filename === 'b.png' ? 'media-b' : 'media-a';
      return Promise.resolve(
        jsonResponse({
          uploadUrl: `https://minio.local/${id}`,
          media: { id, url: `https://cdn.local/${id}` },
        }),
      );
    }
    const confirmMatch = url.match(/^\/api\/media\/([^/]+)\/confirm$/);
    if (confirmMatch) {
      return Promise.resolve(jsonResponse({ url: `https://cdn.local/${confirmMatch[1]}` }));
    }
    if (url === '/api/products/p-1/media') {
      return Promise.resolve(jsonResponse({ ok: true }));
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  });
}

function png(name: string) {
  return new File(['fake-image'], name, { type: 'image/png' });
}

beforeEach(() => {
  vi.clearAllMocks();
  MockXHR.instances = [];
  MockXHR.onSend = null;
});

afterEach(() => vi.unstubAllGlobals());

describe('商品图片上传器（media-uploader）', () => {
  it('三步上传成功：签发凭证 body 精确 → XHR PUT → confirm → 写回商品媒体', async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    MockXHR.onSend = (xhr) => {
      setTimeout(() => {
        xhr.status = 200;
        xhr.onload?.();
      }, 0);
    };
    vi.stubGlobal('XMLHttpRequest', MockXHR);

    render(<MediaUploader productId="p-1" initial={[]} />);

    const file = png('a.png');
    await userEvent.upload(screen.getByLabelText('选择图片'), file);

    // 等整条链路走完（缩略图渲染出来）
    await waitFor(() => expect(screen.getByAltText('商品图 1')).toBeTruthy());

    // 第 1 步：签发凭证，body 精确断言
    const firstCall = fetchMock.mock.calls[0];
    expect(String(firstCall[0])).toBe('/api/media/upload-url');
    expect(firstCall[1]?.method).toBe('POST');
    expect(firstCall[1]?.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(String(firstCall[1]?.body))).toEqual({
      filename: 'a.png',
      mime: 'image/png',
      size: file.size,
    });

    // 第 2 步：XHR 直传到 MinIO，断言目标 uploadUrl、method 与 body
    const xhr = MockXHR.instances[0];
    expect(xhr.method).toBe('PUT');
    expect(xhr.url).toBe('https://minio.local/media-a');
    expect(xhr.headers['content-type']).toBe('image/png');
    expect(xhr.body).toBe(file);

    // 第 3 步：confirm 校验
    const confirmCall = fetchMock.mock.calls.find(
      (c) => String(c[0]) === '/api/media/media-a/confirm',
    );
    expect(confirmCall).toBeTruthy();
    expect(confirmCall?.[1]?.method).toBe('POST');

    // 最后：把有序媒体列表写回商品
    const saveCall = fetchMock.mock.calls.find((c) => String(c[0]) === '/api/products/p-1/media');
    expect(saveCall).toBeTruthy();
    expect(saveCall?.[1]?.method).toBe('PUT');
    expect(JSON.parse(String(saveCall?.[1]?.body))).toEqual({ mediaIds: ['media-a'] });

    // 缩略图用 confirm 返回的 url
    expect(screen.getByAltText('商品图 1')).toHaveAttribute('src', 'https://cdn.local/media-a');
  });

  it('并发上传两个文件：后完成的用 ref 合并，不顶掉先完成的', async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    // a 先完成、b 后完成：若 items 用闭包捕获而非 ref，b 完成时会拿到
    // startUpload 时的旧数组，把 a 顶掉（只剩一张）。
    MockXHR.onSend = (xhr, body) => {
      const file = body as File;
      const delay = file.name === 'a.png' ? 0 : 50;
      setTimeout(() => {
        xhr.status = 200;
        xhr.onload?.();
      }, delay);
    };
    vi.stubGlobal('XMLHttpRequest', MockXHR);

    render(<MediaUploader productId="p-1" initial={[]} />);

    await userEvent.upload(screen.getByLabelText('选择图片'), [png('a.png'), png('b.png')]);

    // 两张图都保留
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(2));

    // 最后一次写回必须是合并后的有序列表：a 先完成、b 后完成 → [a, b]
    const saveCalls = fetchMock.mock.calls.filter(
      (c) => String(c[0]) === '/api/products/p-1/media',
    );
    expect(saveCalls.length).toBeGreaterThanOrEqual(2);
    const lastSave = saveCalls[saveCalls.length - 1];
    expect(JSON.parse(String(lastSave[1]?.body))).toEqual({ mediaIds: ['media-a', 'media-b'] });
  });

  it('直传 HTTP 失败：显示错误文案与重试按钮', async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    MockXHR.onSend = (xhr) => {
      xhr.status = 500;
      xhr.onload?.();
    };
    vi.stubGlobal('XMLHttpRequest', MockXHR);

    render(<MediaUploader productId="p-1" initial={[]} />);
    await userEvent.upload(screen.getByLabelText('选择图片'), png('a.png'));

    await waitFor(() =>
      expect(screen.getByText('上传失败（HTTP 500），请重试')).toBeTruthy(),
    );
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    // 失败后没有可展示的缩略图
    expect(screen.queryByAltText('商品图 1')).toBeNull();
  });

  it('签发凭证失败：显示服务端返回的错误文案，且不发直传请求', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input) === '/api/media/upload-url') {
        return Promise.resolve(jsonResponse({ message: '文件大小超过 5MB 上限' }, 400));
      }
      return Promise.reject(new Error(`unexpected fetch: ${String(input)}`));
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('XMLHttpRequest', MockXHR);

    render(<MediaUploader productId="p-1" initial={[]} />);
    await userEvent.upload(screen.getByLabelText('选择图片'), png('a.png'));

    await waitFor(() => expect(screen.getByText('文件大小超过 5MB 上限')).toBeTruthy());
    expect(MockXHR.instances).toHaveLength(0);
  });

  it('本地预检：不支持的 MIME 不发任何请求，直接提示', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('XMLHttpRequest', MockXHR);

    render(<MediaUploader productId="p-1" initial={[]} />);
    // userEvent.upload 会按 input 的 accept 过滤掉 text/plain，onChange 不触发；
    // 本地预检分支要测，只能直接 fireEvent.change 注入文件。
    const txt = new File(['x'], 'a.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText('选择图片'), { target: { files: [txt] } });

    await waitFor(() =>
      expect(
        screen.getByText('「a.txt」的类型是 text/plain，只支持 image/jpeg、image/png、image/webp、image/gif'),
      ).toBeTruthy(),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(MockXHR.instances).toHaveLength(0);
  });
});
