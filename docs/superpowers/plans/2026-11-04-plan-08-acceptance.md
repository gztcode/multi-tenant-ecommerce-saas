# 阶段 8「部署韧性、鉴权与资金正确性」验收记录

> **日期**：2026-11-04
> **设计**：`docs/superpowers/specs/2026-11-04-plan-08-resilience-auth-funds-design.md`
> **计划**：`docs/superpowers/plans/2026-11-04-plan-08-resilience-auth-funds.md`（19 个 Task，5 个波次）
> **执行方式**：agent-team 波次并行；实施代理不提交、只跑定向测试；每个 Task 先规格审查再代码质量审查。

---

## 一、交付内容

### 8a 部署与鉴权

| 项 | 结果 |
|---|---|
| Nginx 把店铺子域名的 `/api/**` 只代理 `/api/v1/`，BFF 路由归还 storefront | 已改，网关实测 `/api/cart` 200 |
| 生产密钥守卫改为「已知占位符集合」判断，覆盖 compose 内置默认值 | 已改；production + compose 默认值经单测断言会拒绝启动 |
| platform-admin 补令牌刷新链路（薄壳 + 函数式 NextAuth + SessionSync + 测试） | 已改，与另两端同构 |

### 8b 资金与并发正确性

| 项 | 结果 |
|---|---|
| 购物车加购改单条原子自增，P2002 重试；并发不丢增量、超上限 400 | 已改，新增 2 条 e2e |
| 续费按成功支付单幂等结算；单租户异常不中断整批 | 已改，新增 2 条 e2e |
| 渠道交易号绑定补 `provider` 并检查影响行数，0 行返回 false | 已改，新增 4 条单测 |

### 8c 健壮性与工程债

| 项 | 结果 |
|---|---|
| 归期改 DB 端 DISTINCT；券/媒体分页夹取与合并窗口上限 1000 | 已改 |
| storefront 搜索/品类/商品页区分 404 与故障，故障可重试 | 已改 |
| 购物车受控输入失败回滚、重试真正重取（含读车请求序号） | 已改 |
| 库存面板切 SKU 丢弃过期响应（含响应体解析窗口） | 已改 |
| 共享 api-client `forwardCookie` 必填；无令牌显式 401 且不发请求 | 已改 |
| 共享 SessionSync 改工厂注入，共享包可独立 tsc | 已改，`src/` 已无 `@/` 别名 |
| CI：权限/并发/超时、api tsc+lint、新增 shared job | 已改（CI 结果见下） |
| 备份保留策略、Redis 卷、`gunzip -t`、等待 postgres | 已改，脚本在副本目录完整跑通 |
| nginx healthcheck 与 `/_next/static/` immutable 缓存 | 已改，容器实测 healthy |
| api lint 0 错误、删除未使用依赖与失效 `.dockerignore` | 已改 |

---

## 二、验证结果

### api

| 命令 | 结果 |
|---|---|
| `npm test` | 52 套件，927 用例：924 通过 / 3 跳过 / 0 失败 |
| `npm run test:e2e`（串行） | 40 套件，663 用例全过（约 156 秒） |
| `npx tsc --noEmit` | 0 错误 |
| `npm run lint` | 0 错误 / 0 警告 |
| `npm run prisma:deploy` | 29 个迁移，无待应用 |

### 共享包与三个前端

| 项目 | 测试 | tsc | build |
|---|---|---|---|
| `packages/frontend-shared` | — | 0 错误（`npm ci` 28 包） | — |
| storefront | 29 文件 / 223 用例通过 | 0 错误 | 成功（28 条路由） |
| merchant-admin | 28 文件 / 421 用例通过 | 0 错误 | 成功 |
| platform-admin | 21 文件 / 465 用例通过 | 0 错误 | 成功 |

### 备份脚本

在 `infra/backups-test` 副本上完整执行（真实历史备份未动）：

