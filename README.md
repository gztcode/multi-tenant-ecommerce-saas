# 多租户电商 SaaS 平台

前后端完全分离的多租户电商底座。一个实例服务多个商家：每个商家有自己的店铺、商品、订单与客户。

**当前进度：阶段 5m「渠道对账」已完成并验收通过。**

从阶段 5c 到 5m，推进的主线是**把「钱」这一层补完整**：

| 阶段 | 内容 |
|------|------|
| 5c | 刷新令牌宽限期（RFC 9700）—— 修「同时开两个后台标签页被踢下线」 |
| 5d | 主题与错误处理收口 —— 商家改主题前台真实生效；前端错误一律中文兜底；Redis 挂死有降级 |
| 5e | 抽佣流水明细 —— 超管能看到「哪个商家贡献了多少」 |
| 5f | 支付可靠性 —— webhook 投递失败可补偿；两个兜底扫描 |
| 5g | 结算单 —— 商家 × 自然月的应收单据 |
| 5h-1 / 5h-2 | 出款申请与真正打款 —— 申请 → 审批 → 打款 → 失败重试 → 卡死兜底 |
| 5i | 账目口径收口 —— 平台报表切到流水表；商家侧对账单 |
| 5j | 资金安全与账务闭环 —— 收款账户改密文存储；「缺笔」两端可见 |
| 5k | 资金链路收尾 —— 解密失败落 `FAILED` + 启动自检 |
| 5l | 出款运维兜底 —— 人工重试 / 解卡重打 + 留痕；两端列表分页 |
| 5m | 渠道对账 —— 六类差异 + A 类自动纠正 + CSV 账单导入 |

最新的 5m 补的是**「钱到底打没打出去」这件事没人能独立回答**的缺口：
渠道账单与本地出款单两套账，各说各话。现在有一套**纯函数比对引擎**（`payout-reconcile.engine.ts`）
把渠道记录与本地单据对齐，分出 A–F 六类差异（渠道说已打本地还卡着 / 本地记失败其实打了 /
金额不符 / 渠道有本地没有 / 渠道没有本地却已付 / 状态不符），A 类**自动纠正**，
其余走人工四道闸；真渠道没有批量查单接口时，可以**导入 CSV 账单**完成对账。

设计文档见
[`docs/superpowers/specs/2026-10-31-plan-05m-payout-reconciliation-design.md`](docs/superpowers/specs/2026-10-31-plan-05m-payout-reconciliation-design.md)；
各阶段的验收记录见 [`docs/superpowers/plans/`](docs/superpowers/plans/)——
**验收记录里有「实施期偏离计划」的表格**，记着当初计划里的真缺陷与踩过的坑，改代码前值得先翻。

---

## 子项目

| 目录 | 说明 | 端口 | 技术栈 |
|------|------|------|--------|
| `api/` | 后端 API | 3000 | NestJS 11 + Prisma 6 + PostgreSQL 16 |
| `storefront/` | 消费者店铺前台 | 3001 | Next.js 15 + NextAuth v5 + shadcn/ui |
| `merchant-admin/` | 商家后台 | 3002 | Next.js 15 + NextAuth v5 + shadcn/ui |
| `platform-admin/` | 平台超管后台 | 3003 | Next.js 15 + NextAuth v5 + shadcn/ui |
| `infra/` | 容器编排与网关路由 | 80 | Docker Compose + Nginx |

---

## 一键启动（Docker）

```bash
cd infra && docker compose up -d
```

八个服务一起起来：`postgres` / `minio` / `redis` / `api` / `storefront` / `merchant-admin` / `platform-admin` / `nginx`。

- 后端健康检查：<http://localhost/api/v1/health>
- 接口文档：<http://localhost/api/docs>
- 店铺前台：<http://localhost/> （用 `Host` 头指定店铺，如 `Host: demo.platform.test`）

子域名本地调试：把 `127.0.0.1 *.platform.test` 写进 `/etc/hosts`。

