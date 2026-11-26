# 生产部署指南（阶段 11）

本仓库的 compose 形态此前是「本机开发形态」（HTTP、回环端口、固定密钥）。
本文档把它变成一份**可对外服务的最小生产部署**：TLS、真实域名、密钥治理、
迁移策略、备份与升级流程。

> **范围声明**：这是单机部署（一台服务器 + compose）。多副本、HA、
> secret manager、CDN 属于规模化改造，见
> [待办与技术债](requirements/backlog.md)。

---

## 0. 前置条件

| 项 | 要求 |
|------|------|
| 服务器 | 2C4G 起步（api 1g + 三个前端各 512m + postgres 1g + minio 1g + redis 256m + nginx 256m） |
| 域名 | 一个基准域（下文以 `example.com` 为例），可加泛域名解析 |
| DNS | 域名托管在支持 API 的 DNS 服务商（阿里云/DNSPod/Cloudflare），泛域名证书要用 DNS-01 |
| Docker | Docker 24+ 与 compose v2 插件 |
| 端口 | 服务器安全组放行 80/443；**其余端口一律不对公网开放** |

## 1. DNS 解析

| 记录 | 类型 | 值 | 用途 |
|------|------|------|------|
| `*.example.com` | A | 服务器 IP | 店铺前台（`<tenant>.example.com`） |
| `example.com` | A | 服务器 IP | **不承载业务**：nginx 显式拒绝（http/https 都是 444 断连），仅用于完成 TLS 握手 |
| `api.example.com` | A | 服务器 IP | API（支付渠道回调指向这里） |
| `merchant.example.com` | A | 服务器 IP | 商家后台 |
| `admin.example.com` | A | 服务器 IP | 平台超管后台 |

> 裸根域名 `example.com` **不是入口**：店铺在 `<tenant>.example.com`，三个后台
> 各有中心域名。nginx 模板里它有自己的 `server` 块，明确 `return 444`（不跳转、
> 不代理），与「未知 Host 一律断连」同一口径。之所以仍保留 A 记录与证书覆盖，
> 是为了让 `https://example.com` 能**完成握手后再明确断连**，而不是解析失败或
> 先报证书错误（见 §2）。

> 如果嫌 5 条记录麻烦：`*.example.com` 一条泛解析可以同时覆盖
> 店铺子域名与三个中心域名（nginx 的 server_name 已按域区分）。裸根域名那条
> 可以不加，但那样 `example.com` 会直接 DNS 解析失败，而不是走到 nginx 的显式拒绝。

> **IPv6**：上表只有 A 记录 —— 能解析到服务器的**只有 IPv4**。网关本身是
> **双栈监听**（每个 server 块同时 `listen` IPv4 与 `[::]`，80 / 443 的兜底
> `default_server` 两个地址族各一份），所以要让 IPv6 客户端也访问，只需给同
> 一批名字补上同值的 **AAAA 记录**（泛解析同理：`*.example.com` 一条 AAAA
> 覆盖店铺与三个中心域名）。
>
> 补了 AAAA 之后，IPv6 上的行为与 IPv4 **逐条一致**：未知 Host 与裸根域名
> 444 断连，合法店铺 Host 正常转发，`[::]:443` 同样是完成 TLS 握手后再拒绝。
> 不补 AAAA 也不算故障：IPv6-only 客户端会解析不到地址（DNS 层就没有 AAAA），
> 而不是连到一个只认 IPv4 的网关。

## 2. 证书（泛域名，DNS-01）

`infra/nginx/templates/prod.conf.template` 使用一张覆盖
`example.com` + `*.example.com` 的证书，签发方式必须用 **DNS-01**。

> 为什么要带裸 `example.com`：它不承载业务，但 nginx 的根域块要**完成 TLS
> 握手后再 444 断连**（见模板注释）。证书不覆盖它，访问 `https://example.com`
> 会先看到证书错误，而不是明确的拒绝。

