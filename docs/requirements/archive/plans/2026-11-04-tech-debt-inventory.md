# 技术债与历史遗留盘点（截至阶段 8）

> **日期**：2026-11-04
> **范围**：阶段 1–8 的验收记录、README/AGENTS 口径、`api/`、三端前端、共享包、`infra/`、CI 与依赖清单。
> **方法**：先由文档汇总各阶段「明确延后 / 已知限制 / 遗留」，再对当前代码、配置与 CI 做抽样核实；
> 已被后续阶段闭环的条目不列入待办，统一放在 §三。
> **标记**：P0 = 资金正确性、安全或高危运维；P1 = 扩展性/体验/验证缺口；P2 = 工程整洁与文档口径。
> 本清单只盘点事实，不代表已经排期。

---

## 一、先看结论

### P0：建议优先处理（下一阶段候选）

| ID | 事项 | 证据 |
|---|---|---|
| D-01 | 生产密钥守卫只覆盖 `JWT_SECRET` 与 `PAYOUT_ACCOUNT_ENCRYPTION_KEY` 的 4 个占位值；`POSTGRES_PASSWORD` / `MINIO_ROOT_PASSWORD` / `REDIS_PASSWORD` / `AUTH_SECRET` 无任何启动断言，且 compose 里 `JWT_SECRET` / 三端 `AUTH_SECRET` 是硬编码字面量 | `api/src/common/config/placeholder-secrets.ts:18-27`、`infra/docker-compose.yml:126,192,219,246` |
| D-02 | MinIO API 端口 `19000` 与 nginx `80` 未绑 `127.0.0.1`，暴露所有网卡；README 却写「全部宿主机端口绑回环」 | `infra/docker-compose.yml:80,276`；`README.md:30` |
| E-01 | 历史迁移 checksum 漂移导致 `prisma migrate dev` 不可用，误用会要求 `migrate reset` 清空开发库；仓库已有 `fix-legacy-migration-checksum.sql` 与手写 SQL 流程 | `2026-10-27-plan-05e-acceptance.md:292-404`、`AGENTS.md:188-198` |
| E-02 | 已出款的周期仍可被回填，一旦重复回填就是重复出款；当前没有调账机制兜底 | `2026-10-28-plan-05g-acceptance.md:350-380`（L27） |
| A-01 | `PAYOUT_ACCOUNT_ENCRYPTION_KEY` 配错会让批量出款单落 `FAILED`；人工逐单重试已可用，但缺批量入口，平台端仍看不到解密根因 | `2026-10-30-plan-05k-fund-closure-acceptance.md:388-419`、`api/src/modules/payment/payout.worker.ts:150-166` |
| F-01 | 备份只对 PostgreSQL 做 `gunzip -t`；MinIO / Redis 的 tar 无完整性校验，卷找不到时脚本仍以 0 退出；恢复流程含占位符、未停 api、无 Redis 步骤；cron 未固化到仓库 | `infra/backup.sh:51-85` |
| F-02 | CI 不跑 e2e（40 套件 / 663 条），也不跑三个前端的 `npm run lint`；阶段 8 刚把 api lint 归零，前端 lint 无门禁会静默回归 | `.github/workflows/ci.yml:74-152` |

> 真实渠道接入本身仍延后，但其前置项（渠道分页、`PROCESSING` 渠道取值、拒付标记）已在 5m/6a 完成，见 §三。

### P1：正确性/扩展性，按触发条件排

