# @ecom/frontend-shared

三端（storefront / merchant-admin / platform-admin）共享的前端基础模块：令牌刷新、会话同步、错误边界、价格格式化与 api-client。

用 npm `file:` 协议引用（`"file:../packages/frontend-shared"`）而非根 workspace，是为了不动三端既有的 install/test/build 命令形态。

注意：`session-sync-component.tsx` 依赖各端 `@/lib/session-sync` alias（有意的设计——纯逻辑留在端内），本包因此不可独立安装使用。

