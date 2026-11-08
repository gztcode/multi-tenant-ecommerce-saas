# 生产部署指南（阶段 11）

本仓库的 compose 形态此前是「本机开发形态」（HTTP、回环端口、固定密钥）。
本文档把它变成一份**可对外服务的最小生产部署**：TLS、真实域名、密钥治理、
迁移策略、备份与升级流程。

> **范围声明**：这是单机部署（一台服务器 + compose）。多副本、HA、
> secret manager、CDN 属于规模化改造，见 README「剩余技术债」。

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
| `example.com` 与 `*.example.com` | A | 服务器 IP | 店铺前台（`<tenant>.example.com`） |
| `api.example.com` | A | 服务器 IP | API（支付渠道回调指向这里） |
| `merchant.example.com` | A | 服务器 IP | 商家后台 |
| `admin.example.com` | A | 服务器 IP | 平台超管后台 |

> 如果嫌 5 条记录麻烦：`*.example.com` 一条泛解析可以同时覆盖
> 店铺子域名与三个中心域名（nginx 的 server_name 已按域区分）。

## 2. 证书（泛域名，DNS-01）

`infra/nginx/templates/prod.conf.template` 使用一张覆盖
`example.com` + `*.example.com` 的证书，签发方式必须用 **DNS-01**：

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

> `PAYOUT_ACCOUNT_ENCRYPTION_KEY` 一旦投入生产**不能轮换**——
> 轮换后已打款的出款单快照永久解不开（守卫与 README 都有警告）。

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
curl -f https://api.example.com/api/v1/metrics | head  # Prometheus 指标
curl -sI https://example.com | grep -i strict          # HSTS 头存在
curl -sI http://example.com | head -1                  # 301 → https
```

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

- **抓取**：Prometheus 抓 `https://api.example.com/api/v1/metrics`
  （建议在 nginx 上给该路径加网段白名单，模板里有注释好的示例块）。
  指标清单：`ecommerce_http_requests_total` / `..._duration_seconds`、
  `ecommerce_queue_jobs`、`ecommerce_payments_refunding_stuck`、
  `ecommerce_payouts_processing_stuck` + 进程指标。
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
- [ ] 备份 cron 已配且备份产物在**另一台机器**上验证过可恢复
- [ ] `./restore.sh` 的恢复流程演练过一次（光备份不演练 = 没有备份）