| ID | 事项 | 触发条件或影响 |
|---|---|---|
| C-01 | 跨副本分布式锁未做：刷新令牌、周期任务、对账互斥都假定单副本 | **扩副本前必须做**（5c/5d/5f/6/8 均提到） |
| C-02 | `refresh_tokens` 过期行只抹列不删行，表无限增长 | 需要归档策略 |
| C-03 | 宽限期判定用应用时钟，与 `databaseNow()` 不一致；多副本时钟偏差有秒级窗口 | 扩副本前确认 60 秒窗口 |
| A-02 | 回填跳过的历史退款（`refundedAt IS NULL`）永远不会被冲回 | 两笔抽佣长期挂账 |
| A-03 | 跨期调账 + 逐笔结佣未定论（L54 / R7） | 等产品决策 |
| A-04 | 「漏结流水」无主动告警；对账只覆盖出款侧，与账目口径未打通 | 靠超管定期人工对账 |
| A-05 | 退款不回补库存，退货入库流程未实现 | 库存账面与实物长期不一致 |
| A-06 | 结算单无 CSV/PDF 导出 | 运营无法导出 |
| A-07 | `commission_entries.tenantId` 无外键约束；脏 tenantId 可插入，报表口径可能已错 | 加外键需清理历史数据 |
| A-08 | `unconfirm` 的闸存在 TOCTOU 窗口 | 并发新建引用同一结算单的出款单可绕过 |
| D-03 | 中转路由仍用 `if (!session)`：merchant-admin 48 处、platform-admin 22 处，没有 `accessToken` 判空 | 阶段 8 只把 platform-admin 22 处列为延后；merchant-admin 48 处未被文档提及（盘点新发现） |
| H-02 | 真实浏览器链路 / Playwright 未做；阶段 8 全栈也只做到 HTTP 与页面渲染级 | 下单主流程无浏览器级回归 |
| G-01 | 平台超管创建平台券无前端入口；`PERCENT` 折扣券只有预留分支，引擎静默跳过 | 平台营销功能不完整 |
| F-03 | Node/npm 版本三处不一致：本机 Node 26 + npm 11、CI Node 22 + npm 10、Dockerfile 强制 `npm@11`；仓库无 `engines`/`.nvmrc` | lock 与 `npm ci` 行为反复漂移 |
| D-04 | nginx 无 TLS / CSP / HSTS；安全头在 http 层与 `/_next/static/` 层重复维护 | 本机形态属有意取舍，生产化前必须补 |

### P2：工程整洁与文档口径

| ID | 事项 | 证据 |
|---|---|---|
| I-01 | `@nestjs/config` 声明但未使用（代码约定直读 `process.env`） | `api/package.json:40`；`api/src/modules/queue/queue.module.ts:19` |
| I-02 | `shadcn`（三端 devDependency）疑似只用 CLI；共享包 `react-dom` 疑似无用（均需人工确认） | 各端 `package.json` |
| I-03 | 三端 `tsconfig.json` / `eslint.config.mjs` 逐字节重复；api 开类型感知 lint + prettier，前端不开 | `*/tsconfig.json`、`*/eslint.config.mjs` |
| I-04 | `prisma.seed` 的 `--compiler-options` 未加引号（同文件其他脚本加了），含空格易被 shell 拆分 | `api/package.json:33` |
| I-05 | `backfill:commissions` 只是 `backfill:ledger` 的同义别名 | `api/package.json:27-28` |
| I-06 | nginx 的 immutable 缓存只覆盖 storefront 的 `/_next/static/`；另两端同样带内容哈希却走不到长缓存 | `infra/nginx/platform.test.conf:83-95` |
| I-07 | CI 仍用 `actions/checkout@v4` / `setup-node@v4`，运行时有 Node 20 弃用告警 | 最近一次 run 的 annotation |
| I-08 | 根 README 与三端子 README 的测试条数互相矛盾（根：927/663/223/421/465；子 README：907/657/209/417/429） | `README.md:213-230` 与各子 README |
| I-09 | `AGENTS.md` 仍写「最近一次已完成的是阶段 7」，与 README 的阶段 8 冲突 | `AGENTS.md:38` |
| I-10 | README 只介绍 `tools/push-via-api.mjs`，未提中文分支用的 curl 版 | `README.md:325`、`AGENTS.md:29` |
| I-11 | README 备份说明只写 PostgreSQL + MinIO，实际还备份 Redis 卷 | `README.md:270`、`infra/backup.sh:70-79` |
| I-12 | `infra/.env.example` 未覆盖 compose 读取的多个变量（渠道、MinIO 细项、端口、JWT/AUTH 等）；`PAYOUT_ACCOUNT_ENCRYPTION_KEY` 行被注释，复制后实际回落到 compose 默认值 | `infra/.env.example:32` |
| I-13 | `api/.env` 里 `FAKE_PAYMENT_ENABLED` / `FAKE_PAYOUT_ENABLED` 是注释，但非生产 `enabledChannels()` 默认把 `fake` 列为已启用，渠道列表与实际可用实现不一致 | `api/src/common/channel/channel-config.ts:77-85` |
| I-14 | 根 README 的「阶段 7 之后的剩余技术债」标题已过时（正文已含阶段 8） | `README.md:357` |
| I-15 | 备份保留天数文案写「非负整数」，正则允许 `0`；`-mtime +0` 会删掉所有超过 1 天的历史备份 | `infra/backup.sh:28-31,82-83` |

