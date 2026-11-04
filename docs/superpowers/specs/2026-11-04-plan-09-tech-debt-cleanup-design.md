# 阶段 9「历史技术债清理」设计

> **日期**：2026-11-04
> **依据**：`docs/superpowers/plans/2026-11-04-tech-debt-inventory.md`
> **范围**：P0 全部 + P1/P2 中不需要产品决策的工程项。
> **目标**：把“已知但一直挂着”的工程债收口成可验证的改动，不引入新功能方向。

---

## 一、范围与排除

### 1.1 本轮做

| 批次 | 内容 |
|---|---|
| A 安全与部署 | 密钥守卫、端口回环、Node/npm 统一、迁移流程收口、`.env.example` 补全 |
| B 运维与 CI | 备份可验证/可恢复、前端 lint 门禁、e2e 进 CI、CI 收敛 |
| C 资金与并发 | 回填闸、批量重试未打款失败单、refresh token 行清理、宽限期时钟、`unconfirm` TOCTOU、结算单 CSV 导出、分页文案 |
| D 前端与文档 | 中转路由会话判空、loading 骨架、依赖清理、文档口径统一、镜像 digest |

### 1.2 明确不做

- 跨副本分布式锁：扩副本前单独立项（涉及鉴权与周期任务）。
- 产品决策类：历史退款冲回、跨期调账/逐笔结佣、告警通道、退货入库、套餐 `maxStores`、出款单作废重开、平台券 UI、`PERCENT` 折扣券、dark 模式。
- 新基建：Playwright、access token 黑名单、TLS/secret manager、结构化日志。
- `commission_entries.tenantId` 外键：历史脏数据未审计，先做数据审计再加约束。
- Prisma 4 条历史索引漂移：**不要修**（阶段 6 验收明确）。
- `prisma migrate dev`：不恢复。保留手写 SQL + `migrate resolve` 流程，只把它做成显式 npm script。

### 1.3 已排除的“假待办”

- e2e 每轮清库已实现（`api/test/setup-e2e.ts` 的 `truncateAllTables()`）。
- 全新库迁移失败不成立（那条迁移在全新库上整条跳过是设计行为）。
- 5m 的 summary/detail 性能债、渠道分页、`releasedEntryIds` 重试、主题实时预览、地址簿页面均已闭环。

---

## 二、批次 A：安全与部署

### A1. 生产密钥守卫补全

**现状**：`placeholder-secrets.ts` 只覆盖 4 个占位值；`POSTGRES_PASSWORD`、`MINIO_ROOT_PASSWORD`、`REDIS_PASSWORD`、`AUTH_SECRET` 在生产环境无断言。

**设计**：

1. `api/src/common/config/assert-secure-config.ts` 增加三项生产检查（仅 `NODE_ENV=production`）：
   - `DATABASE_URL` 的密码部分等于 `ecommerce` 或为空 → 启动失败。
   - `REDIS_URL` 没有密码（`new URL(...).password === ''`）→ 启动失败。
   - `MINIO_ROOT_PASSWORD` / `MINIO_SECRET_KEY` 等于 `ecommerce-minio-secret` 或为空 → 启动失败。
2. `infra/docker-compose.yml`：
   - `JWT_SECRET`、三端 `AUTH_SECRET` 改为 `${VAR:-默认值}`，默认值保持不变，允许 `infra/.env` 覆盖。
   - 新增 `BIND_HOST`（见 A2）。
3. 三端 `auth.ts` 在模块顶层调用共享的 `assertAuthSecret(process.env.AUTH_SECRET)`：
   - 生产环境且值为 compose 默认值或 `.env.example` 占位值 → 直接抛错。
   - 共享实现放在 `packages/frontend-shared/src/assert-auth-secret.ts`，三端薄壳调用。
4. 单测：
   - API：production + 各默认值 → 抛错；非生产 → 放行。
   - 共享包：占位值集合与生产判断。
   - 三端 `auth.ts` 现有测试补一条断言。

**边界**：守卫只能看到进程环境；`AUTH_SECRET` 由 Next 进程读取，所以放在前端断言，不塞进 API 配置校验。