> **注意**：compose 里的 `JWT_SECRET` / `AUTH_SECRET` 是明文固定值，**仅供本机开发**。
> 真实部署必须换成外部注入的随机密钥。

---

## 本地开发（不用 Docker）

```bash
# 1. 数据库
cd infra && docker compose up -d postgres redis

# 2. 后端
cd api
npm install
cp .env.example .env
npm run prisma:deploy     # 应用迁移
npm run prisma:seed      # 造平台超管 + 示例店铺 + 示例账号（见下）
npm run start:dev

# 3. 三个前端（各开一个终端）
cd storefront     && npm install && cp .env.example .env && npm run dev   # :3001
cd merchant-admin && npm install && cp .env.example .env && npm run dev   # :3002
cd platform-admin && npm install && cp .env.example .env && npm run dev   # :3003
```

### 本机端口

本机标准端口被其他项目占用，本项目统一用：

| 服务 | 宿主机端口 | 容器内端口 |
|------|-----------|-----------|
| PostgreSQL | **15432** | 5432 |
| Redis | 16380 | 6379 |
| MinIO | 19000 | 9000 |

### 示例账号（seed 造的）

| 角色 | 邮箱 | 密码 | 店铺子域名 |
|------|------|------|-----------|
| 平台超管 | `admin@platform.test` | `Admin12345!` | —— |
| 商家店主 | `owner@demo.platform.test` | `Demo12345!` | `demo` |
| 消费者 | `customer@demo.platform.test` | `Demo12345!` | `demo` |

> 邮箱在 seed 写入前会统一小写化——登录路径把输入小写化后**精确匹配**查询，
> 而唯一索引是 `UNIQUE (lower(email))`，两边不一致会登不进去（阶段 3 手测踩到过）。

### 本地跑假支付 / 假出款网关

两个假网关都**只在非生产环境下存在**，且**默认关闭**——它们是**安全边界**，不是便利开关：

- **假支付网关**的支付页（`/api/v1/pay/fake/:paymentId`）**无需登录**就能把订单付掉。
- **假出款网关**（阶段 5h-2）会模拟「打款失败」——不打开它，被审批的出款单会一直失败。

```bash
cd api && FAKE_PAYMENT_ENABLED=true \
  FAKE_PAYMENT_SECRET=local-fake-payment-secret-at-least-16-chars \
  FAKE_PAYOUT_ENABLED=true \
  npm run start:dev
```

`NODE_ENV=production` 且任一开关为 `true` 时，进程**硬失败**（`assert-secure-config.ts`）。
两个开关**相互独立**，不要合并成一个。

---

## 测试

```bash
cd api
npm test              # 单元测试（隔离机制 / 状态机转移表 / 账目纯函数等，628 条 / 32 个套件）
npm run test:e2e      # 端到端（646 条 / 39 个套件）
npm run test:cov:e2e  # 项目真实覆盖率
```

> ✅ **跑 e2e 不需要停 api 容器**（阶段 5c 实测更正）。队列前缀隔离
> （`BULLMQ_PREFIX=bull-e2e`）与每轮清库早已实现，**容器 api 全程在跑**的情况下
> 连跑 3 轮 e2e 均全绿（阶段 5c 实测）；阶段 5m 验收时 646/646 全绿。
> 若仍遇到**随机的假失败**，再 `docker compose stop api` 排除。
> 历史背景见
> [阶段 3 验收记录 §一](docs/superpowers/plans/2026-10-24-plan-03-acceptance.md)。

三个前端各自 `npx tsc --noEmit && npm run lint && npm run build`。
**三个前端都有单元测试**（Vitest）：