---

## 二、按领域的明细

### A. 资金与账务正确性

| ID | 事实 | 来源/证据 |
|---|---|---|
| A-01 | 5k：账目密钥配错 → 批量 `FAILED`；人工逐单重试可用，但缺批量入口，平台端看不到解密根因（只进日志） | `2026-10-30-plan-05k-fund-closure-acceptance.md:388-419`、`2026-10-30-plan-05l-payout-ops-acceptance.md:249-290` |
| A-02 | 5g/5e：5b 之前退的款没有 `refundedAt`，回填时被跳过，这两笔抽佣永久挂账 | `2026-10-28-plan-05g-acceptance.md:350-380` |
| A-03 | 5h-2/5m：L54 回填货款漏结佣金；R7 跨期调账等产品决策 | `2026-10-29-plan-05h2-payout-execution-acceptance.md:313-323` |
| A-04 | 5m：L31 漏结流水无主动告警；对账只改 `payouts` 状态，结算单/流水修正仍是另一件事 | `2026-10-31-plan-05m-payout-reconciliation-acceptance.md:258-286` |
| A-05 | 3/4/8：退款只做整单、不回补库存；退货入库始终未实现 | `2026-10-24-plan-03-acceptance.md:475-579` |
| A-06 | 5g L30：结算单没有 CSV/PDF 导出 | 同 5g 验收 |
| A-07 | 5g R5：`commission_entries.tenantId` 无外键，脏数据会让报表口径出错 | 同 5g 验收 |
| A-08 | 5h-1 L34：`unconfirm` 检查与更新之间的 TOCTOU 窗口；`approve` 侧已有回查，但仍存在极窄的并发窗口 | `2026-10-29-plan-05h-payout-ledger-acceptance.md:295-320`、`payout.service.ts:1443-1475` |
| A-09 | 5l L33：出款单作废重开无解（`APPROVED` 后改金额没有入口）；重试已改为用 `releasedEntryIds` 复原，不再是「重算」 | `api/src/modules/billing/payout-execution.service.ts:539-651` |
| A-10 | 5l L8：平台端结算单列表请求 `pageSize=200`，后端上限 100，页面文案与注释都写 200 | 同 5l 验收 |
| A-11 | 5b：套餐 `maxStores` 只声明不约束；换套餐的周期长度语义未定论 | `2026-10-25-plan-05b-acceptance.md:285-304` |

### B. 渠道与对账

| ID | 事实 | 来源/证据 |
|---|---|---|
| B-01 | 5m：CSV 来源的 A 类差异可被运营映射成 `SUCCESS` 自动纠正，没有人工确认闸 | 同 5m 验收 |
| B-02 | 5f：webhook 事件自动重放、BullMQ failed 队列通用捞取机制均未做 | `2026-10-27-plan-05f-acceptance.md:186-197` |
| B-03 | 6：通用平台设置中心未做（`platform_settings` 只有默认出款渠道一个 key）；CSV 批量确认无严重级/状态筛选 | `2026-11-02-plan-06-acceptance.md:161-171` |

### C. 并发与扩展性

