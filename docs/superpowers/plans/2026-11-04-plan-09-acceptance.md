# 阶段 9 验收记录

> 日期：2026-11-04
> 设计：`docs/superpowers/specs/2026-11-04-plan-09-tech-debt-cleanup-design.md`
> 计划：`docs/superpowers/plans/2026-11-04-plan-09-tech-debt-cleanup.md`
> 技术债盘点：`docs/superpowers/plans/2026-11-04-tech-debt-inventory.md`

## 一、完成范围

### 批次 A：安全与部署

| 条目 | 内容 | 对应 Task | 结果 |
|------|------|-----------|------|
| A1 | 生产密钥守卫补全（JWT / 账目密钥 / 数据库 / Redis / MinIO / `AUTH_SECRET`） | T1 / T2 / T3 | 完成 |
| A2 | 宿主机端口默认只绑回环（`BIND_HOST`） | T3 | 完成 |
| A3 | Node 22 / npm 11 基线统一 | T4 / T8 | 完成 |
| A4 | 迁移流程收口（`db:fix-legacy-checksum`） | T6 | 完成 |
| A5 | `infra/.env.example` 补全 | T5 | 完成 |

补充完成（计划外但必要）：

- 共享包新增 `assertAuthSecret`，三端 `auth.ts` 在模块求值阶段调用；
  生产环境拒绝空值与已知占位值，`NEXT_PHASE=phase-production-build` 阶段放行。
- 修正 `KNOWN_PLACEHOLDER_SECRETS` 里出款账目密钥的前导 `-`（阶段 8 遗留：
  该条目比 compose 默认值多一个字符，生产环境实际**拦不住**真实默认值）。
- compose 的 `JWT_SECRET` / `AUTH_SECRET` 改为 `${VAR:-默认值}`，MinIO 镜像钉 digest。

### 批次 B：运维与 CI

| 条目 | 内容 | 对应 Task | 结果 |
|------|------|-----------|------|
| B1 | 备份与恢复（缺卷失败、归档校验、`restore.sh`、crontab 示例） | T7 | 完成 |
| B2 | CI 门禁（前端 matrix + `lint` + e2e job） | T8 | 完成 |
| B3 | 其余 CI 收敛（npm@11、注释与触发器口径） | T8 | 完成 |

### 批次 C：资金与并发护栏

| 条目 | 内容 | 对应 Task | 结果 |
|------|------|-----------|------|
| C1 | 回填闸：存在活跃出款单时默认拒绝（`--force` 跳过） | T9 | 完成 |
| C2 | 批量重试「确定未打款」的失败单脚本 | T10 | 完成 |
| C3 | 刷新令牌过期行按 30 天保留期删除，清理结果分开计数 | T11 | 完成 |
| C4 | 刷新令牌统一使用数据库时钟 | T12 | 完成 |
| C5 | `unconfirm` 在事务内回查与条件更新 | T13 | 完成 |
| C6 | 结算单 CSV 导出（转义 + 公式注入防护） | T14 | 完成 |
| C7 | 结算单分页上限统一为 `MAX_PAGE_SIZE`（100）并同步文案 | T15 | 完成 |

### 批次 D：前端、会话、依赖与文档

| 条目 | 内容 | 对应 Task | 结果 |
|------|------|-----------|------|
| D1 | 中转路由会话判空（70 处 `!session?.accessToken`） | T16 | 完成 |
| D2 | storefront 四个 loading 骨架 | T17 | 完成 |
| D3 | 依赖与配置清理（部分偏差，见第四节） | T18 | 完成 |
| D4 | 文档口径统一 | T19 | 完成 |
| D5 | MinIO 镜像 digest | T3 | 完成 |

## 二、验证结果

