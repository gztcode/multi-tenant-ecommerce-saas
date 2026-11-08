# 阶段 11 验收记录：可观测性、部署加固与代码收口

日期：2026-11-07。范围与证据如下。

## 一、可观测性

| 交付 | 位置 | 验证 |
|------|------|------|
| pino 结构化日志（全局 useLogger，业务代码零改动） | `api/src/common/logging/` | 真实启动冒烟：访问日志落 JSON，含 `requestId/method/url/status/durationMs` |
| request-id 中间件（透传上游 / 生成 UUID，回写响应头） | `api/src/common/http/request-id.middleware.ts` | 同上，日志与响应头均可见 |
| 敏感字段递归脱敏（password/token/secret/authorization/cookie/credential） | `pino-logger.service.ts` | 单测 9 条（含「不改调用方原对象」「超长截断」） |
| Prometheus 指标 `/api/v1/metrics` | `api/src/common/metrics/` | 冒烟：HTTP RED / 队列深度 / 卡单 gauge / 进程指标均在 |
| HTTP 指标走**中间件层**（守卫 401/403 也进指标） | `metrics.middleware.ts` | 中间件在守卫前注册 `res 'finish'`；拦截器版已删除 |
| WebhookAlertSink（飞书/钉钉/通用格式） | `api/src/common/channel/webhook-alert-sink.ts` | 单测 7 条（去重/限频/非 2xx 不抛/网络错误不抛） |

## 二、部署加固

| 交付 | 位置 | 验证 |
|------|------|------|
| 生产 TLS 模板（泛域名 + ACME + HSTS，envsubst 渲染） | `infra/nginx/templates/prod.conf.template` | 官方 nginx 镜像 `nginx -t` 语法通过（stub upstream + 自签证书） |
| compose 生产 override（80/443 对外，数据服务端口可摘除） | `infra/docker-compose.prod.yml` | `docker compose config` 通过；缺 `BASE_DOMAIN` 时按设计快速失败 |
| 网关限流 `limit_req`（general 20r/s / auth 10r/s） | `platform.test.conf` + 模板 | nginx 语法通过；阈值注释说明 BFF 聚合 IP 的下限依据 |
| `statement_timeout=8s`（防单租户慢查询拖垮共享库） | `infra/postgres/init-tuning.sh` | 仅数据卷首次创建时生效；已有库按 DEPLOY.md 手动 ALTER |
| `migrate` 工具服务（builder 镜像带 prisma CLI） | `docker-compose.yml` `--profile tools` | compose config 含该服务 |
| 生产部署文档（DNS/证书/密钥/迁移/回滚/核对清单） | `docs/DEPLOY.md` | 11 节，密钥校验/占位符拒绝与启动守卫口径一致 |

## 三、代码收口

| 交付 | 前 | 后 | 验证 |
|------|----|----|------|
| `payment.service.ts` 拆分 | 2636 行 | 82+202 行 facade + lookup(365)/order(525)/refund(865)/webhook(767) + types | 全量 e2e 702 绿；调用点与类型导出零改动 |
| `payout.service.ts` 拆分 | 2052 行 | 82 行 facade + query(477)/state(1338) + types | billing 258 单测 + 全量 e2e 绿 |
| 媒体 magic-byte 复核 | confirm 只查大小 | 内容与类型不符即拒收入库并删对象 | 单测 8 条（伪装文本/空文件/白名单外） |
| 媒体列表 readUrl 批量签发 | 逐条 Promise.all | `createReadUrls` 批量 | 全量 e2e 绿 |
| `getRelationFieldNames` 按模型 memoize | 每次写入重建 DMMF Set | 进程内缓存 | 全量单测绿 |
| 游客订单查询 | 无 | 订单号+收货手机号双因子、最小投影、防爆破限流 | e2e 5 条（含跨租户隔离与 429） |

## 四、跨副本互斥

- `RedisLockService`（`api/src/common/lock/`）：SET NX PX + token + Lua 比对删除；
  抢不到=跳过本轮、Redis 不可用不抛出、TTL 兜底、`lazyConnect` 不留常驻连接。
- 接线：media 孤儿清理（每副本各自 setInterval 的真重复点）、payout 救援扫描、
  渠道对账（「同一时间只允许一个对账任务」的双保险）。
- 单测 6 条（含「不误删别人的锁」「Redis 不可用跳过」）。

## 五、顺手修复的既有问题

1. `test/setup-unit-env.ts`：`process.loadEnvFile` 在 jest 多 worker 下**随机不生效**
   （实测两 worker 一成一败，表现为 tenant-prisma 单测随机报
   「Environment variable not found: DATABASE_URL」）。补逐行解析兜底。
2. `PinoLoggerService` / `RedisLockService` 构造参数被 emitDecoratorMetadata
   当成 DI 令牌 → `@Optional()`（两处同款坑，均已注释）。

## 六、测试证据（本机）

- api 单测：1100 条 / 1097 通过 / 3 跳过，68 套件全绿。
- api e2e：45 套件 / 702 条全绿（126s，`--runInBand`，排除 media）。
- storefront：tsc + lint + 228 单测绿；platform-admin：tsc + 475 单测绿 + lint。
- API 真实启动冒烟（postgres/redis 本地容器）：health 200、metrics 指标齐全、
  pino JSON 日志带 requestId。

## 七、遗留（下一阶段候选）

1. 真实支付渠道接入（等商户资质；契约层已就绪）。
2. npm workspaces 化（4 个 Dockerfile + CI 连锁改造，单独安排）。
3. 商家主题实时预览、退货入库流程（后者需先定售后策略）。
4. Playwright 浏览器级 e2e（golden path）。