| ID | 事实 | 来源/证据 |
|---|---|---|
| C-01 | 刷新令牌、周期任务、对账互斥都假定单副本；`inFlightRefreshes` 是模块级变量 | 5c/5d/5f/6/8 多处 |
| C-02 | `refresh_tokens` 只抹密文不删行，表无限增长 | `2026-10-27-plan-05c-acceptance.md:402-489` |
| C-03 | 宽限期用应用时钟，与 DB 时钟约定不一致；极端情况下既被 cleanup 抹掉又被判在宽限期 → 吊销整族 | 同 5c 验收 |
| C-04 | 券深页合并窗口上限 1000，深页需改数据库 UNION | `2026-11-04-plan-08-acceptance.md:139-145` |

### D. 安全与部署配置

| ID | 事实 | 证据 |
|---|---|---|
| D-01 | 生产密钥守卫只含 JWT/PAYOUT 的 4 个占位值；四个生产关键凭据无守卫 | `api/src/common/config/placeholder-secrets.ts:18-27` |
| D-02 | MinIO `19000` 与 nginx `80` 未绑回环；MinIO 还复用 root 凭据 | `infra/docker-compose.yml:73-80,276` |
| D-03 | merchant-admin 48 处 / platform-admin 22 处 `if (!session)`，无 `accessToken` 判空；阶段 8 只延后了 platform-admin 22 处 | 仓库实测 grep |
| D-04 | nginx 无 TLS/CSP/HSTS，安全头两层重复维护 | `infra/nginx/platform.test.conf:34-36,92-94` |
| D-05 | 守卫的 401/403 不进访问日志（Nest 守卫在拦截器链外） | 7b 验收 |
| D-06 | 登出只吊销 refresh token，access token 在 TTL 内仍可用 | 7b 验收 |

### E. 数据迁移与数据库

| ID | 事实 | 证据 |
|---|---|---|
| E-01 | 历史迁移 checksum 漂移，`migrate dev` 不可用；本仓照旧手写 SQL + `migrate resolve` | 5e/5l/5m 验收、README |
| E-02 | `20261022071848_add_sku_stock_version` 在全新库上会失败（DROP 了后建索引），且不能改（会破坏 checksum） | 阶段 3/4 验收 |
| E-03 | 4 条手写索引与 Prisma schema 漂移（`coupon_claims_coupon_customer_uniq`、`payments_provider_txn_uniq`、`products_name_trgm`、`products_slug_trgm`）——**明确不要「修」** | 阶段 2/6 验收 |
| E-04 | 迁移脚本留下的 `*_backup_<时间戳>` 表永久占空间，含明文历史数据，需人工清理 | 5j/5k 验收 |

### F. 运维与 CI

| ID | 事实 | 证据 |
|---|---|---|
| F-01 | 备份完整性/恢复/退出码问题见 P0；另：MinIO 与 Redis 是热备（tar 运行中卷），可能不一致 | `infra/backup.sh:51-79` |
| F-02 | CI 不跑 e2e、不跑前端 lint；shared job 只做 tsc（共享包无 test/build 脚本） | `.github/workflows/ci.yml:74-167` |
| F-03 | Node/npm 版本漂移；Dockerfile 需强制 `npm@11` 才能装 npm 11 生成的 lock | `api/Dockerfile:12-15`、`ci.yml:55` |
| F-04 | 备份 cron 未固化到仓库，是否在跑无从查证；`docker compose up -d --wait postgres` 让备份脚本有启动依赖的副作用 | `infra/backup.sh:4-6,36` |
| F-05 | CI 各 job 完全并行，三端 job 重复安装共享包（4 次 `npm ci`） | `ci.yml:86-88,114-116,142-144` |

### G. 前端与主题

| ID | 事实 | 证据 |
|---|---|---|
| G-01 | 平台券无前端入口；`PERCENT` 折扣券引擎静默跳过、DTO 不接受 `type` | `api/src/modules/coupon/discount-engine.ts:206-207` |
| G-02 | 商家可编辑的部分 token 在 storefront 无消费者（`shadow-sm` / `shadow-lg` / `text-destructive-foreground`）；行高比例不随字号 | 5d 验收 |
| G-03 | dark 模式从未启用；将来启用时 `.dark` 会覆盖商家注入的 `:root` | 5d 验收 |
| G-04 | storefront 只有 `orders` 一个 loading 骨架页 | 7c 验收 |