```bash
cd storefront     && npm test   # 209 条 / 24 个文件：中转路由与纯函数的白名单 + 组件测试（jsdom + Testing Library：加购按钮 / 地址簿 / 主题轮询 / 结算页）
cd merchant-admin && npm test   # 406 条 / 27 个文件：中转路由的护栏（认证 / 白名单 / 畸形请求体 / 批量上限 / 订单白名单）+ 计费与出款白名单 + 令牌刷新 + jwt 回调的决策逻辑 + 组件测试
cd platform-admin && npm test   # 395 条 / 16 个文件：计费中转路由的白名单 + 页面级测试 + 套餐表单的组件测试
```

> ✅ **三个前端都具备组件测试基建**（`vitest.config.ts` + `test/setup.ts`，
> 组件测试在自己的文件里用 `// @vitest-environment jsdom` 逐文件切换）。
> 阶段 5c 还把 `jwt` 回调的**决策逻辑**抽成纯模块 `src/lib/jwt-callback.ts`
> （`storefront` 与 `merchant-admin` 各一份，逐行一致），并测了 9 条 ——
> 「accessToken 过期时刷新」「送不回去 cookie 时不刷新」「刷新失败时作废会话 / 保留旧令牌」。

e2e 与单元测试都跑在**测试库** `ecommerce_test` 上，与开发库物理隔离。

> ⚠️ **e2e 必须串行跑**（`--runInBand`）——共享同一个测试库与 Redis 队列，并行会互相干扰。

### 数据库迁移

```bash
cd api && npm run prisma:deploy
```

⚠️ **托管数据库上需要 DBA 先装 `pg_trgm` 扩展。** 商品搜索依赖它，
而 `CREATE EXTENSION` 需要超级用户或数据库所有者权限——RDS / Cloud SQL
这类平台上应用用户通常不是 owner，迁移会 `permission denied` 而失败。

本项目的 `docker compose` 不受影响：扩展在 `infra/postgres/init-extensions.sql`
里于建库阶段（超级用户身份）装好。真实部署请让 DBA 先执行：

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

> ⚠️ **`prisma migrate dev` 目前不可用**——有 3 条历史迁移的 checksum 与本机对不上。
> 新增迁移请照旧**手写 SQL**（`api/prisma/migrations/<时间戳>_<名字>/migration.sql`）。

---

## 架构要点

- **多租户隔离在客户端层强制**：Prisma query extension 自动给读写加 `tenantId` 条件，
  并拒绝 `findUnique`/`update`/`delete`/`upsert` 这类无法附加租户条件的方法。
  详见 `api/src/common/tenant/`。
- **租户上下文由全局拦截器建立**：`AsyncLocalStorage` 承载，已认证请求从 JWT 取租户范围，
  匿名请求从子域名解析。
- **子域名是路由标识，不是凭证**：`X-Tenant-Subdomain` 由网关注入，客户端设的值不可信；
  真正的访问控制来自认证与 RBAC。
- **前端不直连后端**：后端没开 CORS（设计上前端与 API 同源，由 Nginx 反代），
  写操作走各自的同源中转路由（`src/app/api/**/route.ts`），
  由服务端路由拿 session 里的 accessToken 去调后端。
- **订单状态流转一律用条件更新**：把 `from` 状态放进 `updateMany` 的 `where`，
  靠受影响行数判定并发赢家（阶段 3 的护栏 10）。改状态与动库存**必须在同一个事务里**——
  分成两个事务的话，释放失败时订单已是终态而库存没还回去，那批库存就永久卡在预占里。
- **库存三种流水**：下单 `RESERVE`（扣库存）、取消/超时 `RELEASE`（还库存）、
  支付成功 `DEDUCT`（**不动库存**，只是把预占转成售出）。释放与扣减都要校验
  「该订单在该 SKU 上尚未被冲抵的预占量」，否则能凭空造货。
- **金额全程整数分**，费率用万分比。计钱逻辑抽成**纯函数**
  （`billing/ledger.ts`、`billing/commission.ts`、`billing/settlement.ts`），
  让「计钱的每一条分支都能被完整断言」。
