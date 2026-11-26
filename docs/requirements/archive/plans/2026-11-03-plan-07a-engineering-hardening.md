# 阶段 7a「工程与部署基建」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 CI、compose 安全收口（Redis 密码 / 端口绑定 / 密钥引用化 / 日志轮转 / mem_limit）、Nginx 收口与备份脚本，并顺手修 tools 笔误。

**Architecture:** 全部改动集中在 `infra/`、`.github/`、`tools/` 与两份 `.env.example`，无应用代码变更；每个 Task 独立提交，`docker compose config` 与 `up -d --wait` 作回归闸。

**Tech Stack:** Docker Compose v2、Nginx 1.27、GitHub Actions、Bash。

**设计文档:** `docs/superpowers/specs/2026-11-03-plan-07-engineering-hardening-design.md`（7a 节）

**执行约定（agent-team 模式）:** 实施代理**不提交**、只改文件跑定向验证；commit 由主会话在各 Task 验证通过后执行。工作分支：`plan-07a-engineering-hardening`（从 main 切出）。

---

## Task 1: 修复 `tools/push-via-api.mjs` 的 maxBuffer 笔误

**Files:**
- Modify: `tools/push-via-api.mjs:49`

- [ ] **Step 1: 修正笔误**

第 42 行是正确写法 `maxBuffer: 64 * 1024 * 1024`，第 49 行是 `64 * 1024 * 10264`。把第 49 行改为：

```js
    { input: JSON.stringify(payload), maxBuffer: 64 * 1024 * 1024 },
```

- [ ] **Step 2: 语法验证**

Run: `node --check tools/push-via-api.mjs`
Expected: 无输出（退出码 0）

- [ ] **Step 3: Commit**

```bash
git add tools/push-via-api.mjs
git commit -m "fix(tools): 修正 push-via-api.mjs 的 maxBuffer 笔误（10264 → 1024）"
```

---

## Task 2: Redis 加密码（compose + 两份 .env.example）

**Files:**
- Modify: `infra/docker-compose.yml:25-39`（redis 服务）、`infra/docker-compose.yml:99`（api 的 REDIS_URL）
- Modify: `infra/.env.example`（Redis 段）
- Modify: `api/.env.example`（REDIS_URL 段）

- [ ] **Step 1: infra/.env.example 补 REDIS_PASSWORD**

Redis 段（现仅 `REDIS_PORT=16380` 一行）改为：

```bash
# Redis
REDIS_PORT=16380
# 队列密码。compose 里的 redis 与 api 连接串都引用它；不复制 .env 时用下面的默认值。
# ⚠️ 只用字母与数字：密码会拼进 redis:// URL，特殊字符需要额外转义。
REDIS_PASSWORD=ecommerceRedis163
```

- [ ] **Step 2: compose 的 redis 服务加 requirepass**

`redis` 服务的 `command`（现第 29 行）与 `healthcheck` 改为：

```yaml
    command: redis-server --appendonly yes --requirepass ${REDIS_PASSWORD:-ecommerce-redis}
    environment:
      # healthcheck 的 redis-cli 要用同一把密码（容器内读，$$ 是 compose 转义）
      REDIS_PASSWORD: ${REDIS_PASSWORD:-ecommerce-redis}
```

`healthcheck.test` 改为：

```yaml
      test: ['CMD-SHELL', 'redis-cli -a "$$REDIS_PASSWORD" ping | grep PONG']
```

- [ ] **Step 3: compose 的 api 连接串带上密码**

api 服务的 `REDIS_URL`（现第 99 行 `REDIS_URL: redis://redis:6379`）改为：

```yaml
      REDIS_URL: redis://:${REDIS_PASSWORD:-ecommerce-redis}@redis:6379
```

- [ ] **Step 4: api/.env.example 更新本机开发的 REDIS_URL**

Redis 段（`REDIS_URL=redis://localhost:16380`）改为——**不硬编码密码**，
`<REDIS_PASSWORD 的值>` 取 Step 1 写入 `infra/.env.example` 的那个值（单一事实来源）：