| 项目 | 实测 |
|------|------|
| api 单测 | **950 条 / 58 套件**（947 通过、3 跳过） |
| api e2e | **663 条 / 40 套件**，本机全绿（含 media 套件，MinIO 已启动） |
| storefront | **228 条 / 30 个文件** |
| merchant-admin | **428 条 / 29 个文件** |
| platform-admin | **475 条 / 23 个文件** |
| api `tsc --noEmit` | 通过 |
| api 全量 `npm run lint` | 通过（0 错误） |
| 三端 `tsc --noEmit` / `npm test` / `npm run lint` | 全部通过 |
| 三端 `npm run build` | 全部通过 |
| 共享包 `npm ci --dry-run` + `tsc` | 通过（npm 10 与 npm 11 双版本可安装） |
| `docker compose config` | 通过 |
| `bash -n backup.sh` / `bash -n restore.sh` | 通过 |

### 备份与恢复脚本

由实施代理用 docker 桩实测（主控复核脚本内容，未对真实数据卷执行恢复）：

| 场景 | 退出码 |
|------|--------|
| 正常备份 | 0 |
| 缺少 MinIO / Redis 卷（默认） | 1 |
| `ALLOW_MISSING_VOLUMES=1` | 0 |
| `BACKUP_KEEP_DAYS=0` | 1 |
| 归档损坏（`tar tzf` 失败） | 1 |
| `restore.sh` 不带 `--yes`（仅打印计划） | 0，不动数据 |
| `restore.sh` 备份文件不存在 | 1 |
| `psql` 中途失败（`ON_ERROR_STOP=1`） | 3 |

⚠️ **未对真实数据库 / MinIO / Redis 卷执行过恢复**：恢复会覆盖数据，
本机开发数据不应为验收而牺牲。恢复路径以「预览 + `--yes` 显式确认」保证安全。

### CI

推送后确认见第七节。

## 三、已知限制

- 跨副本分布式锁仍未做（阶段 9 范围外）。
- `unconfirm` 仍存在「回查之后、提交之前」的纳秒级窗口；`approve` 侧回查结算单
  状态作为第二道防线。
- CSV 导出仍受 100 条上限限制，超出需按周期筛选。
- 平台端不展示解密根因（按设计只写日志）。
- 回填闸是**整批拒绝**：任意租户存在活跃出款单时，`backfill:ledger` 默认一律不跑，
  需人工确认后 `--force`。
- 三个前端的 `lint` 已进 CI，但本地全量 build 仍是最耗时的一步。
- **交互事务里仍有使用非事务客户端的路径**（如 `coupon.service` 的
  `databaseNow()`）：事务占一条连接，再借一条普通连接，连接池很小时
  并发下单会被 P2024 拖死。CI 已用 `connection_limit=20` 规避；
  生产按并发量配置连接池，或在后续阶段把这类调用改成走 `tx`。

## 四、与计划的偏差

1. **`shadcn` 未删除**：三端 `src/app/globals.css` 都有
   `@import "shadcn/tailwind.css";`，`shadcn` 是构建期真实依赖（不是纯 CLI）。
   删除会让 `next build` 直接失败，故保留。计划 D3 的假设不成立。
2. **`prisma.seed` 引号还原**：`prisma db seed` 不经过 shell，单引号会被当成
   JSON 的一部分传给 `ts-node`，导致 seed 失败（e2e globalSetup 立刻暴露）。
   原写法（不加单引号）才是正确的，已还原。
3. **`AUTH_SECRET` 构建期放行**：三端 Dockerfile 在 `ENV NODE_ENV=production`
   下执行 `next build`，构建期没有运行时密钥。守卫增加
   `NEXT_PHASE=phase-production-build` 放行，否则镜像构建必炸；运行时仍硬失败。
4. **`.env.example` 的 `AUTH_SECRET`** 沿用 compose 默认值（而不是新占位值），
   避免升级后本地会话全部失效；守卫同时收录 compose 默认值与占位值两类。
5. **`billing-report.e2e-spec.ts` 显式 `{ force: true }`**：e2e 共用一个测试库，
   其他套件会留下活跃出款单，回填闸按设计整批拒绝。该用例验证的是回填幂等与
   报表口径，不是闸本身（闸由 `backfill-guard.spec.ts` 覆盖）。