- **资金链路**：支付成功 → 抽佣流水 + 货款流水 → 结算单（商家 × UTC 自然月）→
  商家申请出款 → 平台审批 → 打款 → 渠道对账。
  结算单的金额**只从流水算**，不从订单重新聚合；确认之后冻结。
- **打款的钱是密文**：收款账户与出款单快照用 AES-256-GCM 加密存储，
  密钥来自 `PAYOUT_ACCOUNT_ENCRYPTION_KEY`；启动时自检，密钥不对**进程直接起不来**。

---

## 文档

- 设计文档：[`docs/superpowers/specs/`](docs/superpowers/specs/)
- 实施计划与验收记录：[`docs/superpowers/plans/`](docs/superpowers/plans/)
- 各阶段的验收记录：
  [`阶段 1`](docs/superpowers/plans/2026-10-21-plan-01-acceptance.md) /
  [`阶段 2a`](docs/superpowers/plans/2026-10-22-plan-02a-acceptance.md) /
  [`阶段 2b`](docs/superpowers/plans/2026-10-22-plan-02b-acceptance.md) /
  [`阶段 3`](docs/superpowers/plans/2026-10-24-plan-03-acceptance.md) /
  [`阶段 4`](docs/superpowers/plans/2026-10-25-plan-04-frontend-polish-acceptance.md) /
  [`阶段 5a`](docs/superpowers/plans/2026-10-25-plan-05a-acceptance.md) /
  [`阶段 5b`](docs/superpowers/plans/2026-10-25-plan-05b-acceptance.md) /
  [`阶段 5c`](docs/superpowers/plans/2026-10-27-plan-05c-acceptance.md) /
  [`阶段 5d`](docs/superpowers/plans/2026-10-27-plan-05d-acceptance.md) /
  [`阶段 5e`](docs/superpowers/plans/2026-10-27-plan-05e-acceptance.md) /
  [`阶段 5f`](docs/superpowers/plans/2026-10-27-plan-05f-acceptance.md) /
  [`阶段 5g`](docs/superpowers/plans/2026-10-28-plan-05g-acceptance.md) /
  [`阶段 5h-1`](docs/superpowers/plans/2026-10-29-plan-05h-payout-ledger-acceptance.md) /
  [`阶段 5h-2`](docs/superpowers/plans/2026-10-29-plan-05h2-payout-execution-acceptance.md) /
  [`阶段 5i`](docs/superpowers/plans/2026-10-30-plan-05i-ledger-reconciliation-acceptance.md) /
  [`阶段 5j`](docs/superpowers/plans/2026-10-30-plan-05j-fund-security-ledger-closure-acceptance.md) /
  [`阶段 5k`](docs/superpowers/plans/2026-10-30-plan-05k-fund-closure-acceptance.md) /
  [`阶段 5l`](docs/superpowers/plans/2026-10-30-plan-05l-payout-ops-acceptance.md) /
  [`阶段 5m`](docs/superpowers/plans/2026-10-31-plan-05m-payout-reconciliation-acceptance.md)

---

## 推送到 GitHub

本仓库远端是 `gztcode/multi-tenant-ecommerce-saas`。常规 `git push` 即可：

```bash
git push -u origin <分支名>
```

**若 `git push` 超时失败**（某些网络环境下 `github.com:443` 不可达，但 `api.github.com` 可达），
改用仓库里的 API 推送脚本：

```bash
export GH_TOKEN=$(gh auth token)
node tools/push-via-api.mjs <本地分支> <远端分支>
```

它通过 Git Data API 手工构造 tree / commit / ref，效果与 `git push` 等价。

---

## 后续计划