```bash
# Redis（BullMQ 队列）。宿主机端口 16380：本机标准端口 6379 已被其他项目栈占用。
# 容器内的 api 服务由 compose 覆盖成带密码的服务名地址。
# ⚠️ 密码必须与 infra/.env 的 REDIS_PASSWORD 一致（阶段 7a 起 redis 开了 requirepass），
#    两边只维护 infra/.env 一处。
REDIS_URL=redis://:<REDIS_PASSWORD 的值>@localhost:16380
```

- [ ] **Step 5: 既有 api/.env 同步（本机文件，不在 git 里）**

若本机存在 `api/.env`，把其中 `REDIS_URL` 同样改成 `redis://:<REDIS_PASSWORD 的值>@localhost:16380`
（值同 `infra/.env`）。`infra/.env`（若存在）追加 `REDIS_PASSWORD=<Step 1 的值>`。

- [ ] **Step 6: 验证**

Run: `cd infra && docker compose config --quiet && echo OK`
Expected: `OK`（无未定义变量警告）

Run（redis 起来后验密码真的生效）:
```bash
cd infra && docker compose up -d redis --wait
docker compose exec redis sh -c 'redis-cli -a "$REDIS_PASSWORD" ping'   # 预期 PONG
docker compose exec redis redis-cli ping                                 # 预期 NOAUTH（不带密码被拒）
```

Run（api 队列真的能通——用 health 端点，它探 redis）:
```bash
curl -s http://localhost:3000/api/v1/health
```
Expected: 响应里 redis 探针为通过状态（若 api 未起，先 `docker compose up -d api --wait`）。

- [ ] **Step 7: Commit**

```bash
git add infra/docker-compose.yml infra/.env.example api/.env.example
git commit -m "feat(infra): redis 加 requirepass，api 连接串与两份 env 示例同步"
```

---

## Task 3: api 与 MinIO 控制台端口绑 127.0.0.1 + 密钥引用化

**Files:**
- Modify: `infra/docker-compose.yml:96-97`（DATABASE_URL ×2）、`:112`（PAYOUT_ACCOUNT_ENCRYPTION_KEY）、`:143`（api ports）、`:66`（minio console ports）
- Modify: `infra/.env.example`（补 PAYOUT_ACCOUNT_ENCRYPTION_KEY）

- [ ] **Step 1: DATABASE_URL 引用化，fallback 与 postgres 服务声明对齐**

api 服务 environment 里两行（96-97 行，现含与 `.env` 脱节的内联密码 fallback）整行替换为：

```yaml
      DATABASE_URL: postgresql://${POSTGRES_USER:-ecommerce}:${POSTGRES_PASSWORD:-ecommerce}@postgres:5432/${POSTGRES_DB:-ecommerce}?schema=public
      DATABASE_URL_TEST: postgresql://${POSTGRES_USER:-ecommerce}:${POSTGRES_PASSWORD:-ecommerce}@postgres:5432/ecommerce_test?schema=public
```

> 与 postgres 服务（第 7-9 行）的 `${VAR:-ecommerce}` 声明逐字一致，从此改 `.env` 一处生效。

- [ ] **Step 2: PAYOUT_ACCOUNT_ENCRYPTION_KEY 改为可覆盖**

api 服务里现第 112 行 `PAYOUT_ACCOUNT_ENCRYPTION_KEY: <固定值>` 改为（**保留现有固定值作为 fallback，仅加变量壳**）：

```yaml
      PAYOUT_ACCOUNT_ENCRYPTION_KEY: ${PAYOUT_ACCOUNT_ENCRYPTION_KEY:-<现有固定值原样保留>}
```

同时在 `infra/.env.example` 末尾补：

```bash
# 出款账户与账单快照的字段加密密钥（≥ 32 字符，且不得与 POSTGRES_PASSWORD 等占位符同值）。
# ⚠️ 与 compose 内置 fallback 保持一致（本机开发固定值）；
#    真实部署从这里注入随机密钥。轮换会导致既有快照解不开。
# PAYOUT_ACCOUNT_ENCRYPTION_KEY=
```