6. **分页上限**：`SettlementListQueryDto` 从 `@Max(200)` 改为 `@Max(MAX_PAGE_SIZE)`，
   同时修正了既有页面测试里 `pageSize=200` 的断言。
7. **一次 e2e 抖动**：首轮全量 e2e 与三端 `next build` 并发执行时，
   `cart.e2e-spec.ts` 的并发加购用例出现一次 `[201, 400]`；单独重跑 24/24
   与随后干净环境全量重跑 663/663 均通过。判断为负载下的时序抖动，未改业务代码。
8. **CI 的 e2e job 把交互事务预算放宽到 30 秒**：前两轮 CI 中
   `order` / `order-discount` / `payout` 的并发用例在 2 核 runner 上稳定触发
   Prisma `P2028`（交互事务超过 10 秒）。新增
   `common/db/transaction-options.ts` 的 `transactionOptions()`，把散落的
   `{ maxWait: 10_000, timeout: 10_000 }` 收敛成一处，并支持用
   `PRISMA_TX_TIMEOUT_MS` 覆盖；**只有 CI 的 e2e job 设 30000**，生产不设，
   默认行为与原来完全一致。本地定向 e2e（三个套件 80 条）通过。
9. **CI e2e 的连接池放大到 20**：放宽事务超时后，失败从 `P2028` 变成
   `P2024`（连接池超时）。GitHub 2 核 runner 的 Prisma 默认池只有 5，
   而 5 个并发下单各占一条事务连接，事务内 `this.prisma.databaseNow()`
   又要再借一条 → 池打满互相等。e2e job 的 `DATABASE_URL_TEST` 显式加
   `connection_limit=20&pool_timeout=20`。这是环境容量配置，不改业务代码；
   生产需按并发量配池（已记入「已知限制」）。

## 五、失败注入记录

- 回填闸：先写 `backfill-guard.spec.ts` 并确认模块不存在导致失败，再实现。
- CSV 工具：先写 `csv.spec.ts` 并确认失败，再实现。
- `unconfirm` 事务：先补「事务内回查」用例并确认失败，再改实现。
- `token-grace` 清理：先写单测，再改返回值与删除逻辑。
- AUTH_SECRET 守卫：三端各自 5 条用例，覆盖占位值 / 空值 / 真实值 /
  非生产 / 构建期。

## 六、提交清单（本次阶段）

- `fix(api): 补生产凭据守卫并修正账目密钥占位值的前导减号`
- `feat(frontend-shared): 三端 AUTH_SECRET 生产占位值启动守卫`
- `fix(infra): compose 密钥可覆盖、端口默认回环并钉 MinIO digest`
- `chore: 统一 Node 22/npm 11 基线并固化迁移校验和脚本`
- `fix(frontend-shared): next build 阶段跳过 AUTH_SECRET 守卫`
- `chore(infra): 备份缺卷默认失败并补恢复脚本与定时示例`
- `ci: 前端合并 matrix 并补 lint 与 e2e 门禁`
- `feat(api): 回填前拦截存在活跃出款单的账期`
- `feat(api): 新增批量重试未打款失败单脚本`
- `fix(api): 清理超过保留期的刷新令牌行并分别计数`
- `fix(api): 刷新令牌统一使用数据库时钟`
- `fix(api): 取消确认在事务内回查并更新`
- `fix(front): 中转路由按 accessToken 判空`
- `feat(storefront): 补齐账户/结算/优惠券/搜索页加载骨架`
- `feat(billing): 结算单 CSV 导出（含转义与公式注入防护）`
- `fix(billing): 结算单分页上限统一为 100 并同步文案`
- `chore: 删除未使用的 @nestjs/config 与共享包 react-dom，并修正 seed 引号`
- `docs: 同步阶段 9 进度、测试条数与剩余技术债口径`

## 七、CI

推送后填写运行编号与六个 job 的结论。
