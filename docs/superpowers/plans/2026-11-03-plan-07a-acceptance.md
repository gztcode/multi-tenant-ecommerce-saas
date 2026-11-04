# 阶段 7a「工程与部署基建」验收记录

> **设计**：`docs/superpowers/specs/2026-11-03-plan-07-engineering-hardening-design.md`
> **计划**：`docs/superpowers/plans/2026-11-03-plan-07a-engineering-hardening.md`
> **验收日期**：2026-11-04
> **分支**：`plan-07a-engineering-hardening`（PR #26）

---

## 一、交付范围

| # | Task | 状态 | 落点（commit） |
|---|------|------|----------------|
| 1 | `tools/push-via-api.mjs` maxBuffer 笔误（10264 → 1024） | ✅ | `5ad8501` |
| 2 | Redis 加 requirepass，api 连接串与两份 env 示例同步 | ✅ | `e6305c2` |
| 3 | api / minio-console 端口绑回环，DATABASE_URL 与账单密钥改引用 `.env` | ✅ | `e6305c2` |
| 4 | compose 统一日志轮转（10m×3）+ 8 服务 mem_limit | ✅ | `35cdbfa` |
| 5 | 三前端容器 healthcheck，nginx depends_on 等 healthy | ✅ | `35cdbfa` |
| 6 | nginx 收口（gzip / body 10m / 超时 / 安全头 / default server 444） | ✅ | `17e30d2` |
| 7 | 备份脚本 `infra/backup.sh` + `.gitignore` + README 说明 | ✅ | `ad0f8dc` / `a77b704` |
| 8 | GitHub Actions CI（四 job）+ README 写明 e2e 不进 CI | ✅ | `a2dc9f1` / `199d7f5` |

审查修复的补充提交：`fa2c23b`（quality 审查 7 项：backup pipefail 死分支、CI 缺
`AUTH_SECRET` 等）、`3f16190` / `7fe52d3`（CI 首跑抓到的 lock 不同步）。

### 1.1 实施期偏离计划的地方

1. **回环绑定统一到了全部宿主机端口**（超出计划列的 api / minio-console 两个）：
   批次 B 的 quality 审查指出 postgres 15432 与批次 A 的口径不一致——既然「不暴露
   局域网」是设计意图，redis 16380 与 postgres 15432 也一并绑 `127.0.0.1`
   （本机开发走 localhost 不受影响，实测 api health 与 e2e 全绿）。
2. **Git Data API 推送不产生 push 事件**——CI 靠 push 触发的假设不成立。
   `ci.yml` 加了 `workflow_dispatch` 入口；实际首跑由 PR #26 的
   `pull_request` 事件触发（创建 / 重开 PR 都会触发）。**以后更新 PR 分支后
   需要关闭再重开 PR（或手动 dispatch）来触发 CI**。
3. **`Host: localhost` 现在落 444**（default server 收口的预期行为变化）：
   README 的健康检查 / 接口文档 URL 改为直连 `localhost:3000`（api 端口已绑回环仍可用）。
4. **`npm install` 修不了 CI 的 lock 报错**：本机 npm 11 与 CI 的 npm 10
   （node 22 自带）对 lock 的校验规则不同，npm 11 认可的 lock 会被 npm 10 的
   `npm ci` 拒绝。正解是用 node 22 容器重新生成
   （`docker run --rm -v "$PWD":/app -w /app node:22-alpine npm install --package-lock-only`），
   再用同容器 `npm ci --dry-run` 预验证。

### 1.2 审查期发现并修掉的问题

两阶段审查（spec → quality）抓到的真问题：

| # | 问题 | 危害 | 修法 |
|---|------|------|------|
| 1 | Redis 密码四处字面量不一致（compose 默认 / 两份 example / api/.env） | 无 `.env` 时宿主机连不上 redis | 统一为 `infra/.env.example` 一处事实来源，哈希比对验证 |
| 2 | `PAYOUT_ACCOUNT_ENCRYPTION_KEY` 加变量壳时**默认值被换成了别的值** | 既有出款快照永久解不开（资金安全） | 从 main 恢复原值进 `:-fallback`，哈希比对验证 |
| 3 | 变量壳写成 `${VAR:默认}`（缺 `-`） | compose 插值直接报 invalid format | 改 `${VAR:-默认}` |
| 4 | postgres 15432 未绑回环，与批次 A 口径矛盾 | 数据库对局域网裸奔 | 全部端口统一绑 `127.0.0.1` |
| 5 | `backup.sh` 的「找不到卷就跳过」是死分支：grep 无匹配 + pipefail 在友好提示前杀掉脚本 | postgres 备份做完但 MinIO 静默跳过 | 管道尾 `\|\| true` |
| 6 | CI 三前端构建缺 `AUTH_SECRET`（auth.ts 模块顶层读取） | next build 首跑 MissingSecret 风险 | build 步骤补 CI 临时值 |
| 7 | `tools/push-via-api.mjs` maxBuffer `10264` 笔误 | 大仓库推送时 gh 输出截断 | `1024` |