```bash
# 以 certbot + DNSPod 插件为例（阿里云用 certbot-dns-aliyun，Cloudflare 用内置 dns-cloudflare）
sudo certbot certonly \
  --authenticator dns-dnspod \
  --dns-dnspod-credentials /etc/letsencrypt/dnspod.ini \
  -d "example.com" -d "*.example.com" \
  --agree-tos -m ops@example.com
```

把产物复制/挂载到 `infra/certs/`（compose.prod 已挂到容器的
`/etc/nginx/certs/`）：

```bash
mkdir -p infra/certs
sudo cp /etc/letsencrypt/live/example.com/fullchain.pem infra/certs/
sudo cp /etc/letsencrypt/live/example.com/privkey.pem  infra/certs/
```

**续期**：泛域名证书 90 天有效。用 cron 每月重签 + 拷贝 + reload：

```cron
0 4 1 * * certbot certonly --authenticator dns-dnspod --dns-dnspod-credentials /etc/letsencrypt/dnspod.ini -d "example.com" -d "*.example.com" --deploy-hook "cp /etc/letsencrypt/live/example.com/*.pem /path/to/repo/infra/certs/ && docker compose -f /path/to/repo/infra/docker-compose.yml -f /path/to/repo/infra/docker-compose.prod.yml exec nginx nginx -s reload"
```

> 也可以完全不用 certbot 容器：本机 certbot + webroot 已在 nginx 模板里
> 留了 `/.well-known/acme-challenge/` 的路由（挂载 `certbot-www` 卷），
> 但 http-01 签不了泛域名，只适合中心域名逐个签。

## 3. 密钥与配置

```bash
cd infra
cp .env.example .env
```

`.env` 生产必改项（**全部会被 api 的启动守卫校验，占位符原样上线 = 拒绝启动**）：

```bash
# 随机密钥（三把必须互不相同）
JWT_SECRET=$(openssl rand -base64 48)
AUTH_SECRET=$(openssl rand -base64 48)
PAYOUT_ACCOUNT_ENCRYPTION_KEY=$(openssl rand -base64 48)

# 数据服务凭据
POSTGRES_PASSWORD=...       # openssl rand -hex 16
REDIS_PASSWORD=...          # 仅字母数字（拼进 redis:// URL）
MINIO_ROOT_USER=...         # ≥8 字符
MINIO_ROOT_PASSWORD=...     # ≥40 字符

# 生产标识
BASE_DOMAIN=example.com
BIND_HOST=0.0.0.0           # nginx 80/443 才对外

# CORS（MinIO 直传）：写店铺与后台的真实来源
MINIO_API_CORS_ALLOW_ORIGIN=https://example.com,https://merchant.example.com,https://admin.example.com
MINIO_PUBLIC_URL=https://minio.example.com   # 若不单独暴露 minio 域名，见 §6 媒体

# 可观测性（阶段 11）
LOG_LEVEL=info
ALERT_WEBHOOK_URL=...       # 飞书/钉钉机器人地址（强烈建议配）
```

以下两项**不属于**启动守卫校验项（守卫不校验、留空也能起），但影响生产暴露面：

```bash
# Prometheus 抓取端点（/api/v1/metrics）的可信网段，逗号分隔的 IPv4 地址/CIDR。
# ⚠️ **不配 = 一个都不放行**（fail-closed）→ 抓取全部 403，
#    监控瞎掉但服务照常跑。抓取端在容器网/内网时配上它：
# METRICS_ALLOW_CIDR=10.0.0.0/8,192.168.1.0/24
#
# ⚠️ **只接受 IPv4**：IPv6 条目（如 2001:db8::/32）一律跳过并打日志 ——
#    IPv6 的形状校验挡不住 `deadbeef`、`::` 这类 nginx 不认的写法。
#
# 写错的条目（如 10.0.0.0/33）会被**跳过并在 nginx 日志里点名**，
# 不会写进配置 —— 一条非法 allow 语句会让 nginx 启动失败（整站不可用），
# 那比「少放行一个网段」严重得多。
#
# Swagger UI（/api/docs）：生产**默认关闭**（NODE_ENV=production 时不挂载）。
# 需要临时开放给同事看接口时设 true，**用完记得改回**：
# SWAGGER_ENABLED=true
```