| 计划 | 内容 |
|------|------|
| 计划 2a | 商品中心后端 —— **已完成并验收通过** |
| 计划 2b | 商品中心前端：主题 token、storefront 浏览页、商家后台 —— **已完成并验收通过** |
| 计划 3 | 交易链路：购物车 → 库存 → 订单 → 支付 —— **已完成并验收通过** |
| 计划 4 | 前端补齐与打磨 —— **已完成并验收通过**（有条件通过） |
| 计划 5a | 营销：优惠券与满减活动 —— **已完成并验收通过**（有条件通过） |
| 计划 5b | 平台计费：SaaS 订阅、套餐、额度、抽佣、报表 —— **已完成并验收通过**（有条件通过） |
| 计划 5c | 刷新令牌宽限期（RFC 9700）—— **已完成并验收通过** |
| 计划 5d | 主题统一 / 错误收口 / Redis 挂死 —— **已完成并验收通过** |
| 计划 5e | 抽佣流水明细 —— **已完成并验收通过** |
| 计划 5f | 支付可靠性 —— **已完成并验收通过**（有条件通过：浏览器手测未做） |
| 计划 5g | 结算单 —— **已完成并验收通过** |
| 计划 5h-1 | 出款申请与审批 —— **已完成并验收通过** |
| 计划 5h-2 | 真正打款与补差调账 —— **已完成并验收通过** |
| 计划 5i | 账目口径收口（报表切流水表 + 商家侧对账单）—— **已完成并验收通过** |
| 计划 5j | 资金安全与账务闭环（账户改密文存储 + 缺笔可见性）—— **已完成并验收通过** |
| 计划 5k | 资金链路收尾（解密失败落 FAILED + 商家端账户可见性 + 启动自检）—— **已完成并验收通过** |
| 计划 5l | 出款运维兜底（人工重试 / 解卡带留痕 + 失败口径分流 + 列表分页）—— **已完成并验收通过** |
| 计划 5m | 渠道对账（六类差异 + A 类自动纠正 + 四道闸人工处置 + CSV 导入 + 平台端界面）—— **已完成并验收通过** |

### 阶段 5m 之后的剩余技术债

阶段 5m 的验收记录 §六 逐条列了遗留。按主题归拢（**细节与取舍理由见该节**）：

**资金链路**

1. **漏结流水无主动告警** —— 出款侧的对账（5m）与账务侧的「缺笔」（5j）**没有打通**，
   一笔漏结的货款两边都不会主动报出来。
2. **出款单作废重开没有解** —— 出款单 `APPROVED` 之后想改金额，只能驳回让商家重新申请。
3. **「已付但渠道没记录」的单仍不能一键重试** —— 解卡闸能确认「渠道明确说没打」，
   但渠道**明确拒付**的单不在闸的放行范围内。
4. **`FAILED` 承载了两种语义** —— 「渠道试满 3 次」（钱**可能**已打）与「解密失败」（**确定**没打）
   共用一个状态。**不新增状态是刻意的选择**，代价是商家端只能用一句通用措辞。
5. **崩溃窗口没有自动恢复** —— 事务提交到 `markFailed` 之间进程崩溃，出款单会卡在 `PROCESSING`。
   5l 补了解卡按钮，但**没有自动恢复**。
6. **密钥配错会让一批出款单落 `FAILED` 且不会自愈** —— 修好密钥后要人工逐单重试。
7. **出款侧之外的账目没有对账** —— 结算单 / 抽佣流水 / 商家对账单的「缺笔」不在 5m 范围内。

**对账**

8. **渠道接口没有分页** —— 与「单次最多 10000 条」的上限冲突，真渠道接入前必须补分页或分片拉取。
9. **「渠道长期不返回终态」的单发现不了** —— 非终态一律不算差异（归入 g 档），
   强行分类会高频误报。
10. **CSV 导入的 A 类自动纠正没有人工确认闸** —— 运营把状态词映射成 `SUCCESS`，
    就能把卡在 `PROCESSING` 的单自动改成已付款。彻底堵住属设计层面的决定。
11. **渠道名只是任务上的标签** —— `loadLocalPayouts` 不按渠道过滤，
    同一时间窗导入两个渠道的账单会互相参与。