`JWT_SECRET` 与三端 `AUTH_SECRET` **不动**（设计文档明确排除）。

- [ ] **Step 3: 端口绑定 127.0.0.1**

api 的 ports（现 143 行）：

```yaml
    ports:
      - '127.0.0.1:${API_PORT:-3000}:3000'
```

minio 的 console 端口（现 66 行；API 端口 19000 **保持不动**——浏览器直传要访问它）：

```yaml
      - '127.0.0.1:${MINIO_CONSOLE_PORT:-19001}:9001'
```

- [ ] **Step 4: 验证**

Run: `cd infra && docker compose config --quiet && echo OK`
Expected: `OK`

Run:
```bash
cd infra && docker compose up -d api minio --wait
ss -tlnp | grep -E '3000|19001'
```
Expected: `127.0.0.1:3000` 与 `127.0.0.1:19001`（不再是 `0.0.0.0`/`*`）；`19000` 仍为全网卡。

Run（api 连库仍通）:
```bash
curl -s http://localhost:3000/api/v1/health
```
Expected: health 通过（DATABASE_URL 改造后连接不回归）。

- [ ] **Step 5: Commit**

```bash
git add infra/docker-compose.yml infra/.env.example
git commit -m "feat(infra): api/minio-console 端口绑定回环，DATABASE_URL 与账单密钥改引用 .env"
```

---

## Task 4: 日志轮转 anchor + 每服务 mem_limit

**Files:**
- Modify: `infra/docker-compose.yml`（顶层 anchor + 8 个服务）

- [ ] **Step 1: 文件顶部（`services:` 之前）加 anchor**

```yaml
x-logging: &default-logging
  driver: json-file
  options:
    max-size: '10m'
    max-file: '3'
```

- [ ] **Step 2: 每个服务加 `logging` 与 `mem_limit`**

8 个服务（postgres / redis / minio / api / storefront / merchant-admin / platform-admin / nginx）各自追加（缩进与服务名同级属性一致）：

```yaml
    logging: *default-logging
    mem_limit: <按下表>
```

| 服务 | mem_limit |
|------|-----------|
| postgres / api / minio | 1g |
| storefront / merchant-admin / platform-admin | 512m |
| redis / nginx | 256m |

- [ ] **Step 3: 验证**

Run: `cd infra && docker compose config 2>&1 | grep -c mem_limit`
Expected: `8`

Run:
```bash
cd infra && docker compose up -d --wait && docker compose ps --format '{{.Name}} {{.Status}}'
```
Expected: 8 个服务全部 `(healthy)` 或 `Up`。

- [ ] **Step 4: Commit**

```bash
git add infra/docker-compose.yml
git commit -m "feat(infra): compose 统一日志轮转（10m×3）并给各服务加内存上限"
```

---

## Task 5: 前端容器 healthcheck + nginx depends_on 条件

**Files:**
- Modify: `infra/docker-compose.yml:155-205`（三个前端服务）、`:207-219`（nginx）

- [ ] **Step 1: 三个前端服务各加 healthcheck**（standalone 产物运行阶段有 node，与 api 同风格探活）

```yaml
    healthcheck:
      test:
        - CMD-SHELL
        - node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 20s
```

- [ ] **Step 2: nginx 的 depends_on 改映射形式**

```yaml
    depends_on:
      api:
        condition: service_healthy
      storefront:
        condition: service_healthy
      merchant-admin:
        condition: service_healthy
      platform-admin:
        condition: service_healthy
```

- [ ] **Step 3: 验证**

Run: `cd infra && docker compose up -d --wait && docker compose ps --format '{{.Name}} {{.Status}}'`
Expected: 三个前端容器出现 `(healthy)`；`docker compose ps nginx` 状态正常。

- [ ] **Step 4: Commit**

