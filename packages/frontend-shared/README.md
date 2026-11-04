# @ecom/frontend-shared

三端（storefront / merchant-admin / platform-admin）共享的前端基础模块：令牌刷新、会话同步、错误边界、价格格式化与 api-client。

用 npm `file:` 协议引用（`"file:../packages/frontend-shared"`）而非根 workspace，是为了不动三端既有的 install/test/build 命令形态。

注意：`session-sync-component.tsx` 通过工厂 `createSessionSyncComponent(createSessionSync)` 注入各端逻辑，包内**不再依赖** `@/` 别名；本包可独立 `npx tsc --noEmit`（CI 有 shared job）。三端薄壳 `components/session/session-sync.tsx` 只负责把本端 `@/lib/session-sync` 传进工厂。