网关限流阈值（同样是**不配也能起**、只影响限流强度；变量名、单位、
默认值与校准方法见 §9）：

```bash
RATE_LIMIT_FRONT_RATE=20    # 每秒请求数，三个前端入口共用
RATE_LIMIT_FRONT_BURST=100  # 突发队列长度
RATE_LIMIT_API_RATE=20
RATE_LIMIT_API_BURST=40
RATE_LIMIT_AUTH_RATE=10     # api 的 /api/v1/auth/，从紧
RATE_LIMIT_AUTH_BURST=20
```

> `PAYOUT_ACCOUNT_ENCRYPTION_KEY` 一旦投入生产**不能轮换**——
> 轮换后已打款的出款单快照永久解不开（守卫与[开发指南](development.md)都有警告）。

## 4. 首次部署

```bash
cd infra
docker compose -f docker-compose.yml -f docker-compose.prod.yml build

# 1) 先起数据层
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d postgres redis minio

# 2) 迁移先行（builder 镜像里带 prisma CLI）
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile tools run --rm migrate

# 3) 起应用层
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# 4) 种子（仅首次；生产超管密码用环境变量方式生成，别用 seed 默认值）
#    见 §8「seed 与生产超管」
```

验证清单：

```bash
curl -f https://api.example.com/api/v1/health          # {"status":"ok",...}
curl -f https://api.example.com/api/v1/metrics | head  # Prometheus 指标（默认 403，见下）
curl -sI https://api.example.com/api/v1/health | grep -i strict  # HSTS 头存在
# 裸根域名不承载业务：http/https 都是「握手后断连」（444），拿不到状态行
curl -s -o /dev/null -w 'https %{http_code}\n' https://example.com  # https 000（连接被断开）
curl -s -o /dev/null -w 'http  %{http_code}\n' http://example.com   # http  000（同上，不 301）

# IPv6 双栈（在服务器本机执行；[::1] 指本机回环，绕过 DNS 与 AAAA）
curl -s -o /dev/null -w 'v6 http  %{http_code}\n' -g -6 -H 'Host: example.com' 'http://[::1]/'                 # 000
curl -s -o /dev/null -w 'v6 https %{http_code}\n' -g -6 -k --resolve example.com:443:[::1] https://example.com/ # 000
curl -s -o /dev/null -w 'v6 api   %{http_code}\n' -g -6 -k --resolve api.example.com:443:[::1] https://api.example.com/api/v1/health  # 200
```

> IPv6 那三条必须带 `-g -6` 和 `--resolve`（或 `-H 'Host: ...'`）：容器的
> `/etc/hosts` 只有 IPv4 映射，直接用域名测会走 DNS 并可能拿到 `::1`，
> 让你分不清测的是哪个地址族。`--resolve` 同时注入 SNI，https 才能选中正确的块。

> ⚠️ **`/api/v1/metrics` 生产默认对公网 403**：nginx 模板里该路径是
> `deny all`，只有 `METRICS_ALLOW_CIDR` 列出的网段能抓（见 §3、§9）。
> 所以上面那条 curl 从公网跑**预期是 403**（`curl -f` 会因此报失败）；
> 要验证抓取通不通，得从白名单网段内的机器跑，或临时把该机的公网 IP
> 加进 `METRICS_ALLOW_CIDR` 后 `docker compose ... up -d nginx` 重载。
>
> 同样地，`/api/docs`（Swagger UI）生产默认**不可达**（404），
> 需要看文档时在 `infra/.env` 里设 `SWAGGER_ENABLED=true` 并重启 api。

## 5. 数据库加固