```bash
git add infra/docker-compose.yml
git commit -m "feat(infra): 前端容器补 healthcheck，nginx 等到依赖 healthy 再起"
```

---

## Task 6: Nginx 收口（gzip / body 上限 / 超时 / 安全头 / default server）

**Files:**
- Modify: `infra/nginx/platform.test.conf`

- [ ] **Step 1: 在四个 upstream 定义之后、第一个 server 之前插入全局段**

```nginx
# ---- 阶段 7a 收口 ----
# 常规响应压缩（html 内置在 gzip_types 之外也会压，这里补静态资源类型）
gzip on;
gzip_types text/css application/javascript application/json image/svg+xml;
gzip_min_length 1024;

# 请求体上限（上传走 MinIO presigned 直传，不经网关；10m 兜底防误用）
client_max_body_size 10m;

# 反代读超时显式化（与 nginx 默认一致，防止有人「顺手」调大）
proxy_read_timeout 60s;

# 全站安全响应头（location 内没有自己的 add_header，继承这里的）
add_header X-Frame-Options SAMEORIGIN always;
add_header X-Content-Type-Options nosniff always;
add_header Referrer-Policy strict-origin-when-cross-origin always;

# 未知 Host 一律断连（不给扫描器任何回音，也不落进 storefront）
server {
    listen 80 default_server;
    server_name _;
    return 444;
}
```

- [ ] **Step 2: 验证**

Run: `docker compose -f infra/docker-compose.yml exec nginx nginx -t`
Expected: `syntax is ok` / `test is successful`

Run:
```bash
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: unknown.host.test' http://localhost/
curl -sI -H 'Host: demo.platform.test' http://localhost/ | grep -iE 'x-frame|x-content|referrer'
```
Expected: 第一条 `000`（444 断连）；第二条出现三个安全头。

Run（回归：正常店铺与 API 路由仍通）:
```bash
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: demo.platform.test' http://localhost/
curl -s -o /dev/null -w '%{http_code}\n' http://localhost/api/v1/health
```
Expected: `200` 两条。

- [ ] **Step 3: Commit**

```bash
git add infra/nginx/platform.test.conf
git commit -m "feat(infra): nginx 补 gzip/body 上限/超时/安全头与 default server 444"
```

---

## Task 7: 备份脚本 + README 说明

**Files:**
- Create: `infra/backup.sh`
- Modify: `README.md`（「数据库迁移」节之后加备份说明）

- [ ] **Step 1: 写 `infra/backup.sh`**（注意 compose 项目名来自中文目录名，卷名动态查，不硬编码）

```bash
#!/usr/bin/env bash
# 数据备份：PostgreSQL 全库 + MinIO 数据卷，落到 ./backups/<时间戳>/。
# 用法：cd infra && ./backup.sh
# 定时：crontab 里加 `0 3 * * * cd /path/to/电商项目/infra && ./backup.sh >> backup.log 2>&1`
# 恢复：postgres 用 `gunzip -c <文件> | docker compose exec -T postgres psql -U ecommerce <db>`；
#       minio 用 `tar xzf <文件> -C <挂载点>`（先停 minio 容器）。
set -euo pipefail
cd "$(dirname "$0")"

BACKUP_DIR="${BACKUP_DIR:-./backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$BACKUP_DIR/$STAMP"
mkdir -p "$DEST"

# 读 .env（存在才读），与 compose 的默认值保持一致
if [ -f .env ]; then
  # shellcheck disable=SC1091
  set -a; source .env; set +a
fi
PG_USER="${POSTGRES_USER:-ecommerce}"
PG_DB="${POSTGRES_DB:-ecommerce}"

# 1) PostgreSQL 逻辑备份（pg_dump 版本与容器一致，直接用服务内执行）
echo "[backup] postgres: $PG_DB"
docker compose exec -T postgres pg_dump -U "$PG_USER" "$PG_DB" \
  | gzip > "$DEST/postgres-$PG_DB.sql.gz"

# 2) MinIO 数据卷冷备（项目名含中文目录名，卷名动态查，不硬编码）
MINIO_VOL="$(docker volume ls --format '{{.Name}}' | grep -E 'minio-data$' | head -n1)"
if [ -z "$MINIO_VOL" ]; then
  echo "[backup] 找不到 minio-data 卷，跳过 MinIO 备份" >&2
else
  echo "[backup] minio volume: $MINIO_VOL"
  docker run --rm \
    -v "$MINIO_VOL":/data:ro \
    -v "$(cd "$DEST" && pwd)":/backup \
    alpine tar czf "/backup/minio-data.tgz" -C /data .
fi

echo "[backup] 完成 → $DEST"
ls -lh "$DEST"
```

