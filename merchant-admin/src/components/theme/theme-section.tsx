'use client';

import { ThemeForm, type ThemeSchema } from './theme-form';

/**
 * 主题分区（客户端包装层）。
 *
 * 存在的理由：settings/page.tsx 是 Server Component，而 Server Component
 * **不能把函数传给 Client Component**——`onSave` 这种事件处理器跨越 RSC 边界
 * 会在运行时抛 "Event handlers cannot be passed to Client Component props"，
 * 整个设置页 500。注意这个错误**构建期抓不到**：类型检查与 next build 都通过，
 * 只有真正渲染该页才会暴露。
 *
 * 所以保存逻辑放在这里、由本组件自己 fetch 同源中转接口，page 只负责
 * 取数据后把纯数据（schema / initial）传下来。
 */
export function ThemeSection({
  schema,
  initial,
}: {
  schema: ThemeSchema;
  initial: Record<string, unknown>;
}) {
  return (
    <ThemeForm
      schema={schema}
      initial={initial}
      onSave={async (tokens) => {
        // 同源中转，原因见 /api/stores/me/route.ts：
        // 后端没开 CORS，且 accessToken 只留在服务端。
        const response = await fetch('/api/stores/me', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ themeTokens: tokens }),
        });
        if (!response.ok) {
          const payload = (await response.json().catch(() => ({}))) as {
            message?: string;
          };
          throw new Error(payload.message ?? '保存失败');
        }
      }}
    />
  );
}