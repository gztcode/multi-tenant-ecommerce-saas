'use client';

import { useRef, useState } from 'react';
import type { ResolvedMediaItem } from '@/components/product/types';

/**
 * 商品图片上传与排序。
 *
 * 流程是「后端签发凭证 → 浏览器直传 MinIO → 回调确认」：
 * 1. POST /api/media/upload-url 拿到 presigned PUT URL 与 mediaId；
 * 2. 用 XMLHttpRequest 把文件 PUT 到 MinIO；
 * 3. POST /api/media/:id/confirm 让后端 HEAD 对象确认存在与大小；
 * 4. PUT /api/products/:id/media 把媒体 id 的**有序**列表写回商品。
 *
 * ⚠️ 直传用 XMLHttpRequest 而不是 fetch：fetch 没有上传进度事件，
 * 商家看不到上传到哪儿了。失败可以重试——同一个 presigned URL
 * 在有效期内可以重复 PUT 同一个 key。
 *
 * ⚠️ 这个组件整个是 'use client'，逻辑全在内部。商品编辑页是
 * Server Component，**不能**往下传函数（传事件处理器在 tsc 与 next build
 * 下都能过，只有真正渲染这一页时才 500），所以父组件只传数据。
 */

/** 与后端 ALLOWED_MIME_TYPES 一致（见 api/src/modules/media/dto/upload-url.dto.ts） */
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;

/** 与后端 MEDIA_MAX_SIZE 默认值一致 */
const MAX_SIZE_BYTES = 5 * 1024 * 1024;

const ACCEPT = ALLOWED_MIME_TYPES.join(',');

/** Media 的 id 与 url。id 写回后端，url 用来渲染缩略图。 */
type MediaItem = ResolvedMediaItem;

/** 一张图在这次会话里的状态。PENDING 还没传完，READY 已确认。 */
interface UploadSlot {
  /** 临时 key：签发凭证之后、confirm 之前用一个本地 id 占位 */
  key: string;
  item: MediaItem | null;
  filename: string;
  /** 0-100；null 表示不在上传 */
  progress: number | null;
  error: string | null;
  /** 用来让同一张图可以重试 */
  retry: (() => void) | null;
}