- [ ] **Step 2: 赋可执行权限 + shellcheck**

Run: `chmod +x infra/backup.sh && shellcheck infra/backup.sh`
Expected: 无输出（若本机无 shellcheck 则跳过，注明即可）

- [ ] **Step 3: 真跑一次验证**

Run: `cd infra && ./backup.sh`
Expected: `backups/<时间戳>/` 下出现非空的 `postgres-ecommerce.sql.gz` 与 `minio-data.tgz`（MinIO 卷存在时）。

- [ ] **Step 4: README 补备份说明**（「### 数据库迁移」节末尾追加）

```markdown
### 数据备份

```bash
cd infra && ./backup.sh    # PostgreSQL 全库 + MinIO 数据卷 → infra/backups/<时间戳>/
```

定时备份挂 crontab（示例为每天 03:00）：

```
0 3 * * * cd /path/to/电商项目/infra && ./backup.sh >> backup.log 2>&1
```

`infra/backups/` 已加入 `.gitignore`；恢复命令见 `infra/backup.sh` 头部注释。
```

同时把 `infra/backups/` 写进 `.gitignore`（若根 `.gitignore` 存在则追加一行 `infra/backups/`，不存在则连同上面补的内容一起放 `infra/.gitignore`）。

- [ ] **Step 5: Commit**

```bash
git add infra/backup.sh README.md .gitignore infra/.gitignore
git commit -m "feat(infra): 数据备份脚本（postgres + minio 卷）与 README 说明"
```

---

## Task 8: GitHub Actions CI

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: 写 workflow**（四个 job；api 起 postgres/redis service 容器；e2e 首期不进 CI——设计文档 §3.1 已说明）

```yaml
name: CI

on:
  push:
  pull_request:

jobs:
  api:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: ecommerce
          POSTGRES_PASSWORD: ecommerce
          POSTGRES_DB: ecommerce
        ports:
          - 15432:5432
        options: >-
          --health-cmd "pg_isready -U ecommerce"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 20
      redis:
        image: redis:7-alpine
        ports:
          - 16380:6379
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 5s
          --health-timeout 3s
          --health-retries 10
    env:
      DATABASE_URL: postgresql://ecommerce:ecommerce@localhost:15432/ecommerce?schema=public
      DATABASE_URL_TEST: postgresql://ecommerce:ecommerce@localhost:15432/ecommerce_test?schema=public
      REDIS_URL: redis://localhost:16380
      JWT_SECRET: ci-only-jwt-secret-0123456789abcdef
      PAYOUT_ACCOUNT_ENCRYPTION_KEY: ci-only-payout-encryption-key-0123456789
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: api/package-lock.json
      - name: Install pg_trgm (迁移需要，service 容器无 init SQL)
        run: docker exec ${{ job.services.postgres.id }} psql -U ecommerce -d ecommerce -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm;'
      - run: npm ci
        working-directory: api
      - run: npx prisma generate
        working-directory: api
      - run: npm test
        working-directory: api

  storefront:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: storefront/package-lock.json
      - run: npm ci
        working-directory: storefront
      - run: npx tsc --noEmit
        working-directory: storefront
      - run: npm test
        working-directory: storefront
      - run: npm run build
        working-directory: storefront
        env:
          NEXT_PUBLIC_TENANT_SUBDOMAIN: demo

  merchant-admin:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: merchant-admin/package-lock.json
      - run: npm ci
        working-directory: merchant-admin
      - run: npx tsc --noEmit
        working-directory: merchant-admin
      - run: npm test
        working-directory: merchant-admin
      - run: npm run build
        working-directory: merchant-admin

  platform-admin:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: platform-admin/package-lock.json
      - run: npm ci
        working-directory: platform-admin
      - run: npx tsc --noEmit
        working-directory: platform-admin
      - run: npm test
        working-directory: platform-admin
      - run: npm run build
        working-directory: platform-admin
```