### A2. 宿主机端口回环

**设计**：

- `infra/docker-compose.yml` 的 MinIO API 与 nginx 端口改为 `${BIND_HOST:-127.0.0.1}:...`。
- README 写明：默认只绑本机；需要局域网访问时显式 `BIND_HOST=0.0.0.0`，并提醒 MinIO 复用 root 凭据。
- 不改变容器内监听地址。

### A3. Node/npm 统一

**设计**：

- 五个子项目 `package.json` 补 `"engines": { "node": ">=22 <27", "npm": ">=11" }`。
- 仓库根新增 `.nvmrc`：`22`。
- `.github/workflows/ci.yml` 每个 job 在 `npm ci` 前执行 `npm install -g npm@11`，与 Dockerfile 对齐。
- README 记录“本机 Node 26 可用，但 CI/镜像基线是 22 + npm 11”。

### A4. 迁移流程收口

**设计**：

- `api/package.json` 新增 `"db:fix-legacy-checksum": "prisma db execute --schema prisma/schema.prisma --file prisma/fix-legacy-migration-checksum.sql"`。
- AGENTS 与 `api/README.md` 改为引用该命令；保持“只在报 modified 时执行”的警告。
- 不修改任何已有迁移文件。

### A5. `.env.example` 补全

**设计**：

- `infra/.env.example` 补 `BIND_HOST`、`NGINX_PORT`、`API_PORT`、三端端口、`JWT_SECRET`、`AUTH_SECRET`、`MINIO_*`、`MEDIA_MAX_SIZE`、渠道相关变量。
- `PAYOUT_ACCOUNT_ENCRYPTION_KEY` 不再注释，给出显式占位值并标注必须替换。
- README 说明 `FAKE_PAYMENT_ENABLED` / `FAKE_PAYOUT_ENABLED` 默认关闭；不设置时非生产 `enabledChannels()` 仍会列出 `fake`，这是“列表可见但调用会拒绝”的既有语义，文档写清。

**验收**：`api` 单测 + `tsc` + lint；三端 `tsc` + 测试；`docker compose config` 能解析。

---

## 三、批次 B：运维与 CI

### B1. 备份与恢复

**设计**：

- `infra/backup.sh`：
  - MinIO / Redis 打包后执行 `tar tzf` 校验，失败删除产物并非零退出。
  - 卷找不到默认 `exit 1`；设置 `ALLOW_MISSING_VOLUMES=1` 才跳过（cron 场景需要显式选择）。
  - `BACKUP_KEEP_DAYS` 改为 `^[1-9][0-9]*$`，禁止 0。
- 新增 `infra/restore.sh`：
  - 用法：`./restore.sh postgres <file.gz> | minio <file.tgz> | redis <file.tgz> --yes`。
  - 恢复前停止相关服务（postgres 恢复时停 api；MinIO/Redis 各自停容器），恢复后启动。
  - 无 `--yes` 只打印计划不执行。
- 新增 `infra/crontab.example`，包含 PATH 与日志重定向。
- README 补 Redis 备份与三类恢复步骤。

### B2. CI 门禁

**设计**：

- 三个前端 job 在 `npm test` 后补 `npm run lint`。
- 新增 `e2e` job：
  - services：`postgres:16-alpine`（15432）、`redis:7-alpine`（16380）。
  - 步骤：`npm ci` → `npx prisma generate` → `npx prisma migrate deploy`（测试库）→ 跑 e2e。
  - `DATABASE_URL_TEST` 指向 `ecommerce_test`；Prisma 会自动建库。
  - 排除 `media.e2e-spec.ts`（需要 MinIO），其余套件全跑。
  - 用单独的 `e2e` env：`BULLMQ_PREFIX=bull-e2e`、`JWT_SECRET`、`PAYOUT_ACCOUNT_ENCRYPTION_KEY`。
  - `timeout-minutes: 20`，`--runInBand`。
- 更新 `ci.yml` 顶部注释：API 推送当前会触发 `push` 事件。
- 三个前端 job 收成 `matrix`（`project` + 各自 build env），保留 `shared` job。