### H. 测试与验证缺口

| ID | 事实 | 证据 |
|---|---|---|
| H-01 | 浏览器手工链路/Playwright 未做；阶段 8 只做 HTTP 与页面渲染级验证 | `2026-11-04-plan-08-acceptance.md:115-136` |
| H-02 | 若干「防御性代码」没有独立回归防护（5g R8/R9、5e F4/F9、5b M11 等） | 各阶段验收 |
| H-03 | merchant-admin 的 jwt 回调已在 5c/5d/7c 补齐覆盖；但 `theme-watcher` 只测「没变时不重写」的反向 | 阶段 4/5c 验收 |

### I. 依赖、配置与工程杂项

| ID | 事实 | 证据 |
|---|---|---|
| I-01 | `@nestjs/config` 未使用 | `api/package.json:40`、`queue.module.ts:19` |
| I-02 | `shadcn`、共享包 `react-dom` 疑似未使用，需人工确认 | 各端 `package.json` |
| I-03 | 三端 tsconfig/eslint 重复；前端无 prettier 门禁 | 配置文件 |
| I-04 | `prisma.seed` 引号写法不一致 | `api/package.json:33` |
| I-05 | `backfill:commissions` 是别名 | `api/package.json:29-30` |
| I-06 | 共享包仍以 `file:` 依赖使用，未独立发布/版本化 | 各端 `package.json` |
| I-07 | 无 `engines` / `.nvmrc` / `.node-version` | 仓库根 |
| I-08 | 三端 `next` / `react` / `react-dom` 精确固定版本，人工同步 | 各端 `package.json` |
| I-09 | MinIO 镜像 `cgr.dev/chainguard/minio:latest` 无 digest 锁定 | `infra/docker-compose.yml:68` |
| I-10 | 8 个 compose 服务均无 `cpus` 限制（`mem_limit` 已有） | `infra/docker-compose.yml` |
| I-11 | `.env.example` 缺多个变量（渠道、端口、JWT/AUTH 覆盖项等） | `infra/.env.example` |
| I-12 | `api/.env` 的 `REDIS_URL` 带密码，但代码/CI 兜底是无密码 URL | `api/src/modules/queue/queue.module.ts:49`、`ci.yml:48` |

### J. 文档口径

| ID | 事实 | 证据 |
|---|---|---|
| J-01 | 根 README 与三端子 README 测试条数不一致（详见 I-08） | 各 README |
| J-02 | `AGENTS.md` 阶段仍停在 7 | `AGENTS.md:38` |
| J-03 | README「阶段 7 之后的剩余技术债」标题已过时 | `README.md:357` |
| J-04 | README 未提 curl 版推送脚本 | `README.md:325` |
| J-05 | README 备份说明漏了 Redis 卷 | `README.md:270` |
| J-06 | 部分历史 plan 里的测试数字是阶段性快照（657/907/417/429 等），与当前不一致；属历史记录，不建议逐份改写 | `docs/superpowers/plans/` |

---

## 三、已闭环 / 不应重复排期

以下条目在后续阶段或当前代码中已解决，盘点时已核实，**不要再当待办**：