compose 的 `init-tuning.sh` 只在**数据卷首次创建**时执行
（`statement_timeout = 8s`，防单租户慢查询拖垮共享库）。
已有数据库手动补：

```bash
docker compose exec postgres psql -U ecommerce -d ecommerce \
  -c "ALTER DATABASE ecommerce SET statement_timeout = '8s';"
```

托管数据库（RDS/Cloud SQL）上还需 DBA 先装扩展（应用账号通常无权限）：

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

## 6. 媒体（MinIO）的暴露方式

presigned 直传要求浏览器能访问 MinIO endpoint，二选一：

1. **推荐：Nginx 加一个 minio 域名**——在
   `infra/nginx/templates/prod.conf.template` 复制一个
   `minio.example.com` server 块反代 `minio:9000`（大文件走
   `client_max_body_size 0`），`MINIO_PUBLIC_URL=https://minio.example.com`；
2. 或保持 compose 的回环端口映射 + 只读代理——不适合生产，不推荐。

> 无论哪种，`MINIO_ENDPOINT`（签进 presigned URL 的地址）必须是
> 浏览器可达地址，`MINIO_INTERNAL_ENDPOINT` 保持 `http://minio:9000`。

## 7. 升级与回滚

```bash
# 升级（迁移先行、应用后滚）
cd /path/to/repo && git pull
cd infra
docker compose -f docker-compose.yml -f docker-compose.prod.yml build
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile tools run --rm migrate
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# 回滚
git checkout <上一个 tag>
docker compose -f docker-compose.yml -f docker-compose.prod.yml build
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
# ⚠️ 破坏性迁移（删列/改类型）无法用「重跑旧迁移」回滚——
#    升级前先备份：./backup.sh，回滚时 ./restore.sh postgres <归档> --yes
```

**破坏性迁移的双阶段流程**：N 版应用兼容 N-1 库结构 → 上线 N（含加列）→
观察期 → N+1 的迁移再删旧列。本项目至今的迁移均为加列/加索引类，
遇到第一个破坏性迁移时按此流程走并在迁移注释里声明兼容窗口。

## 8. seed 与生产超管

seed 脚本造的是演示数据（`admin@platform.test` / 密码固定），**生产不要跑
`prisma:seed` 的演示部分**。建议首次部署后手工建平台超管：

```bash
docker compose exec postgres psql -U ecommerce -d ecommerce -c "\x" -c "
-- 生产超管：先在容器里用 node 生成 argon2 哈希，或临时起 api 的 builder 容器执行：
-- docker compose --profile tools run --rm migrate node -e \"
--   const a = require('argon2');
--   a.hash(process.argv[1]).then(console.log) 'YourStrongPassword!\"
-- "
INSERT INTO users (id, \"tenantId\", email, \"displayName\", \"passwordHash\", role)
VALUES (gen_random_uuid()::text, NULL, 'ops@example.com', 'Platform Ops', '<argon2-hash>', 'PLATFORM_ADMIN');
"
```

然后立即用该账号登录 `admin.example.com` 改密，并**禁用/删除**
seed 产生的演示账号（若曾误跑 seed）。

## 9. 可观测性接入

- **抓取**：Prometheus 抓 `https://api.example.com/api/v1/metrics`。
  该路径在生产 nginx 模板里**默认 `deny all`**（对公网 403），只有
  `METRICS_ALLOW_CIDR` 列出的可信网段能访问 —— 变量在 `infra/.env` 里配，
  逗号分隔多个 **IPv4** 地址/CIDR（如 `10.0.0.0/8,192.168.1.0/24`），
  部署时由 `infra/nginx/render-metrics-allow.sh` 展开成 nginx 的 allow 语句。
  **不配 = 一个都不放行**（fail-closed）：抓不到指标，但不会误放行到公网。
  改了变量要重启 nginx 容器才生效（`docker compose ... up -d nginx`）。
  写错的条目会被跳过并在 nginx 日志里点名（`render-metrics-allow: 跳过非法条目：…`），
  不会让 nginx 启动失败。**IPv6 条目（含合法网段）同样被跳过** ——
  当前只放行 IPv4，见脚本头部注释。
  指标清单：`ecommerce_http_requests_total` / `..._duration_seconds`、
  `ecommerce_queue_jobs`、`ecommerce_payments_refunding_stuck`、
  `ecommerce_payouts_processing_stuck` + 进程指标。