**风险**：e2e 依赖时序与 DB 清理；`setup-e2e.ts` 已每轮清库并清 `bull-e2e` 队列。CI 首跑若 flaky，只回退 media 与否不改变隔离机制。

### B3. 其余 CI 收敛

- 全部 job 显式 npm 11。
- 不升级 `actions/*` 版本（先解决弃用告警，升级单独做）；在 README 记录告警来源。

**验收**：CI 五个原 job 全绿 + e2e job 全绿；备份脚本在副本目录跑通（含故意缺卷、坏 tar 的失败用例）。

---

## 四、批次 C：资金与并发护栏

### C1. 回填闸

**现状**：`npm run backfill:ledger` 无“该周期已出款”保护。

**设计**：

- 在 `CommissionService.backfill()` / `ReceiptService.backfill()` 入口先查：
  - 该租户周期内是否存在 `payouts` 状态不在 `REJECTED/CANCELLED/FAILED` 的单。
- 默认拒绝这些周期并把清单打印到 stderr/non-zero；显式 `--force` 才继续。
- 脚本参数解析放在 `api/scripts/backfill-commission-entries.ts`，服务层只提供只读查询方法。
- 单测：有活跃/已付款出款单 → 默认拒绝；`--force` → 继续。

### C2. 批量重试“确定未打款”的失败单

**设计**：

- 新增 `api/scripts/retry-pre-payout-failures.ts` 与 npm script `payout:retry-pre-payout`。
- 只选 `status=FAILED AND failedBeforePayout=true` 的单；逐单调用现有 `PayoutService.retry(id, reason)`。
- 操作人取平台超管账号（按 role 查一个），写入 `payout_operations`。
- 输出每单结果与汇总；单条失败不中断整批。
- 不做自动状态机迁移，不把解密根因暴露到浏览器。

### C3. refresh token 行清理

**设计**：

- `TokenGraceService.cleanup()` 在抹密文之外，增加：
  - 删除 `expiresAt < databaseNow() - REFRESH_TOKEN_RETENTION_DAYS` 的行（默认 30 天，常量）。
- 保留 `rotatedToToken` 抹除逻辑与审计窗口。
- 单测：过期超过保留期的行被删；未过期行保留；抹密文行为不变。

### C4. 宽限期时钟

**设计**：

- `AuthService.refresh()` 在事务开始前取一次 `databaseNow()`，用它与 `graceExpiresAt` 比较。
- 事务内仍用同一时间点，避免多次取时钟。
- 单测：应用时钟超前/滞后时，判定跟随数据库时钟。

### C5. `unconfirm` TOCTOU 收窄

**设计**：

- 把“状态条件更新 + 活跃出款单回查”放进同一个 `$transaction`：
  1. `updateMany` 条件更新 `CONFIRMED → DRAFT`；
  2. 若 `affected.count === 0` 回滚并报冲突；
  3. 回查 `hasActivePayoutReference`（改为接受 `tx` 参数，确保读在同一事务内），有引用则抛错回滚。
- 这样“更新后新插入的出款单”会在事务提交前被回查看到；仍不能覆盖“回查后、提交前”的纳秒级窗口，设计文档如实记录，`approve` 侧继续回查结算单状态。

### C6. 结算单 CSV 导出

**设计**：

- 后端新增 `GET /platform/settlements/export?period=YYYY-MM`：
  - 复用列表查询（最多 100 条上限），返回 `text/csv; charset=utf-8`，带 `Content-Disposition`。
  - 列：结算单号、商家、周期、货款、佣金、净额、状态、确认时间。
  - CSV 转义：字段含逗号/引号/换行时加引号并双写引号；公式注入防护：以 `= + - @` 开头的单元格前置 `'`。
- 平台端结算单列表加“导出 CSV”按钮，走同源中转路由。
- 单测：转义、公式注入、空列表、权限。

**不做**：PDF、异步导出任务、跨页全量导出（仍受 100 条上限）。

### C7. 分页文案

- 平台端结算单列表请求改为 `pageSize=100`，文案改为“超过 100 张时请按周期筛选”，注释同步到后端 `MAX_PAGE_SIZE`。