- `BACKUP_KEEP_DAYS=1` 时，手工造的 2020-01-01 旧目录被清理（`PRUNED`）。
- 产物：`postgres-ecommerce.sql.gz`、`minio-data.tgz`、`redis-data.tgz`。
- `gunzip -t` 校验通过（`VERIFIED`）；`tar tzf` 能列出 Redis/MinIO 内容。
- 卷查询失败会中断脚本，不再静默跳过 Redis。

### 全栈与网关

`docker compose up -d --build --wait`：8 个容器全部 healthy；nginx、api 均 `Up (healthy)`。

| 请求（Host: `demo.platform.test`） | 状态 |
|---|---|
| `/api/cart` | 200（正常下发 cookie） |
| `/api/auth/session` | 200（未登录返回 `null`） |
| `/api/v1/health` | 200（redis/database 均 true） |
| `/` | 200 |
| `/p/gan-charger-65w` | 200，页面含商品内容 |
| `merchant.platform.test` / `admin.platform.test` | 307 跳转登录（正常） |

⚠️ **全栈验证使用临时 compose override 把 api 的 `NODE_ENV` 设为 `development`**：
阶段 8a 的守卫会按设计拒绝「production + compose 内置默认密钥」，这正是修复目标；
没有修改 compose 默认值（改账目密钥会让既有出款单快照永久解不开）。

### CI

推送后确认五个 job（api / storefront / merchant-admin / platform-admin / shared）结果：
**待回填**。

---

## 三、实施期偏差与已知限制

1. **Task 7 分页口径**：`clampPagination` 把 `pageSize=0` 夹到 1（不是默认 20）；
   `mediaIds` 重复时 `sort` 按最后出现位置编号（既有 `setMedia` 行为）。测试按实测口径断言。
2. **Task 7 计划外文件**：`payout.service.spec.ts` 必须为新 wrapper 补 mock，否则既有 6 条用例报错。
3. **Task 9 行为调整**：已有 items 时错误显示为顶部提示条并保留列表，
   否则受控输入框会被卸载、用户看不到失败回滚；初始加载失败仍是整块错误态 + 重试。
4. **Task 10 增强**：除 `fetch` 返回后的序号校验外，在读错误体 / `response.json()` 之后也各校验一次；
   测试补了「响应体解析期间切走」的用例。
5. **Task 14 补充 `typescript` devDependency**：计划只写 `@types/node`，
   但 CI 的 shared job 要在包目录跑 `npx tsc --noEmit`，缺本地编译器会失败。
6. **Task 15 实际范围大于计划**：为让 `npm run lint` 真正到 0，额外修了
   `prisma/seed.ts`、`scripts/check-ledger.ts` 与若干 spec 的 prettier（均无语义变化）。
7. **Task 17 响应头**：Next.js 自身也会返回 `Cache-Control`，nginx `add_header` 会再追加一条
   同值头；语义无害。`always` 使 404 静态路径也带 immutable（按计划「location 命中即带头」）。
8. **Task 18 提交粒度**：三个 `.dockerignore` 的删除被并入了 Task 15 的 lint 提交，
   内容正确，仅提交信息未覆盖该删除。
9. **Task 13 CI 顺序**：质量审查后把 `npx prisma generate` 提到 `tsc` 之前，
   避免依赖 `@prisma/client` 的隐式 postinstall。
10. **未做浏览器手工链路**：购物车输入回滚、库存切 SKU、后台刷新等由组件测试与
    api e2e 覆盖；全栈只做了 HTTP/网关与页面渲染级验证，未在真实浏览器里点完整下单流程。

---

## 四、明确延后（阶段 9+）

- platform-admin 22 处中转路由的 `session.accessToken` 判空改造。
- 真实渠道接入、告警通道、跨副本分布式锁、退货入库、套餐 `maxStores`、跨店会员、游客订单查询。
- TLS / secret manager / 结构化日志 / 慢查询阈值 / e2e 进 CI / cron 容器。
- 券深页窗口改用数据库 UNION（当前窗口 1000 已够用）。
- Prisma 迁移的 4 条历史索引漂移（阶段 2 / 5a 已知问题）。