- **网关限流（P2-3 / P3-2）**：限流在 **Nginx 层**按客户端 IP
  （`$binary_remote_addr`，即与本机建 TCP 连接的对端地址）计，不放进程内
  ——多副本下进程内计数器各算各的，等于没有限流。
  - 被限流的 location（这才是真实流量那一跳：浏览器 → 同源 BFF →
    Next.js 服务端 → api 容器，BFF 调 api 不过 Nginx）：
    | 入口 | location | zone |
    |------|----------|------|
    | 店铺前台（`<tenant>.example.com`）页面 / RSC / BFF 中转 | `location /` | `front_general` |
    | 商家后台 `merchant.example.com` | `location /` | `front_general` |
    | 平台超管 `admin.example.com` | `location /` | `front_general` |
    | 店铺子域名直连 api（绕过 BFF 的脚本） | `location /api/v1/` | `api_general` |
    | api 中心域名其余路径 | `location /` | `api_general` |
    | api 中心域名认证端点 | `location /api/v1/auth/` | `api_auth` |
  - **豁免**：`/api/v1/webhooks/`（支付/订阅渠道回调）在两个入口都单独
    路由且**不限流**。渠道把非 2xx 当投递失败会重投并告警，而回调高峰
    （大促集中支付）正是限流最容易误伤的时段；它们的安全边界在 api 侧
    （验签 + `(provider, eventId)` 唯一索引幂等），不靠 IP 限流。
  - **拒绝码是 429 + `Retry-After: 1`**（不是 503）：503 会被客户端当成
    「服务故障」而重试，反而放大压力；429 的语义是「你太快了」。
  - 阈值**可配**，六个变量（单位分别是**每秒请求数**与**突发队列长度**）：

    | 变量 | 默认值 | 含义 |
    |------|--------|------|
    | `RATE_LIMIT_FRONT_RATE` / `_BURST` | 20 r/s / 100 | 三个前端入口共用一份预算 |
    | `RATE_LIMIT_API_RATE` / `_BURST` | 20 r/s / 40 | 直连 api 的 `/api/v1` |
    | `RATE_LIMIT_AUTH_RATE` / `_BURST` | 10 r/s / 20 | `/api/v1/auth/`（从紧） |

    ⚠️ **默认值是保守占位，上线前必须按真实访问日志校准**（下面给方法）。
    不配 = 用默认值；配错（非数字、超过 6 位、rate 为 0）= 回落默认值并在
    nginx 日志里点名（`docker compose ... logs nginx | grep render-rate-limit`），
    绝不会渲染出坏配置让 nginx 起不来。
    改了变量要 **重建** nginx 容器（`docker compose ... up -d nginx`，
    仅 `reload` 不会重跑 entrypoint 脚本）。
    zone 是**三档共享**的：同一 IP 在店铺和商家后台之间共用 `front_general` 预算，
    换个子域名/入口不会换来一份新配额。
  - **怎么按访问日志校准**（保守做法：单 IP 每分钟峰值 ÷ 60 × 2~3 倍余量）：

    ```bash
    cd infra
    # 1) 单 IP 的每分钟请求数峰值（combined 格式的第 1 列是 IP，第 4 列是 [时间）
    docker compose -f docker-compose.yml -f docker-compose.prod.yml \
      logs --no-log-prefix --since 24h nginx \
      | awk '{ ts=$4; sub(/^\[/, "", ts); split(ts, a, ":"); k=$1" "a[1]" "a[2]":"a[3]; c[k]++ }
             END { for (k in c) print c[k], k }' \
      | sort -rn | head -20

    # 2) 全站每分钟请求数峰值（判断阈值整体是否合理）
    docker compose -f docker-compose.yml -f docker-compose.prod.yml \
      logs --no-log-prefix --since 24h nginx \
      | awk '{ ts=$4; sub(/^\[/, "", ts); split(ts, a, ":"); k=a[1]" "a[2]":"a[3]; c[k]++ }
             END { for (k in c) print c[k], k }' \
      | sort -rn | head -5

    # 3) 被限流的请求（有输出就要复核是否误伤，按 IP 与 zone 归类）
    #    error.log 的形态：... limiting requests, excess: 5.000 by zone
    #    "front_general", client: 203.0.113.7, server: ...
    docker compose -f docker-compose.yml -f docker-compose.prod.yml \
      logs --no-log-prefix --since 24h nginx \
      | grep 'limiting requests' \
      | sed -E 's/.*by zone "([^"]+)".*client: ([0-9a-f.:]+).*/\1 \2/' \
      | sort | uniq -c | sort -rn | head -20
    ```

    **算例**：第 1 条命令的头部是 `240 203.0.113.7 21/Nov/2026 10:31`，
    即该 IP 一分钟 240 次 ≈ 4 r/s → 取 2~3 倍余量 → **`RATE_LIMIT_FRONT_RATE=12`**。
    取**所有 IP 的最大值**，不是平均值：限流是 per-IP 的，平均值会把
    单个真实用户（开多个标签页、RSC 预取）挡在门外。
    `BURST` 建议取 `RATE × 5` 左右，容忍页面首屏并发（一个页面可能同时发
    十几个 RSC/静态资源请求）。若日志里 `limiting` 大量出现而 QPS 并不高，
    说明阈值过低，或（更常见）**前面挂了 CDN/LB 但没配 real_ip** —— 那种
    情况下所有请求都算在 CDN 节点 IP 上，一把限流会把全站打死。
  - ⚠️ **上 CDN/LB 前必须先配 real_ip**：模板当前**没有** `set_real_ip_from` /
    `real_ip_header`，`$binary_remote_addr` 取的是直连对端。前面加了代理后，
    对端恒为代理 IP → 限流退化成「全站共享一份配额」。届时在
    `prod.conf.template` 的 http 级加 `set_real_ip_from <代理网段>` +
    `real_ip_header X-Forwarded-For`（由**代理**覆写该头才可信），
    而不是把限流键改成客户端可伪造的头。
  - ⚠️ **CGNAT / 办公网出口**：大量真实用户可能共享同一个公网 IP，`FRONT`
    档不要压得太紧（默认 20 r/s 就是为此留的余量），否则一个公司的用户
    会互相抢配额。