- [ ] **Step 2: 本地可验证部分先过一遍**

Run: `node -e "const y=require('js-yaml');y.load(require('fs').readFileSync('.github/workflows/ci.yml','utf8'));console.log('YAML OK')"`（若无 js-yaml 则用 `npx --yes js-yaml .github/workflows/ci.yml`）
Expected: YAML 可解析。

注意：单测的环境需求无法在本地穷尽（`setup-unit-env.ts` 可能还要别的变量），
**首跑若报缺变量，按报错信息补进 api job 的 `env`，这是预期内的迭代**。

- [ ] **Step 4: README 写明 e2e 不进 CI**（「## 测试」节末尾追加）

```markdown
> CI（`.github/workflows/ci.yml`）只跑单测 + 构建检查；e2e（657 条串行）仍在
> 本地跑（`npm run test:e2e`），首期不进 CI——云端跑一遍要完整迁移 + seed，
> 时长远超单测，收益不匹配。
```

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml README.md
git commit -m "ci: GitHub Actions 四 job（api 单测 + 三端 tsc/test/build），e2e 暂不进 CI"
```

---

## Task 9: 推送验证 CI + 全量回归 + 验收记录

**Files:**
- Create: `docs/superpowers/plans/2026-11-03-plan-07a-acceptance.md`

- [ ] **Step 1: 推分支触发 CI**（⚠️ 推送到远端是可见操作，执行前向用户确认一次）

```bash
export GH_TOKEN=$(gh auth token)
node tools/push-via-api.mjs plan-07a-engineering-hardening plan-07a-engineering-hardening
```

- [ ] **Step 2: 观察 CI run**

Run: `gh run list --limit 3`（本机网络不可达时改走 `gh api repos/gztcode/multi-tenant-ecommerce-saas/actions/runs?per_page=3`）
Expected: 新 run 出现；各 job 结果记录进验收文档。若 Actions 触发失败（网络/权限），在验收文档记录现象与待办，不影响本地交付。

- [ ] **Step 3: 本地全量回归**（部署形态 + 测试形态各一遍）

```bash
cd infra && docker compose up -d --wait && docker compose ps   # 8 服务 healthy
cd api && npm test          # 886 条单测（注意 .env 的 REDIS_URL 已带密码）
cd api && npm run test:e2e  # 657 条 e2e
```
Expected: 全绿。任何红先排查是否 Task 2/3 的环境改动引起（尤其 REDIS_URL 密码）。

- [ ] **Step 4: 写验收记录**

按项目验收文档惯例（参照 `2026-11-02-plan-06-acceptance.md` 的结构）写
`docs/superpowers/plans/2026-11-03-plan-07a-acceptance.md`，必含：
①交付范围与各 commit 对应关系；②CI run 的真实结果（或不可达的待办记录）；
③`docker compose ps` 全 healthy 的证据；④备份脚本真跑产物清单；
⑤失败注入不适用（纯 infra，无代码分支可注入），以「回归命令 + 输出」代替。

- [ ] **Step 5: Commit 验收文档，收尾 PR**

```bash
git add docs/superpowers/plans/2026-11-03-plan-07a-acceptance.md
git commit -m "docs: 阶段 7a 验收记录"
```

PR 创建同样走 API（`gh pr create` 在本机网络受限时改用 `tools/push-via-api.mjs` 同源的 API 方式，或按既往惯例处理）。