12. **`PROCESSING` 的单没有 `payoutChannel`** —— 按渠道取会取不到，导致解卡被拒。
    接第二家渠道时必须同时改 `firstProvider()` 与核实服务。
13. **两个性能问题** —— `summary` 端点全表扫（应改 `groupBy`）；
    详情的 `include: { items: true }` 是「捞完再截」（截断应做在查询层）。

**主题与前端**（阶段 5d 遗留）

14. 商家改字号时**行高比例不跟随**（CSS 不允许除以长度，需产品策略）。
15. **Tailwind 内置阴影刻度商家配不了**。
16. **`merchant-admin` 的多数中转路由仍用 `!session`**（当前 34 个路由文件、共 48 处）——
    结果正确，只多一次无用往返。
17. **部分 token 在 storefront 没有消费者** —— 配了看不到效果。
18. 其余：前端颜色选择器、`platform-admin` 的租户主题配置页、改密码时吊销令牌族、
    三份 `api-client` / `theme.ts` 重复、dark 模式从未启用。

**工具链与测试**

19. **`prisma migrate dev` 仍不可用**（3 条历史迁移 checksum 不符），照旧手写 SQL。
20. **5h-1 遗留的两条概率性 e2e flaky** —— `payment-compensation`「扫描 A…」与 `payout`「P7…」，
    原因是本进程的 BullMQ worker 抢走了测试自己入队的 job。
21. **告警基建缺失** —— 项目里只有 Logger，**没有告警**。
    连续多轮补偿都没处理掉的情况，运营不会收到任何信号。
22. **跨副本分布式刷新锁** —— 扩副本前必须做（5c 遗留）。

### 阶段 4 验收发现的下一阶段优先项（详见
[验收记录 §七](docs/superpowers/plans/2026-10-25-plan-04-frontend-polish-acceptance.md)）：

> ⚠️ 下面这份是**阶段 4 验收当时的原始清单**，保留作历史记录。
> 阶段 5m 之后哪些已完成，请看上面「阶段 5m 之后的剩余技术债」一节。

1. ~~**修多标签页的「先后」刷新竞态**~~ —— **阶段 5c 已做**：后端给轮换后的旧令牌
   加了**宽限期**（60 秒），宽限期内重复提交返回**同一枚**新令牌、不吊销令牌族。
   （「幂等刷新端点」那条备选路线没用上。）
2. ~~**给 `merchant-admin` 补组件测试基建**~~ —— **阶段 5b 已把同一套基建搬到 `platform-admin`**，
   `merchant-admin` 也已有组件测试；阶段 5c 把 `jwt` 回调的**决策逻辑**抽成纯函数模块
   `src/lib/jwt-callback.ts` 并补上了单测。
3. ~~**把分组标量（字阶 / 间距 / 阴影 / 字重）在前台接上消费者**~~ —— **阶段 5d 已做**。
4. ~~**修字体 token 在服务端就失效**~~ —— **阶段 5d 已做**。
5. ~~**统一前台的错误处理**~~ —— **阶段 5d 已做**。
6. ~~**给商家后台做主题实时预览**~~ —— **阶段 5d 已做**：主题表单带预览区，
   改主色/字体/字阶/字重/阴影/间距时预览区实时联动，且与后台自身的 UI 隔离
   （后台按钮不跟着店铺主题变）。
7. ~~**给 e2e 的队列做隔离 + 每轮清库**~~ —— **早已实现**（`BULLMQ_PREFIX=bull-e2e`
   + 每轮清库）。阶段 5c 实测确认：**不需要停 api 容器**，连跑 3 轮 e2e 均全绿。
8. **退货入库流程** —— 退款不回补库存是有意的取舍，但配套的退货入库始终没实现。

阶段 3 遗留、本阶段仍未解决的（详见阶段 4 验收记录 §六）：
跨店会员不支持、游客订单查不到、退款不回补库存、购物车金额是估算值、
`20261022071848_add_sku_stock_version` 迁移在全新库上会失败（不要动它）。