- **告警规则建议**：`payouts_processing_stuck > 0` 与
  `payments_refunding_stuck > 0` 直接是资金事件（这两个 gauge 正常恒为 0）；
  `queue_jobs{state="failed"}` 持续增长说明 webhook 消费在失败。
- **渠道告警**：`ALERT_WEBHOOK_URL` 配飞书/钉钉机器人后，卡单、
  退款问不出结论、对账超预算会直接推 IM（去重 10 分钟 + 限频 10 条/分钟）。
- **日志**：pino JSON 一行一条，`docker compose logs api | jq 'select(.level>=40)'`
  看 warn 以上；每条请求日志带 `requestId`，报障时让用户/前端提供
  `x-request-id` 响应头即可精确定位。

## 10. 备份

```cron
# crontab -e（infra/crontab.example 有同款）
0 3 * * * cd /path/to/repo/infra && ./backup.sh
```

⚠️ 备份落在**同一台服务器**（`infra/backups/`）。生产环境必须补一条
异地同步（对象存储 CLI / rsync 到备份机），否则磁盘损坏 = 数据全丢。

## 11. 上线前的最后核对

- [ ] `.env` 三把密钥是随机值且互不相同（守卫会拒绝占位符）
- [ ] `BASE_DOMAIN` 设置，DNS 解析生效（`dig +short *.example.com`）
- [ ] 泛域名证书就位且续期 cron 已配
- [ ] `minio.example.com`（或等价方案）可访问，CORS 白名单为真实域名
- [ ] 支付渠道：`PAYMENT_ENABLED_CHANNELS` 指向真实渠道（fake/sandbox 在
      生产环境写了 = **启动失败**，这是设计好的闸）