| 事项 | 闭环方 |
|---|---|
| 报表切到抽佣流水表（5g L18 / 5e D7） | 5i |
| 抽佣出款（5g L19） | 5h-1 / 5h-2 |
| 结算单明细分页、两端出款列表分页（5g L28、5h-1 L35/L36） | 5l |
| 商家侧结算单 / 商家端收款账户可见性 | 5i / 5k |
| 收款账户明文存储（5h-1 L38） | 5j AES-256-GCM |
| `payouts.statementId` 索引（5h-1 L32） | 5h-2 |
| 5k 崩溃窗口卡 `PROCESSING` 无处置入口 | 5l 解卡 |
| 5k `FAILED` 两种语义在商家端的分流 | 5l |
| 出款重试用 `releasedEntryIds` 复原（5m 遗留「重算」） | 5m |
| 对账按渠道过滤 `loadLocalPayouts`（5m B-03） | 5m 技术债收尾 |
| 渠道接口分页、`definitive` 拒付标记、审批时锁定出款渠道（5m-16/17） | 5m 技术债 + 阶段 6a |
| webhook 投递失败补偿（5d L1） | 5f |
| 对账 summary 全表扫 / detail 捞完再截 / 渠道流水分页 / `PROCESSING` 补渠道名 | 5m 技术债收尾（代码已用 `groupBy` 与查询层截断） |
| Redis 挂死后 API 静默挂死（5c） | 5d |
| `availablePeriods` 的 N+1（5h-2 L55） | 8c 改用 `merchantReceiptPeriods()` DB 端 DISTINCT |
| 共享包 `@/` 回环、可独立 tsc、CI shared job | 7c / 8 |
| 商家后台主题实时预览（`ThemeForm` 的 `data-testid="theme-preview"`） | 阶段 4 |
| 消费者地址簿独立页面（`storefront/src/app/(shop)/account/addresses`） | 阶段 3 之后 |
| 三端 api-client / theme / jwt 回调重复 | 7c |
| `fetch failed` 泄漏到前台、404 与故障不区分 | 8c |
| 购物车并发丢增量、续费重复扣款、交易号绑定缺 provider | 8b |
| api lint 阶段 2 遗留的 media e2e 报错 | 8c（lint 归零） |
| 「API 推送不产生 push 事件、CI 无法自动触发」 | 已不成立：2026-11-04 的 `a9d4c34` 推送触发了 `push` 事件并正常跑 CI；`ci.yml:3-4` 的注释已过期 |

---

## 四、盘点时纠正的旧口径

为避免把过期信息带进下一阶段，以下说法在本次核实中被推翻：

1. **「CI 没有创建 `ecommerce_test`，api job 会 P1003」** —— 不成立。`prisma migrate deploy` 会自动创建该库；CI 日志有 `PostgreSQL database ecommerce_test created`，随后迁移成功（run `41809651743`）。
2. **「5m 的 summary 全表扫与 detail 捞完再截仍未修」** —— 当前代码已使用 `groupBy` 与查询层 `take` 截断（`payout-reconciliation.service.ts:1017-1086`），属已闭环。
3. **「商家端看不到收款账户（5j L1）」** —— 5k 已补商家端出款详情，且商家后台已有收款账户设置页与申请页展示。
4. **「Git Data API 推送不触发 CI」** —— 当前实测会触发 `push` 事件；`ci.yml` 顶部注释需要更新。
5. **「商家后台没有主题实时预览」** —— 不成立，`ThemeForm` 已有 `data-testid="theme-preview"` 的实时预览区。
6. **「地址簿没有独立页面」** —— 不成立，storefront 已有 `account/addresses` 页面。
7. **「阶段 2 迁移在全新库上会失败」** —— 不成立。AGENTS 明确该迁移在全新库上整条跳过是故意的；CI 在全新测试库上应用全部迁移成功。
8. **「e2e 数据库侧没有每轮清库」** —— 不成立。`api/test/setup-e2e.ts` 的 `truncateAllTables()` 每轮运行前清空全部业务表。

---

## 五、建议的下一阶段切入点（仅建议，未排期）

1. **先做 P0 的「安全与资金」小批次**：密钥守卫补全 → 端口回环 → 备份恢复可执行化 → 已出款周期回填闸。前两项是配置与断言，改动小、风险低；后两项需要设计与测试。
2. **单独处理迁移债**：给 `migrate dev` 恢复可用性（重建 shadow 或固化 `migrate resolve` 流程）与「全新库迁移失败」做一次验证，避免误操作清库。
3. **CI 门禁补齐**：前端 lint + e2e 分批进 CI（先资金链路 40 套件里挑核心子集），再统一 Node/npm 版本。
4. **扩副本前置项单独立项**：分布式刷新锁、周期任务互斥、宽限期时钟容忍，三者必须同一批做。
5. **文档收尾**：统一根 README 与三端子 README 的测试数字、AGENTS 阶段口径、`ci.yml` 过期注释；历史 plan 里的快照数字保留，不逐份改。
