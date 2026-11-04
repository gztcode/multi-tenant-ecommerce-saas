'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createSessionSync } from '@/lib/session-sync';

/**
 * 客户端的会话同步器。
 *
 * ## 它解决什么
 *
 * 阶段 4 验收实测：**商家在后台开第二个标签页，就会被踢下线**。
 *
 * 根因：Server Component 里的 `await auth()` 拿不到 `Set-Cookie`——
 * 服务端把刷新令牌轮换掉了，但**浏览器永远拿不到新令牌**，
 * 于是下一次读会话又用那枚作废的旧令牌 → 后端判「真正的重放」→
 * `revokeTokenFamily` 吊销该用户**所有设备**的登录。
 *
 * 这个组件在页面挂载时打一次同源的 `/api/auth/session`
 * （NextAuth 自带的 Route Handler），那条路径**能把刷新后的 cookie 送回浏览器**。
 * 多个标签页之间用 `BroadcastChannel` + `localStorage` 协调，
 * **同一时刻只让一个标签页去刷**（详见 `@/lib/session-sync.ts`）。
 *
 * ⚠️ **这是缓解，不是根治**：后端的宽限期改造（RFC 9700）仍然必要，
 * 多浏览器 / 多设备场景前端救不了。
 *
 * ## 为什么刷新完要 `router.refresh()`
 *
 * 刷新后**浏览器里的 cookie** 与**服务端渲染时用的令牌**不是同一个了
 * （服务端渲染发生在这个组件挂载之前）。`router.refresh()` 让服务端
 * 用新的 cookie 重渲染一次，页面上的数据才是对的。
 *
 * ⚠️ 只在**真的刷新了**的时候才 refresh——`skipped`（别的标签页刚刷过）
 * 与 `failed` 都不需要，白白 refresh 只会多打一次服务端渲染。
 */
export function SessionSync() {
  const router = useRouter();

  useEffect(() => {
    const sync = createSessionSync({
      onSynced: () => {
        // 别的标签页刷完了 → 我们的 cookie 也变了 → 重新渲染一次。
        router.refresh();
      },
    });

    void sync.start().then((outcome) => {
      if (outcome === 'refreshed') {
        router.refresh();
      }
    });

    return () => {
      sync.stop();
    };
  }, [router]);

  return null;
}