---

## 二、自动化测试与运行验证

| 层 | 命令 | 结果 |
|----|------|------|
| 单测（后端） | `cd api && npm test` | **47 suites / 889 tests**（886 passed + 3 skipped）全绿 |
| e2e（后端全量） | `cd api && npm run test:e2e` | **40 suites / 657 tests** 全绿 |
| compose 部署形态 | `docker compose up -d --wait && docker compose ps` | 8 服务全部 `(healthy)`（nginx 无 healthcheck，Up） |
| 端口回环 | `lsof -nP -iTCP:{15432,16380,3000,19001} -sTCP:LISTEN` | 全部 `127.0.0.1`；19000（MinIO API）仍全网卡（浏览器直传要用） |
| Redis 密码链路 | `redis-cli -a "$REDIS_PASSWORD" ping` / 无密码 ping | `PONG` / `NOAUTH`（双向确认） |
| api health | `curl localhost:3000/api/v1/health` | `{"redis":true,"database":true}` |
| nginx 收口 | 未知 Host / 安全头 / 三域名回归 | `000`（444）/ 三头齐全 / 200·307 正常 |
| 备份真跑 | `cd infra && ./backup.sh` | `postgres-ecommerce.sql.gz`(16K) + `minio-data.tgz`(417K)，`gunzip -t` 通过，产物即删 |
| YAML | `npx js-yaml .github/workflows/ci.yml` | 通过 |

> ⚠️ **本地 e2e 一度 104 条失败，与 7a 无关**：报错
> `Unknown argument refundAttemptCount`——本地 node_modules 的 Prisma Client
> 是旧 schema 生成的（阶段 6c 加的字段），`npx prisma generate` 后 657 条全绿。
> 阶段 6 收尾后没跑过 `prisma generate` 的环境都会有这毛病。

### 2.1 CI 首跑（云端）

| run | 结果 | 原因与处置 |
|-----|------|-----------|
| `41754288449`（PR 首建触发） | ❌ api 失败 | `npm ci` 报 `Missing: webpack@5.112.2 from lock file`——lock 与 package.json 漂移被 CI 抓到（本机旧 node_modules 掩盖） |
| `41758775840`（重开 PR） | ❌ api 失败 | 同上：npm 11 生成的 lock 过不了 npm 10 校验 → node 22 容器重新生成 |
| **`41759956163`（重开 PR）** | ✅ **四 job 全绿** | api（886 单测 + services 容器）+ 三端（tsc/test/build） |

CI 的 api job 用 service 容器起 postgres（含 `pg_trgm` 安装步骤）与 redis；
**e2e 暂不进 CI**（设计 §3.1），README 已写明。

---

## 三、迁移检查

本阶段**无数据库迁移**（纯 infra + 配置）。
`cd api && npx prisma migrate status`：29 migrations / up to date（与阶段 6 一致）。

---

## 四、遗留清单（本阶段明确不做）

沿袭设计文档 §七：真实渠道接入、告警系统落地、跨副本分布式锁、通用平台设置
中心、退货入库流程、TLS / secret manager / pino / e2e 进 CI、三端 import 路径
大面积替换等。另新增一条：

1. **PR 分支更新后 CI 不会自动跑**（API 推送无 push 事件）——需要关闭重开 PR
   或手动 dispatch。若以后 git 直连恢复，可删掉 `workflow_dispatch` 依赖。

---

## 五、手工验收建议（按顺序）

1. `cd infra && docker compose up -d --wait`，8 服务全 healthy。
2. `redis-cli -p 16380 ping`（不带密码）应被拒；带 `infra/.env.example` 里的
   密码应 `PONG`。
3. `curl -H 'Host: unknown.host.test' http://localhost/` 应无响应（444）；
   `curl -H 'Host: demo.platform.test' http://localhost/` 应 200。
4. 商家后台发一笔出款、退一笔款，确认资金链路无回归（Redis 密码 / 密钥引用化
   之后的行为验证）。
5. `cd infra && ./backup.sh` 真跑一次，检查 `backups/<时间戳>/` 产物后自行清理。
6. PR #26 页面查看 CI 绿勾；合并后 main 的 push 由 `branches: [main]` 过滤承接。