**验收**：api 单测 + 定向 e2e（settlement / payout / token-grace / backfill）。

---

## 五、批次 D：前端、会话、依赖与文档

### D1. 中转路由会话判空

- merchant-admin 48 处、platform-admin 22 处：`if (!session)` → `if (!session?.accessToken)`。
- 保留 `unauthorizedResponse()`；不改变错误文案。
- 每端至少补 2 条路由测试：`session` 为 `null` 与 `{ accessToken: '' }` 都返回 401，且不调用后端。

### D2. loading 骨架

- storefront 新增 `(shop)/account/loading.tsx`、`checkout/loading.tsx`、`coupons/loading.tsx`、`search/loading.tsx`。
- 复用现有 `orders/loading.tsx` 的骨架风格，不引入新依赖。

### D3. 依赖与配置清理

- 删除 `@nestjs/config`（已确认未使用）。
- 删除三端 `shadcn` devDependency（CLI 不用作运行时）。
- 评估共享包 `react-dom`：若仅类型/测试间接需要则保留；确认无用再删。
- `prisma.seed` 的 `--compiler-options` 加上引号，与同文件其他脚本一致。
- 保留 `backfill:commissions` 别名，README 标注为历史命令名。

### D4. 文档口径

- 三端子 README 的测试条数与文件数更新到**本阶段末实测值**（当前基线：storefront 223、merchant-admin 421、platform-admin 465、api 927/663；本轮会因新增测试而变化）。
- `AGENTS.md`：阶段 8/9 口径、lint 说明改为“api lint 已归零，仍只定向跑以控制时间”。
- README：技术债标题改名“阶段 8 之后的剩余技术债”；备份说明补 Redis；推送脚本补 curl 版；`ci.yml` 注释同步。
- 根 README 与子 README 的测试文件数按实际 `find` 结果修正。

### D5. 镜像 digest

- `infra/docker-compose.yml` 的 MinIO `latest` 改为当前 digest（保留注释说明来源）。
- 其余镜像继续用 tag（postgres/redis/nginx 版本明确）。

**验收**：三端 `tsc` + lint + test + build；文档链接逐条 `test -e`。

---

## 六、批次依赖与执行顺序

1. A 必须先做：改 compose 与密钥断言会影响全栈冒烟与后续测试环境。
2. B 依赖 A 的 npm 版本统一；e2e job 依赖 A 的密钥断言不误伤 CI（CI 用非生产）。
3. C 与 D 可并行；C 涉及资金，先跑定向 e2e。
4. 文档与盘点收尾最后做，避免测试数字二次漂移。

## 七、风险与回滚

| 风险 | 处理 |
|---|---|
| 新增生产密钥断言导致本机 `compose up` 失败 | 与阶段 8 一致：本机用 `NODE_ENV=development` override；README 写明 |
| CI e2e 首跑 flaky | 先只排除 `media`，其余全跑；若时序问题，保持 `--runInBand` 并单独修 setup |
| 批量重试误伤“钱可能已打”的单 | 只选 `failedBeforePayout=true`，复用现有 `retry()` 的硬闸 |
| refresh token 物理删除误删审计线索 | 保留 30 天窗口；只删已过期行，宽限密文仍先抹除 |
| `unconfirm` 事务化引入死锁 | 事务只操作 `settlement_statements` 与 `payouts` 读，按现有顺序；补并发测试 |
| CSV 公式注入 | 统一转义函数，带单测 |
| 会话判空改动面大 | 逐端 codemod + 两端路由测试；不改错误文案 |

## 八、验收标准

- 批次 A：api 定向单测 + tsc + lint；三端 tsc/测试；`docker compose config` 通过。
- 批次 B：备份脚本正反用例；CI 原五 job + 新 e2e job 全绿。
- 批次 C：api 全量单测、settlement/payout/token-grace 定向 e2e、CSV 单测。
- 批次 D：三端 tsc + lint + test + build；文档链接检查。
- 收尾：api 全量单测 + 全量 e2e（本地）+ 全栈冒烟；更新验收记录与 README/AGENTS。