- [ ] 迁移已跑（`--profile tools run --rm migrate` 无待应用项）
- [ ] 平台超管账号已手工创建，seed 演示账号不存在
- [ ] 告警 webhook 已配置且收到过测试告警
- [ ] 限流阈值已按真实访问日志校准（§9：单 IP 每分钟峰值 ÷ 60 × 2~3 倍），
      不是默认占位值；`docker compose ... logs nginx | grep render-rate-limit`
      确认六个变量都按预期生效、没有「回落到默认值」的点名
- [ ] 若前面有 CDN/LB：`set_real_ip_from` / `real_ip_header` 已配（§9），
      否则限流会把全站算在一个 IP 上
- [ ] 备份 cron 已配且备份产物在**另一台机器**上验证过可恢复
- [ ] `./restore.sh` 的恢复流程演练过一次（光备份不演练 = 没有备份）

---

## 附录 A：本机全栈容器（不使用生产 override）

下面这段来自原根 `README.md`，是本机把四个应用一起用 compose 跑起来的方式，
与上面的生产部署互不影响。

```bash
cd infra && docker compose up -d
```

八个服务一起起来：`postgres` / `minio` / `redis` / `api` / `storefront` / `merchant-admin` / `platform-admin` / `nginx`。

- 后端健康检查：<http://localhost:3000/api/v1/health>（api 端口仅绑定本机回环；经 Nginx 访问时用 `Host: api.platform.test`）
- 接口文档：<http://localhost:3000/api/docs>
- 店铺前台：<http://localhost/> （用 `Host` 头指定店铺，如 `Host: demo.platform.test`）

子域名本地调试：把 `127.0.0.1 *.platform.test` 写进 `/etc/hosts`。

> **注意**：compose 默认是 **production 姿态**（`api/Dockerfile` 自带 `ENV NODE_ENV=production`，compose 也显式设 `NODE_ENV: production`），
> 所以上面这条命令**原样跑不起来**。启动校验会拒绝 compose 内置的默认凭据：默认/空的 PostgreSQL、Redis、MinIO 密码，
> 以及示例/默认的 `JWT_SECRET` / `AUTH_SECRET` / `PAYOUT_ACCOUNT_ENCRYPTION_KEY` 都会让进程启动即失败。
> 要真跑通，必须通过环境变量提供真实的 `POSTGRES_PASSWORD` / `REDIS_PASSWORD` / `MINIO_ROOT_PASSWORD` 凭据，
> 以及真实的 `JWT_SECRET` / `AUTH_SECRET` / `PAYOUT_ACCOUNT_ENCRYPTION_KEY`（其中 `JWT_SECRET` / `PAYOUT_ACCOUNT_ENCRYPTION_KEY` 至少 32 字符，可用 `openssl rand -base64 48` 生成）。
>
> 本机联调请走[开发指南](development.md)的「本地开发」路径（`cd api && npm run start:dev`，读 `api/.env`，`NODE_ENV` 不是 production，不触发这些拒绝）。
> 也**不要**把 compose 的 `NODE_ENV` 改成 development 绕过：那会让非生产默认的假支付（`fake`）/ 假出款（`fake-payout`）渠道生效，
> 属于安全姿态变更。
>
> compose 里的 `JWT_SECRET` / `AUTH_SECRET` 是明文固定值，**仅供本机开发**；真实部署必须换成外部注入的随机密钥。