export function MediaUploader({
  productId,
  initial,
}: {
  productId: string;
  /** 已保存的图片，按封面顺序（第一个是封面），url 已由编辑页解析好 */
  initial: ResolvedMediaItem[];
}) {
  // 已保存的媒体。父组件已经按 sort 排好序，这里不再排——
  // 排一次就多一处「顺序以谁为准」需要解释，而顺序本来就只有一个来源。
  const [items, setItems] = useState<MediaItem[]>(initial);
  /** 同步镜像（见下面的说明）。初值与 state 相同，之后两者一起写。 */
  const itemsRef = useRef<MediaItem[]>(items);
  const [slots, setSlots] = useState<UploadSlot[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const nextSlotId = useRef(0);

  /**
   * items 的同步镜像。
   *
   * 为什么要 ref 而不只是 state：上传是异步的，一次选多张图会并发跑几个
   * uploadOne，而 setState 是异步的——await 之后直接读 `items` 拿到的还是
   * 旧数组，两张图就会互相覆盖。ref 是同步读的，写 state 的同时写 ref，
   * 下一个上传协程就能看到最新的顺序。
   * 单一真相源仍然是 state（渲染读它），ref 只为并发读而存在。
   */

  /**
   * 拉一个上传凭证。
   *
   * 单独拎出来是因为重试只需要重新走这一步——presigned URL 本身可以
   * 重复 PUT 同一个 key，但签一个新的更简单，也避开了「上一次凭证过期」
   * 这种边界情况。
   */
  async function requestSlot(file: File) {
    const response = await fetch('/api/media/upload-url', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: file.name, mime: file.type, size: file.size }),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      message?: string;
      uploadUrl?: string;
      media?: { id: string; url?: string };
    };
    if (!response.ok || typeof payload.uploadUrl !== 'string' || !payload.media?.id) {
      throw new Error(payload.message ?? '获取上传凭证失败');
    }
    return { uploadUrl: payload.uploadUrl, mediaId: payload.media.id, mediaUrl: payload.media.url };
  }

  /** 把一个 slot 的进度 / 错误写回 state（按 slotKey 匹配，不动别的） */
  function patchSlot(slotKey: string, patch: Partial<UploadSlot>) {
    setSlots((current) =>
      current.map((slot) => (slot.key === slotKey ? { ...slot, ...patch } : slot)),
    );
  }

  /**
   * 直传一个文件到 MinIO 并确认。
   *
   * 抛出的 Error 的 message 直接给商家看，所以措辞要说清楚是哪一步坏了。
   */
  async function uploadOne(file: File, slotKey: string): Promise<MediaItem> {
    patchSlot(slotKey, { progress: 0, error: null });

    const { uploadUrl, mediaId, mediaUrl } = await requestSlot(file);

    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', uploadUrl);
      // ⚠️ content-type 必须与签发凭证时声明的 mime 一致：
      // MinIO 的 presigned 签名把 Content-Type 算进了签名，
      // 传别的值会得到 403 SignatureDoesNotMatch。
      xhr.setRequestHeader('content-type', file.type);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          const percent = Math.round((event.loaded / event.total) * 100);
          patchSlot(slotKey, { progress: percent });
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          reject(new Error(`上传失败（HTTP ${xhr.status}），请重试`));
        }
      };
      xhr.onerror = () => reject(new Error('上传失败：网络错误，请检查连接后重试'));
      xhr.ontimeout = () => reject(new Error('上传超时，请重试'));
      xhr.send(file);
    });

    const confirmed = await fetch(`/api/media/${mediaId}/confirm`, {
      method: 'POST',
    });
    const confirmedPayload = (await confirmed.json().catch(() => ({}))) as {
      message?: string;
      url?: string;
    };
    if (!confirmed.ok) {
      throw new Error(confirmedPayload.message ?? '确认上传失败，请重试');
    }

    // confirm 返回的是 Media 对象，url 是可访问地址；拿不到就退回
    // 签发时返回的那个（两者在正常情况下是同一个）。
    return {
      id: mediaId,
      url: confirmedPayload.url ?? mediaUrl ?? '',
    };
  }

  /** 启动一个文件的上传；把结果并入 items 并保存 */
  function startUpload(file: File) {
    // 本地预检：不合法就不发请求，省一次往返也给得出更具体的提示。
    if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)) {
      setMessage(
        `「${file.name}」的类型是 ${file.type || '未知'}，只支持 ${ALLOWED_MIME_TYPES.join('、')}`,
      );
      return;
    }
    if (file.size > MAX_SIZE_BYTES) {
      setMessage(
        `「${file.name}」有 ${(file.size / 1024 / 1024).toFixed(1)}MB，超过 ${MAX_SIZE_BYTES / 1024 / 1024}MB 上限`,
      );
      return;
    }

    nextSlotId.current += 1;
    const slotKey = `slot-${nextSlotId.current}`;

    setMessage(null);
    const slot: UploadSlot = {
      key: slotKey,
      item: null,
      filename: file.name,
      progress: 0,
      error: null,
      retry: null,
    };
    setSlots((current) => [...current, slot]);

    const run = () => {
      void (async () => {
        try {
          const uploaded = await uploadOne(file, slotKey);
          setSlots((current) => current.filter((s) => s.key !== slotKey));
          // ⚠️ items 用 ref 而不是直接闭包捕获：一次选多个文件时，
          // 第二个 uploadOne 完成的时刻第一个可能还没 setItems，
          // 闭包里的 items 会是同一个旧数组，后传的那张就把先传的顶掉。
          const next = [...itemsRef.current, uploaded];
          itemsRef.current = next;
          setItems(next);
          await save(next);
        } catch (cause) {
          const text = cause instanceof Error ? cause.message : '上传失败';
          patchSlot(slotKey, { error: text, progress: null, retry: run });
        }
      })();
    };

    run();
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      startUpload(file);
    }
    // 重置 input，否则连续选同一个文件两次不会触发 onChange。
    if (inputRef.current) inputRef.current.value = '';
  }

  /** 把媒体顺序写回后端（数组顺序即封面顺序，第一个是封面） */
  async function save(next: MediaItem[]) {
    setSaving(true);
    try {
      const response = await fetch(`/api/products/${productId}/media`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mediaIds: next.map((item) => item.id) }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(payload.message ?? '保存媒体列表失败');
      }
      // 保存成功。不 router.refresh()：本地 items 已经是保存后的顺序，
      // 刷新反而会让服务端返回的数据覆盖掉正在进行的下一次操作。
    } finally {
      setSaving(false);
    }
  }

  async function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const next = [...itemsRef.current];
    [next[index], next[target]] = [next[target], next[index]];
    itemsRef.current = next;
    setItems(next);
    try {
      await save(next);
    } catch (cause) {
      // 保存失败就把顺序滚回去——界面上显示的顺序必须与库里一致。
      itemsRef.current = items;
      setItems(items);
      setMessage(cause instanceof Error ? cause.message : '排序失败');
    }
  }

  async function remove(index: number) {
    const previous = itemsRef.current;
    const next = previous.filter((_, i) => i !== index);
    itemsRef.current = next;
    setItems(next);
    try {
      await save(next);
    } catch (cause) {
      itemsRef.current = previous;
      setItems(previous);
      setMessage(cause instanceof Error ? cause.message : '移除失败');
    }
  }

  return (
    <section className="flex flex-col gap-4 rounded-md border p-4">
      <div>
        <h3 className="text-lg font-semibold">商品图片</h3>
        <p className="text-xs text-muted-foreground">
          第一张是封面，上架后展示在商品列表与详情页。只支持 jpeg / png / webp / gif，
          单张不超过 {MAX_SIZE_BYTES / 1024 / 1024}MB。
        </p>
      </div>

      {items.length > 0 && (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {items.map((item, index) => (
            <li key={item.id} className="flex flex-col gap-1">
              <div className="relative">
                {/* 媒体的 url 来自 MinIO，不走 Next 的图片优化
                    （那个优化器要能访问图片源，而它是 localhost:19000）。 */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={item.url}
                  alt={`商品图 ${index + 1}`}
                  className="aspect-square w-full rounded-md border bg-muted object-cover"
                />
                {index === 0 && (
                  <span className="absolute left-1 top-1 rounded bg-foreground/80 px-1.5 py-0.5 text-[10px] text-background">
                    封面
                  </span>
                )}
              </div>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => move(index, -1)}
                  disabled={index === 0 || saving}
                  aria-label={`把第 ${index + 1} 张前移`}
                  title={index === 0 ? '已经是封面了' : '前移（变成封面）'}
                  className="flex-1 rounded border px-1 py-0.5 text-xs disabled:opacity-40"
                >
                  前移
                </button>
                <button
                  type="button"
                  onClick={() => move(index, 1)}
                  disabled={index === items.length - 1 || saving}
                  aria-label={`把第 ${index + 1} 张后移`}
                  title={index === items.length - 1 ? '已经是最后一张了' : '后移'}
                  className="flex-1 rounded border px-1 py-0.5 text-xs disabled:opacity-40"
                >
                  后移
                </button>
                <button
                  type="button"
                  onClick={() => remove(index)}
                  disabled={saving}
                  aria-label={`移除第 ${index + 1} 张`}
                  className="flex-1 rounded border px-1 py-0.5 text-xs text-destructive disabled:opacity-40"
                >
                  移除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* 正在上传 / 上传失败的图片。失败的那条给出重试按钮——
          重新走一遍签发 + 直传 + 确认，比让商家重新选文件省事。 */}
      {slots.length > 0 && (
        <ul className="flex flex-col gap-2">
          {slots.map((slot) => (
            <li key={slot.key} className="flex items-center gap-2 text-xs">
              <span className="truncate">{slot.filename}</span>
              {slot.error ? (
                <>
                  <span className="text-destructive">{slot.error}</span>
                  {slot.retry && (
                    <button
                      type="button"
                      onClick={slot.retry}
                      className="rounded border px-2 py-0.5"
                    >
                      重试
                    </button>
                  )}
                </>
              ) : (
                <span className="text-muted-foreground">
                  上传中… {slot.progress ?? 0}%
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      <label className="flex flex-col gap-1 text-sm">
        <span>选择图片</span>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          multiple
          onChange={(event) => handleFiles(event.target.files)}
          className="text-sm"
        />
      </label>

      {saving && <p className="text-xs text-muted-foreground">保存中…</p>}
      {message && <p className="text-sm text-destructive">{message}</p>}
    </section>
  );
}