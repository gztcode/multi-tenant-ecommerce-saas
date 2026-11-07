# 阶段 11 待修问题清单（评估结论）

> 生成时间：2026-11-05（当日收尾更新）
> 依据：主控独立核查 + 4 视角 RBAC 复核 + 7 维审计 workflow + 32 条对抗验证
> 状态：**已按 §六 顺序修完批次 1-11（全部批次）**，进度见 §〇。每条都标注了验证方式与修法方向。
>
> **统计**：P0 **6** 条 / P1 **5** 条 / P2 **29** 条（其中 4 条已被对抗验证**推翻或升级**，
> 实际待修 P2 为 **25** 条）。
> P1-5、P0-6、P0-7 是对抗验证与第二轮资金链路 workflow 阶段**后补**的；
> 原 P0-1（领券超发）经对抗验证**实测复现后降级为 P2-17**（low）；
> P2-B3 被对抗验证**推翻并降级**，P2-B5 升级为 P1-5，
> P2-B4 被对抗验证**实测推翻**、P2-B6 被变异测试**推翻**，原 P1-3（账目自检）降级为 **P2-A4**，
> P2-A3 是对抗验证补充的残余风险。
>
> **验证收尾状态（2026-11-05 晚）**：对抗验证 32 条中 **31 条交卷**（下文「第 N 条」按交卷到达序计），
> 唯一没跑的第 31 个 agent（账单支付单并发 P2002）由主控补核实 —— 结论已并入 **P2-11**（判定成立，级别 low）。
> 其余未完成的验证（8 个完整性批判 agent、第二轮资金链路 4 向中的 3 向、前端 BFF/nginx 扫描 5 向）
> 均因模型额度耗尽（429）中止 —— 未覆盖面如实记在**九**。
> P1-3 经对抗验证（到达序第 31 条）判定为 **medium**：触发前提是同订单双渠道各付一次，
> 当前生产形态没有任何可启用渠道；保持 P1 编号（资损性质），修法与 P0-3 是同一处。

## 〇、修复进度（按 §六 的顺序分批推进）

| 批次 | 条目 | 提交 | 状态 |
|---|---|---|---|
| 1 | P1-1 控制器 `@Roles`、P1-2 批量改价夹 0 | `f2e857c` | ✅ |
| 2 | P0-2 幂等键按消费者归属隔离（含唯一索引迁移） | `d704bfd` | ✅ |
| 3 | P0-4 无结算单出款 fail-closed | `b540024` | ✅ |
| 4 | P0-5 Redis 密码守卫、P0-6 消费端复核事件与金额、P2-A1 生产零渠道拒绝启动 | `ab213d4` | ✅ |
| 5 | P1-4 MinIO CORS 变量名、P2-7 bucket 自动创建、P2-3 登录失败限流 | `dc3cbdd` | ✅ |
| 6 | P0-7 券核销按用户维度隔离 | `2ef9676` | ✅ |
| 7 | P2-17 领券总量闸、P1-5 默认支付方式唯一索引与归属校验 | `ddb3703`、`2968d82` | ✅ |
| 8 | P2-B2 闸 ③ 用例、控制器角色限定静态扫描器、RBAC 注释纠错、对账写路由接线护栏 | `b371bae`、`13bca4f`、`e31e8ae`、`14778d9` | ✅ |
| 9 | **P0-3 支付回调状态机 + P1-3 双渠道退款** | `80dcc3c`、`474345c` | ✅ |
| 10 | P2-A4 账目自检补货款冲回检查 | `6f02d30` | ✅ |
| 11 | P2 各项（P2-9/9b/10 套餐额度、P2-5 三处 500、P2-15 时间戳纪律、P2-A3、P2-1/P2-1b/P2-2 依赖漏洞） | `40e3c54`、`b264ac5`、`ce98ae4`、`1c5d94c`、`3fb8550` | ✅ |
| 12 | P2-11 账单支付单 P2002、P2-16 保留子域名、P2-A2 自检告警、P2-6 CSV BOM、P2-12/P2-13/P2-8 文档口径 | `67f5168`、`831d0d4`、`b65763b` | ✅ |

### 批次 11 的实施记录（P2 各项）

**① P2-9 / P2-9b / P2-10 套餐额度（同一条链，5 个文件）**

三处改动必须一起做，少任何一处都不成立：

| 改动 | 文件 | 解决什么 |
|---|---|---|
| 额度检查进事务 + **先锁订阅行、再计数** | `api/src/modules/billing/quota.service.ts` | 并发击穿（P2-10） |
| SKU 计数排除 `INACTIVE` | 同上 | 改规格白吃额度（P2-9b） |
| 规格矩阵改**写后校验**（`delta = 0`） | `api/src/modules/catalog/specs/spec-matrix.service.ts` | 400 组合击穿 + 击穿后永久锁死（P2-9） |
| 软删商品时级联软删 SKU | `api/src/modules/catalog/products/products.service.ts` | 软删商品不释放 SKU 额度（P2-9b） |

三个设计取舍（都写进了代码注释，改动前先读）：

1. **光把检查搬进事务不够**。PostgreSQL 默认 READ COMMITTED，两个并发事务各自
   `count` 拿到同一个旧快照 → 双双放行。必须在计数**之前** `SELECT … FOR UPDATE`。
   顺序反了等于没锁（单测用 `calls` 数组钉住顺序）。
2. **锁的是 `subscriptions` 行，不是 `tenants` 的租户行**。租户行会被「插入任何带
   `tenantId` 的表」时的外键校验隐式加上 `FOR KEY SHARE`，它与 `FOR UPDATE` 冲突：
   规格替换是「先持租户行锁、再写 SKU」，下单是「先锁 SKU、再插订单（要租户行
   `KEY SHARE`）」—— 方向相反，正好凑成死锁环。订阅行没有外键引用它。
3. **规格矩阵用写后校验而不是预测增量**。「替换后到底剩多少个活跃 SKU」走完
   保留 / 新建 / 置 INACTIVE 才知道，预测增量算不准；写后校验口径唯一，
   且自动修好「击穿后连缩小矩阵都被拒」的永久锁死。代价是超限时白写一遍再回滚，
   写入量由 DTO 的 2 × 20 上限兜住。

**② P2-5 三处分页 / 时间参数**（`b264ac5`，8 个文件）

在 **api 侧**加 DTO 校验（不是改前端中转）：`products.controller.ts`、
`inventory.controller.ts`、`merchant-order.controller.ts` + 三个新 DTO + 新 e2e
`api/test/query-validation.e2e-spec.ts`。分页用 `@Type(() => Number) + @IsInt + @Min`；
时间用 `@Type(() => Date) + @IsDate`——**不用 `@IsDateString()`**，它会放过 `20260101`
这类「看着像日期其实不是」的输入。既有契约 `order.e2e-spec.ts` 相应由 200 改 400。

**③ P2-15 时间戳纪律**（`40e3c54`）：`payment.service.ts` 里建支付单时多余的
`updatedAt: new Date()` 删掉（`@updatedAt` 由 Prisma 管）。

**④ P2-1 / P2-1b / P2-2 依赖漏洞**（`ce98ae4`，8 个文件）：四个 `package.json` 加
`overrides`（三端 `@vitest/mocker` / `tinypool` / `postcss` / `body-parser`，
api `multer` / `body-parser`），四份 lock 重新 install 同步。
⚠️ **api 的 lock 原来记 `body-parser` 2.3.0、实际装 2.4.0** —— CI 的 `npm ci` 跑的是
有洞的那版，这就是 P2-2 的实体。结果：三端 high/critical 归零；
api 剩 3 条 high 全来自 `deepmerge-ts`（经 `@prisma/config`，只影响 prisma CLI），
**有意不修**（只能升 Prisma 7）。
⚠️ 本机 `npm audit` 对腾讯镜像报 404，需加 `--registry=https://registry.npmjs.org`。

**⑤ P2-A3 迁移后立即自检**（`3fb8550`）：`scripts/migrate-payout-encryption.ts`
直接复用启动自检 `PayoutEncryptionSelfCheck`（同一套判定，不另写一份），跑两次：
写库**前**用当前密钥试解库中已有的密文（解不开 = 密钥不对，中止且一行不写），
写库**后**再自检一次（失败即非 0 退出码，文案带备份表名与恢复指引）。
⚠️ **能抓什么要写清**：它挡住「已有密文用密钥 A、这次又拿密钥 B 加密一批」的混合密钥
事故；**全新库 + 首次迁移 + 密钥配错**两次都拦不住（自己加密自己解密永远自洽），
仍需人工核对脚本打印的密钥指纹 —— 这是 5j 设计里就承认的残余风险。

**验证**：api e2e 全量 **45 suites / 715 passed**（连跑两次）；新增
`quota.service.spec.ts` 8 条单测、`billing-quota.e2e-spec.ts` 6 条 e2e；
改动文件 `npx eslint` 与 `npx tsc --noEmit` 零问题。
**失败注入四处全部命中**（每次独占执行）：去掉行锁、SKU 计数不排除 INACTIVE、
去掉规格矩阵额度检查、不级联软删 SKU —— 对应用例分别变红，改回即绿；
另对迁移脚本注入「自检必失败」，确认退出码为 1 且文案正确。

**踩到的坑（后续改这块的人必看）**：

- **并发 e2e 是概率性的**，不能当唯一证据。第一版用 `Promise.all` 打 4 个 HTTP POST，
  去掉行锁后仍全绿：HTTP 请求在测试进程里被串行化了。改成直接并发调 service 仍不稳定
  （临时探针打出 `-t "P2-10"` 单跑是 `0,0,0,0`、全量跑是 `0,1,1,1`）。最终补了一条
  **确定性命中**用例：手动占住订阅行 → 断言 `products.create` 在 200ms 内不返回。
  去掉行锁后这条稳定报 `Expected: "waiting" / Received: "settled"`。
- 并发用例的并发数要**小于连接池**（CI 2 核 → Prisma 默认池 = 5）。
- **P2-B2 已在批次 8 完成**（闸 ③ 的 4 条用例 + P2002 双来源文案），本批未重复做。

**实施期发现、随后已一并修掉的五项**（批次 11 收尾后追加）：

| 事项 | 提交 | 说明 |
|---|---|---|
| 库存流水中转原样透传 query | `20a952b` | P2-5 之后该接口开了 `forbidNonWhitelisted`，未知参数会被判 400；改为按白名单重建，测试用完整 URL 精确断言 |
| `markEventProcessed` 的 `processedAt: new Date()` | `17213f7` | P2-15 的同类违反点；同时补了单测牙齿（原来只断言「调用过」，改回去也不会红） |
| catalog e2e 按数组下标取 SKU | `56b55ba` | 两处同根因（「规格减少置 INACTIVE」+「重算 minPrice」）：同事务创建的 SKU `createdAt` 相同、返回顺序不固定 |
| P2-15 的存量时钟（订单 / 认证 / 退款扫描） | `a7c0072` | 见下 |
| ⚠️ **登出会吊销全平台会话**（新发现，不在原清单里） | `d42115f` | 见下 |

**存量时钟收敛（`a7c0072`）**：`cancelOrder` 的 `cancelledAt`、`shipOrder` 的 `shippedAt`、
`confirmReceipt` 的 `completedAt`、建单的 `payExpiresAt`、`releaseExpiredOrderInTx` 的 `now`、
`logout` 的 `revokedAt`、`revokeTokenFamily` 的 `now`、`createRefreshToken` 的 `expiresAt`、
`scanRefunding` 的默认时间，全部改用库时钟。
口径：**事务内用 `tx` 的原生 `SELECT now()`**（调 `this.prisma` 会再借一条连接 → P2024），
事务外用 `databaseNow()`。
⚠️ **`payExpiresAt` 必须与超时释放的 `now` 一起改**：两者比大小，一个应用时钟一个库时钟，
支付窗口会整体偏移。复核时正是靠「新注释声称同源、实际只有一侧改了」发现的。
排除在外（不是落库时刻）：`deletedAt` 软删标记全仓 16 处、`generateOrderNo()` 的日期前缀。

**⚠️ 登出缺陷（`d42115f`，严重度高于本清单剩余全部 P2）**：
`logout()` 原来写 `where: { id: stored?.id, revokedAt: null }` —— 令牌不存在时
`id: undefined`，而 **Prisma 会把值为 `undefined` 的过滤键整个丢掉**，
`updateMany` 退化成 `where: { revokedAt: null }` → **吊销全平台所有用户的未吊销令牌**。
登出只要访问令牌，任何登录用户传一枚长度合法但不存在的令牌就能把所有人踢下线。
修法：不存在时直接 `return`（正是原注释写的「静默成功」），并补 e2e：
A 用不存在的令牌登出后，B 的令牌仍能刷新；失败注入该用例变红。

**仍未动（需另行决定）**：

- `Plan.maxStores` 全仓没有执行点（没有创建店铺的接口）。⚠️ **产品已确认要多店铺**，
  因此额度字段保留，等店铺创建接口落地时再接入执行点；
- `test/cart.e2e-spec.ts`「并发加购同一 SKU 两次」偶发其中一个请求返回 400。
  2026-11-07 复跑单用例 6 轮、整文件 4 轮、全量 4 轮**都没能复现**；静态分析也对不上
  —— `addItem` 只有两处 400（SKU 查不到 / 超过上限 99），在这个用例的数据下都不该发生，
  全局异常过滤器也不把 P2002 映射成 400。**未定位，保持观察**（临时探针已撤）。

### 批次 12 的实施记录（P2 收尾与文档口径）

批次 11 收尾后逐条回扫清单，剩下这七条确实没落地（此前误以为已随批次 11 覆盖）。

**① P2-11 账单支付单 P2002（`67f5168`）**
`obtainInvoicePayment` 的 `create` 包 try/catch：`isUniqueViolation(error)` 时在**事务外**
重查 `(invoiceId, channel)`，查到就走既有的「复用支付单」分支（沿用该分支原有的口径：
`SUCCESS` 抛 409，其余重置为 `PENDING`），查不到或非 P2002 才抛原错误。
三条单测：并发命中复用、P2002 重查为空抛原错误、**非 P2002 即使重查能命中也必须抛**。
失败注入：把 `isUniqueViolation(error) ? … : null` 改成无条件重查 → 第三条变红，恢复后全绿。

**② P2-16 保留子域名补 `merchant`（`831d0d4`）**
`RESERVED_SUBDOMAINS` 按字母序插入 `'merchant'`。依据是 nginx 的匹配顺序
（精确 > 正则 > 通配符 > 默认 server）：`infra/nginx/platform.test.conf` 里
`server_name merchant.platform.test;` 是精确匹配，而租户店铺走泛域名正则。
不保留的话商家能注册该子域名，注册接口会通过，但店铺前台永远被路由到商家后台。
测试侧：`it.each` 会按集合动态展开（新增条目自动进入），但**钉不住「被误删」**，
所以在「保留名单非穷尽」用例里补了显式断言 + `extractSubdomain('merchant.platform.test')` 为 null。

**③ P2-A2 加密自检无样本时告警（`831d0d4`）**
`check()` 在两表都取不到 `encryptionVersion = 1` 的行时输出一条 `warn`
（「库中无已加密样本，密钥正确性未经校验……」）。**没有改成硬失败** ——
新库、还没跑迁移的库本来就不该因此起不来（原注释的判定仍然成立）；
改的是「静默」：否则「密钥配错」与「库里本来没数据」在启动日志里完全一样，自检等于没跑过。
日志直接打在服务内（`new Logger(...)`），因为启动调用点 `main.ts` 不消费返回值。

**④ P2-6 结算单 CSV 的 BOM（`b65763b`）**
上游控制器自己在响应体开头加 BOM（U+FEFF），但 BFF 用 `response.text()` 读，WHATWG 规定 TextDecoder
会**剥掉 BOM** → 到浏览器就没了。`merchant-admin` 的商品导出是在 BFF 侧补的，
两端写法早已漂移；本次统一到 BFF 侧补（在 `await response.text()` 前拼一个 `\uFEFF`），
**没有动上游控制器**（别处可能直接把上游响应当 CSV 用）。
测试必须按 `arrayBuffer()` 原始字节断言：`response.text()` 自己也会剥 BOM。
除了「前 3 字节是 `EF BB BF`」，还断言第 4 字节是 `0xE7`（「结」的首字节）——
只查前 3 字节发现不了加了两遍 BOM 的情况。失败注入：故意加两个 BOM → 用例变红。

**⑤ P2-12 / P2-13 / P2-8 文档与注释口径（本提交）**
- README「一键启动（Docker）」→「全栈容器（Docker）」，如实写明 compose 是 production 姿态
  且内置默认凭据，命令原样跑不起来；本机联调走 `npm run start:dev`。
  ⚠️ **没有改 `infra/docker-compose.yml` 的 `NODE_ENV`**：改成 development 会让非生产默认的
  `fake` / `fake-payout` 渠道生效，属安全姿态变更，不在技术债清理范围。
- README 阶段 4 优先项：删掉「刷新令牌宽限期」（阶段 5c 已实现），并注明原第 1 条已实现、其余顺延。
- AGENTS.md：把「三个前端没有共享包」改为共用 `packages/frontend-shared`；同时改掉
  「`lib/jwt-callback.ts` 两份逐字节相同」的旧指引（实测三端各只有一句 `export *`，
  逻辑单源在共享包，按旧指引手工同步会让令牌逻辑静默分叉）。
  另修正「两个开关关着 compose 的 api 就能正常启动」—— 阶段 9 的凭据校验同样会拒绝占位密钥。
- `schema.prisma` 的 `InventoryMovement.operatorId` 注释改为「人工调整填操作人（店主 / 员工）id；
  预占/释放一律为 null」（P2-8 的建议原文就是改注释）。

**验证**：api `tsc --noEmit` 零错误；改动文件 `npx eslint` 零问题；`scan:tx-boundary` 0 处；
三个相关 spec 共 119 条全绿；全量 e2e **45 suites / 716 passed**；平台端 vitest 3 条 +
`tsc` + `eslint` 全绿；两次失败注入确认新用例有牙齿（见上）。

### 批次 10 的实施记录（P2-A4）

**修法**：在 `checkLedger()` 的判定顺序里加第 7 步 —— 已退款、有退款时间、有货款额，
但不在 `reversalReceiptOrderIds` 里 → 记 `receiptReversalMissing` 并纳入 `hasGap`。
脚本摘要与明细补上「缺货款冲回流水」。

**⚠️ 谓词必须用 `totalAmount` 不是 `commissionAmount`**（原条目已写明，这里是落地确认）：
货款侧的 `shouldBackfillReceiptReversal`（`receipt.service.ts:66-81`）按 `totalAmount`
判零额，抽佣侧才按 `commissionAmount`。照抄会把「零佣金但有货款」的正常订单误报成缺口
→ 脚本永远 exit 1 → 防线变成噪音。已加一条锚点用例专门钉住这条。

**`undatedRefundCount` 口径顺手对齐**（原条目要求）：拆成两侧分开统计 ——
`undatedRefundCount`（抽佣侧）与 `undatedReceiptReversalCount`（货款侧）。
零佣金订单不再计入抽佣侧（它本来就没有抽佣冲回可写）。

**验证**：api 单测 64 suites / 1049 passed（`ledger-check.spec.ts` 32 条）；
改动文件 `npx eslint` 零问题；`scan:tx-boundary` 0 处。
另做一次**受控写入验证**（开发库造一条「已退款 + 零佣金 + 有货款额但缺 `SALE_REVERSAL`」
的订单）→ 脚本报「缺货款冲回流水：1 单」且退出码 1；补上冲回行 → 报 0 且退出码 0；
验完已清理临时数据。⚠️ 开发库里原本**没有任何 `REFUNDED` 订单**，空跑得出的「0 缺口」
不能证明新检查有效 —— 所以必须写数据实跑。

**批次 9 与 10 的验证纪律提醒**：改自检/判定逻辑时，「脚本跑出来是 0」**不能**当作
「检查有效」的证据 —— 先确认被检查的数据集里**真的有那条数据**。

### 批次 9 的实施记录（P0-3 / P1-3）

**修法定型**（设计阶段推翻了两个初始设想）：

1. **不能「整笔回滚」**。支付单置 `SUCCESS` 与订单流转在同一个事务里，抛异常回滚等于把
   「钱已经收了」这个事实抹掉；而事件已被 `markEventProcessed` 标记成已处理 → 补偿扫描
   再也救不回来。→ 改为落一个新状态 `NEEDS_REFUND`（已收款待退款）并 `logger.error` 告警。
2. **判别式用 `paid.count`，不是订单状态**。`paid.count === 1` = 本次新确认了一笔收款
   （钱确实收了，订单接不住 → 必须退）；`paid.count === 0` = 重复投递（什么都不做）。
3. **订单级动作的判据从「支付单原状态」改成「事务内订单当前状态」**。这解开了
   「订单级动作只能做一次」与「多渠道第二笔不能卡死」的矛盾：`PAID`/`SHIPPED` → 转
   `REFUNDED` + 记冲回；`CLOSED`/`CANCELLED`/`REFUNDED` → 只退钱、不记冲回；
   条件更新抢不到时**跳过而非抛异常**（抛了整笔回滚 → 支付单退回 `REFUNDING` → 永远卡死，
   正是 P1-3 的根因）。
4. **本期不做部分退款**：整单退款退全部候选在钱上是平的（客户付两次拿回两次，冲回只记一次）。
   部分退款需要新的金额语义与对账口径，超出本阶段。

**实施中新发现并一并修掉的洞**（不属于原审计清单，但由本批次引入）：

`releaseRefundClaim` 会把「已收款待退款」的支付单退回 `SUCCESS`（渠道明确拒付时放开闸门
让商家重试）。若商家后台的「待退款」按支付单状态判定，提示就会消失——P0-3 刚补的出口
自己关上。→ 口径改为「**订单结没结算**」：订单未结算时该单上任何已收款支付单都算待退款；
订单已结算时只算标着 `NEEDS_REFUND` 的。口径抽到 `order/order-status.ts` 的 `isSettled()`，
账目自检与商家侧统计共用一份定义。

**验证**：api 单测 64 suites / 1043 passed；api e2e 44 suites / 697 passed；
`tsc --noEmit` 零错误；`scan:tx-boundary` 0 处；三端 vitest 444 / 228 / 475 全绿；
`check:ledger` 在开发库正常退出。两次失败注入确认新用例有牙齿。

**⚠️ 未完成的自动化审查**：批次 9 派出的 5 个对抗式审查代理（4 维度 × 反驳 + 汇总）
全部因模型额度耗尽（429）中止，**0 条有效结论**。上面的缺陷是主线程人工自查发现的，
不代表审查已覆盖。

### 新发现、尚未修的相邻洞

- **`createPayment` 复用 `FAILED` 支付单时不重置为 `PENDING`**（`payment.service.ts`）。
  对比 `obtainInvoicePayment` 对账单有重置逻辑。后果：用户第二次点支付拿到同一个「已完成」
  的支付单，后续的成功回调被 `attachProviderTxnId`（`where` 带 `status: PENDING`）丢弃
  → **客户付了钱、订单永远卡在待支付**。
  不在本审计清单内；修复需要独立设计（支付单复用语义 + 渠道幂等号），单列待办。

---

## 一、P0 —— 直接资损或信息泄漏

### P0-2 下单幂等键不校验消费者归属 → 拿到别人的订单

- **位置**：`api/src/modules/order/order.service.ts:142`
- **机制**：`findByIdempotencyKey(tenantId, idempotencyKey)` 只按租户 + 键查
  （唯一索引 `orders_tenant_idempotency_uniq` 是 `(tenantId, idempotencyKey)`，不含 customerId），
  命中后直接 `return this.readOrder(existing.id)`，而 `readOrder` 只按 id 查。
- **失效场景**：消费者 A 下单（幂等键 K）→ 消费者 B 用同一个 K 下单 →
  B 直接拿到 A 的整张订单：`receiverName`、`receiverPhone`、省市区详址、`remark`。
  B 自己的订单根本没创建。
- **验证**：主控已在隔离库实测（库内只有 A 的 1 条订单，B 的请求返回 200 + A 的收货信息）。
- **⚠️ 有两条路径，修的时候要一起改**：
  1. 幂等快路径（`order.service.ts:141-148`）
  2. **并发重查分支**（`order.service.ts:201-208`，事务外撞 `orders_tenant_idempotency_uniq` 后重查）
     —— 也用 `findByIdempotencyKey` + `readOrder`，同样不校验归属。
     只改第 1 条的话，并发场景仍漏。
- **对照**：`GET /orders/:orderNo` 用的是 `readConsumerOrder`（带 `customerId: owner`），
  `cancelOrder` / `confirmReceipt` 也先 `findConsumerOrder` —— **只有幂等快路径漏了**。
- **修法**：⚠️ **只改 where 不够，会把「泄漏」变成「500」**（第三方验证实测得出）。
  把 `findByIdempotencyKey` 的 where 加上 `customerId: owner` 之后，
  B 的插入仍会撞 `orders_tenant_idempotency_uniq`（`(tenantId, idempotencyKey)`，不含 customerId）
  → 走 `order.service.ts:201-207` 的 P2002 分支 → 重查（此时 where 已含 customerId）查不到
  → `throw error` → **500**。
  → **必须同时把唯一索引迁移成 `(tenantId, customerId, idempotencyKey)`**。
  （「命中后校验 `existing.customerId !== owner` 就抛冲突」这条单独用也不够 ——
   它同样走 P2002 分支，落进同一个 500。需要一条独立的错误路径：
   命中且归属不符时**直接抛 409**，不进 P2002 重试分支。）
  → **这意味着要新增一条数据库迁移**（改唯一索引）。当前定义在
  `prisma/migrations/20261024093418_add_transaction_tables/migration.sql:205`：
  ```sql
  CREATE UNIQUE INDEX "orders_tenant_idempotency_uniq"
    ON "orders" ("tenantId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;
  ```
  按 AGENTS.md 的约定，`prisma migrate dev` 不可用 → **手写 `migration.sql`**，
  用 `npx prisma migrate diff` 核对，再 `npx prisma migrate deploy`。
  ⚠️ 已落库的迁移**不要改**（checksum 会变）→ 必须**新增**迁移文件。
- **两条可选修法（择一）**：
  - **A（推荐，要迁移）**：改唯一索引为 `(tenantId, customerId, idempotencyKey)`，
    并把 `findByIdempotencyKey` 的 where 加上 `customerId: owner`。
    语义最正确：**幂等键本来就应该是「每个消费者各自的」**，
    不同消费者用同一个键各下各的单，互不干扰。
  - **B（不迁移，但两条路径都要改）**：保留现有索引，
    在**快路径**（`:141`）与 **P2002 分支**（`:201`）两处都加上
    「查到的订单 `customerId !== owner` → 直接抛 `ConflictException`（409）」，
    **不进 `readOrder`、也不落进 `throw error`**。
    ⚠️ B 的坑：只改快路径不够 —— 并发场景走的是 P2002 分支，
    两处必须同时改，否则并发下仍是 500 或泄漏。

### P0-3 订单超时关闭后到达的支付回调 → 钱收了货不发

- **位置**：`api/src/modules/payment/payment.service.ts:820`
- **机制**：先 `tx.payment.updateMany({... status: PENDING → SUCCESS})`，
  之后才 `orderService.transitionInTx(PENDING_PAYMENT → PAID)`。
  后者受影响 0 行 → `!won` → **直接 return（事务照常提交）**。
- **失效场景**：订单 15 分钟超时被关成 CLOSED（库存已释放可再售）→
  渠道回调到达 → 支付单落 SUCCESS、订单停 CLOSED →
  无 DEDUCT / 无抽佣 / 无货款流水（`check-ledger` 看不到，因为 `paidAt` 为空）→
  退款也不行（`refund()` 要求 PAID/SHIPPED）→ **钱收了货不发**。
  事件还被 `markEventProcessed` 标记已处理，补偿任务永不重投。
- **已核实的关键前提**：
  - 超时 worker（`order-timeout.service.ts`）**只改订单状态 + 释放库存，不动支付单** →
    支付单仍是 `PENDING`，所以回调里的 `payment.updateMany` 会**成功**置 SUCCESS。
  - `applyEvent` 的收尾（`payment.service.ts:1892`）在事务**外**无条件调
    `markEventProcessed(event)` → 事件被标记已处理，补偿队列不再重投。
- **修法方向**：支付单与订单的状态转换要么一起提交（失败则整笔回滚），
  要么在 `!won` 分支把支付单也回退 / 落「已收款待人工处理」状态并告警。
- **⚠️ 与 P0-6 是两个不同的问题，别合并修**：
  - **P0-3**：回调**确实经过**了验签与金额核对（HTTP 端点做的），是**状态流转**失败
    （订单已不在 `PENDING_PAYMENT`）导致的「支付单 SUCCESS + 订单没流转」不一致。
  - **P0-6**：回调**根本没经过任何校验**（直接投递 job），是「缺校验」导致的状态被凭空改写。
  - 两者都要修，但根因不同、位置不同（P0-3 在 `applyEventInTx` 的 `!won` 分支；
    P0-6 在 `applyEvent` 的入口处）。
- **⚠️ 对抗验证第 25 条（real=true, sev=high）补充的三点**（主控已逐条核实）：
  1. **CANCELLED 路径同样成立，且触发条件更常见** ——
     `cancelOrder`（`order.service.ts:806-826`）也只改订单 + 释放库存、**不动支付单**；
     真实渠道的延迟回调（数秒到数分钟是常态）落在「已取消」的订单上，
     与超时关闭是同一个失效路径。→ **不止 15 分钟超时这一条触发源**。
  2. **平台内没有任何补救路径**（比「货不发」更严重）——
     `refund()`（`payment.service.ts:1037-1038`）要求订单状态是 `PAID` 或 `SHIPPED`
     → 这个订单两个都不是 → **商家在系统内给不出退款**（409），只能线下或改库处理。
     全仓**仅此一个退款端点**（`payment.controller.ts:63`）。
  3. **静默卡住、不会告警** ——
     `check-ledger` 脚本只查 `paidAt: { not: null }` 的订单
     （`scripts/check-ledger.ts:104`）→ CLOSED/CANCELLED 订单 `paidAt` 为空 → **查不出来**；
     且全仓**无「孤儿 SUCCESS 支付单」扫描器** → 没有任何巡检会发现这些单。
     事件又被 `markEventProcessed` 标记已处理 → 补偿扫描永不重投。
  - ⚠️ **当前尚无生产支付渠道**（仅有的两个实现 `fake` / `sandbox` 都是 devOnly：
    生产**配置了**会被启动校验拒绝；**不配**则启动放行但运行时 409（见 P2-A1）→
    生产形态下支付流程整体不可用）→ 这条在真实渠道接入后会**立刻变成高频问题**。

### P0-4 出款把「没有结算单」当成「佣金 = 0」

- **位置**：`api/src/modules/billing/payout.service.ts:1517`
- **机制**：`const commissionAmount = statement ? statement.netAmount : 0;`
  且 `assertStatementConfirmed` 对 `statementStatus === null` 直接放行。
- **失效场景**：结算单**只能超管手动 `POST /platform/settlements` 生成，无定时任务** →
  已核实：全仓无 `@Cron` / `@Interval`，6 个队列 worker（token-grace / order-timeout /
  renewal / webhook / compensation / payout）里**没有任何结算单生成任务** →
  超管漏跑 → 该期没结算单 → 佣金算 0 → 商家按**货款全额**申请出款 → 平台白送佣金。
- **⚠️ 同一件事有两套规则，且能打钱的那套是错的**（第三方审计发现，我已核实）：
  - `api/src/modules/billing/ledger.ts:237`（商家端「可申请」判定）：
    ```ts
    if (input.commissionAmount === null || input.statementStatus === null) {
      return { kind: null, reason: '该期的结算单尚未生成' };
    }
    ```
    → **明确 fail-closed：无结算单不可出款**。
  - `api/src/modules/billing/payout.service.ts:1460`（出款写路径）：
    ```ts
    if (status === null || status === SettlementStatus.CONFIRMED) { return; }
    ```
    → **对 null 放行**。
  → 两套规则矛盾，且**出款写路径那套能真正把钱打出去**。
- **商家端的可见形态（我已核实 `availablePeriods`）**：
  `payout.service.ts:1382-1388` 把 `commissionAmount` 兜成 `0`、
  `netAmount = receiptAmount`（货款全额）→ 商家在申请页看到
  「平台佣金 ¥0.00 · 应结 ¥100.00」→ 点申请 → `apply()` 真的放行。
  **这不是后台隐患，是商家能看见、能点的路径。**
- **设计意图**：设计文档 D8 说「没有结算单」是给**零额抽佣商家**的例外，
  但代码里「结算单不存在」和「零额抽佣」**不可区分**。
- **口径已核实**：`statement.netAmount = grossAmount + reversalAmount` = **净佣金**
  （`settlement.ts:140`），所以「有结算单时用 `statement.netAmount` 当佣金」是**对的**；
  缺陷**只在 null 分支**（无结算单 → 佣金 0）。
- **关键事实**：`CommissionEntry` 表本就记录了每笔抽佣（`amount` / `rateBps` / `baseAmount`），
  可以据此判断「该期是否真的零额抽佣」，不必靠结算单存在与否做代理指标。
- **修法方向**：**fail-closed，与 `ledger.ts:237` 对齐** —— 无结算单（`statementStatus === null`）
  时在**申请与审批**两个动作上直接 409，不要把佣金兜成 0。
  ⚠️ **不要用「回落聚合 `CommissionEntry`」** —— 结算单是**已冻结的凭证**，
  重新聚合会与结算单的冻结值对不上（这正是 `computeAmounts` 注释里已经写明、
  并且要求「以结算单为准」的原因）。
- **⚠️ 但「一律 fail-closed」会误伤零佣金商家（对抗验证第 26 条的关键补充，主控已核实）**：
  - **零额抽佣不记流水**：`shouldBackfillCommission`（`commission.service.ts:110`）
    对 `commissionAmount === 0` 返回 false → 免费套餐（费率 0）的商家**没有任何抽佣流水**。
  - **结算单生成覆盖不到它**：`SettlementService.generateOne`
    （`settlement.service.ts:305-309`）在 `entriesInPeriod` 为空时返回 `{ kind: 'empty' }`
    → **零佣金商家天然没有结算单**。
  - → **「无结算单」有两个截然不同的含义**：
    ① 「这一期**本该有**佣金，但超管漏跑了结算单」→ **必须 fail-closed**（资损）
    ② 「这一期**真的**零佣金」→ **应该允许出款**（不能误伤）
  - → **修法必须区分这两种情况**：不能只判「有无结算单」。
    可行的判据是**该期是否有抽佣流水**（`CommissionEntry`）：
    有流水但没结算单 → 漏跑 → 409；没流水 → 真零佣金 → 允许，佣金就是 0。
    ⚠️ 这与「不要回落聚合 `CommissionEntry` 算佣金」**不冲突**：
    **`CommissionEntry` 只用来判断「该不该有佣金」，不用来算佣金数值**
    （数值仍以结算单为准）。
- **⚠️ 损失幅度要算准（对抗验证纠正）**：损失 = **佣金率**（套餐 `commissionBps`，
  种子数据 500 = 5%），**不是货款全额** —— 商家拿到的货款全额本就是其应得，
  平台少收的是佣金那一部分。
- **⚠️ 还有一道人工闸**：平台审批（`approve`）会重算并锁进 `APPROVED`
  （`payout.service.ts:637-641`），审批页会显示「佣金 ¥0.00」→ 细心的超管能看出异常；
  但平台端详情页**不展示 `statementId`** → 没有「该期结算单不存在」的显式提示。
- **⚠️ 执行层的三道闸拦不住这个**（我核实 `payout-execution.service.ts`）：
  - 闸：明细金额合计 == `payout.receiptAmount`（`:621`）
  - 闸：明细笔数 == `payout.entryCount`（`:626`）
  - 闸：`netAmount == receiptAmount − commissionAmount`（`:631`）
  → **三道全是「内部自洽」校验**。「佣金 0、净额 = 货款全额」这一组值
  **完全自洽** → 三道闸全过 → 钱按货款全额打出去。
  → 所以必须在**上游**（申请 / 审批）fail-closed，执行层救不了。
- **审批时也会重算并锁定**（`payout.service.ts:566-590`）：`approve` 走
  `computeAmounts` 重算 → 把重算值写进 `receiptAmount` / `commissionAmount` / `netAmount`
  → **「佣金 0」被锁进 APPROVED 单，执行时按这个数打款**。
  → 申请与审批**两处都要改**。

### P0-5 生产环境启动校验放过 compose 默认 Redis 密码

- **位置**：`api/src/common/config/assert-secure-config.ts:97-102`
  （⚠️ **行号更正**：对抗验证第 31 条指出，我原写的 `:145` 是 `assertJwtSecret()`
  的收尾大括号，**Redis 判空实际在 97-102 行**；原文引用逐字属实）。
- **机制**：`assertProductionCredentials()` 里数据库密码与 MinIO 密码都检查了
  compose 默认值（`COMPOSE_DEFAULT_DB_PASSWORD` / `COMPOSE_DEFAULT_MINIO_PASSWORD`），
  **唯独 Redis 只判空**。
- **失效场景**：compose 默认的 Redis 密码已提交进 git（提交 `e6305c2`）→
  `NODE_ENV=production` + 默认密码 → `assertSecureConfig()` **放行**（主控已实测）→
  任何能连到 redis 的人可读写全部队列（`bull:payout` / `bull:billing` / `bull:payment-webhook`）。
- **⚠️ 触发前提要写准（对抗验证第 31 条补充）**：
  **不是「compose 全默认就能起」** —— compose 全默认启动会先被 `assertJwtSecret` 的
  占位符检查拦下（实测报错「生产环境禁止使用示例/默认的 JWT_SECRET 占位符」）。
  真实触发路径是：**运维为过生产而换掉 JWT / 账目密钥，Redis 默认值残留** ——
  而这恰恰源于**守卫自身的不一致**（DB / MinIO 查默认值，Redis 只判空），
  容易让人误以为 Redis 也被覆盖了。
  → `KNOWN_PLACEHOLDER_SECRETS`（`placeholder-secrets.ts:18-27`）只有 4 个
  JWT / 账目密钥值，**不含 Redis 密码**。
- **⚠️ 密码本身零秘密**：默认值由提交 `e6305c2` 写进 git，且远端仓库是 **PUBLIC**
  （对抗验证用 `gh repo view` 确认）。
- **修正（代理说的「重复打款」不成立）**：`claimForExecution` 有
  `where: { id, status: APPROVED }` 条件更新，同一单只能打一次钱。
- **⚠️ 危害面比原先记的更大（主控二次核实）** —— **投递一个 job 就能把任意订单标记为已支付**：
  - 消费端 `WebhookWorker.process`（`api/src/modules/payment/webhook.worker.ts:87-121`）
    **只重建租户上下文并直接调 `applyEvent`，既不验签、也不核对金额**。
    验签与金额核对（`checkWebhookEvent`，`payment.service.ts:596-637`）**只发生在
    webhook HTTP 端点**（`webhook.controller.ts:174`），消费端完全不复核。
  - → 能写 Redis 的人，`LPUSH` 一个 `payment-webhook` 队列的 job，
    带上 `tenantId` + `referenceNo`（订单号）+ `amount` + `success: true`，
    即可让订单转 `PAID`、记 `DEDUCT` 库存流水、记抽佣与货款流水。
  - 订单号格式是 `日期 + 10 位 36 进制随机`（`order.service.ts:1135`），
    约 51 bit 熵 —— 不可暴力枚举，**但订单号不是秘密**：
    它会出现在商家后台搜索框、支付跳转 URL、日志里。知道一个订单号就够。
  - **金额可以随便填**：消费端不核对，所以「实付 1 分钱」照样能流转成 `PAID`，
    订单全额（`order.totalAmount`）被记为商家应收 → **直接资损**。
  - 攻击还需要知道 `tenantId`（job 的 `tenantId` 决定作用域）。这同样不是秘密：
    商家的子域名是公开的，租户 id 可由子域名反查得到。
- **危害汇总（按可操作性排序）**：
  1. **伪造支付成功** → 订单转 `PAID`、记全额货款流水 → 商家以为收到钱，
     消费者没付钱 → 后续出款按「已收货款」计算 → **平台赔钱**。
  2. **提前触发出款 / 对账** → 投递 `payout` 队列的 `execute` job。
     有 `status: APPROVED` 条件更新保护，但可以把「审批后、扫描前」的单提前打掉。
  3. **删除待处理 job** → 卡住支付回调（用户已付款、订单永不流转、库存永远预占）。
  4. **读队列内容** → 拿到全部 `tenantId` / `payoutId` / 订单号（横向铺开更容易）。
- **修法**：
  - ① 加 `COMPOSE_DEFAULT_REDIS_PASSWORD` 常量 + 比对，模式与数据库密码一致
    （**必做，但只是把门锁上，不解决已泄漏场景**）。
  - ② **消费端补金额核对**（见 **P0-6**）—— 这条**独立于 Redis 密码**，
    即使队列被写，金额对不上也不流转。**建议与 ① 一起做**，
    它把「写队列」从「任意金额付款」降级为「金额必须正确才能付款」，
    但攻面仍大（金额可以照抄订单总额）。
  - ③ 更彻底：**消费端不信 job 里的金额**，金额一律从订单/支付单反查
    （与「租户从订单反查」同一思路）。

### P0-6 支付回调的**消费端**不验签、不核对金额（与 P0-3 是两个问题）

> 来源：主控在核实 P0-5 的 Redis 攻击面时发现。与对抗验证 workflow 无关。

- **位置**：`api/src/modules/payment/webhook.worker.ts:87-121`
  （对比：`api/src/modules/payment/webhook.controller.ts:152-180`）
- **机制**：**验签与金额核对都只发生在 webhook 的 HTTP 端点**：
  - 验签：`webhook.controller.ts:153` `provider.parseWebhook(raw, headers)` → 失败 401
  - 金额核对：`webhook.controller.ts:174` → `paymentService.checkWebhookEvent(event, kind)`
    → `payment.service.ts:628` 比 `event.amount !== order.totalAmount` → 不符就拒绝
  - **消费端（`WebhookWorker.process`）两件事都不做**：只 `runForTenant(data.tenantId, ...)`
    然后直接 `applyEvent(event, data.tenantId, data.kind)`。
- **⚠️ 边界要说准（主控核实）—— 只有「订单支付」这一条路径缺**：
  - **退款消费端有金额核对**：`applyRefundEventInTenant`（`payment.service.ts:1484`）
    比 `event.amount !== payment.amount` → 不符就拒绝流转。
    注释明写「不核对的话，一条伪造的回调就能把一笔『没付够的订单』标成已退款」。
    → 退款路径**不受本条影响**。
  - **订阅消费端也有金额核对**：`applySubscriptionEvent`（`payment.service.ts:1919`）
    比 `invoice.amount !== event.amount` → 不符就拒绝（护栏 M10）。
    → 订阅路径**不受本条影响**。
  - **缺的只有订单支付路径**：`applyEvent` → `applyEventInTx` 全程不碰 `event.amount`
    （`grep` 确认：`payment.service.ts` 里 `event.amount` 只在 :609/:628（HTTP 端点路径）、
    :670/:761（写入事件行 / 入队）、:1484（退款消费端）、:1919（订阅消费端）出现，
    **订单支付消费端的 `applyEvent`/`applyEventInTx` 一次都没用**）。
- **失效场景（能写 Redis 的人，或任何能改写 job payload 的路径）**：
  投递一个 `payment-webhook` 队列的 job，payload 写
  `{ tenantId, kind: 'ORDER', eventId, provider, channel, providerTxnId,
     referenceNo: <订单号>, amount: 1, success: true }`
  → `applyEvent` 反查到订单 → 支付单转 SUCCESS → 订单转 PAID →
  记 `DEDUCT` 库存流水 + 抽佣流水 + 货款流水（**全额** `order.totalAmount`）
  → 商家以为收到钱、后续出款按「已收货款」计算 → **平台赔钱**。
  **金额填 1 分钱照样流转**（消费端不核对）。
- **为什么这不是 P0-3 的一部分**：P0-3 是「订单流转失败但支付单已置 SUCCESS」
  （并发/超时导致的**状态不一致**）；本条是「**根本没经过任何校验**」。
  两者都要修，但根因不同、位置不同。
- **已有的部分缓解**：
  - 消费端仍受**状态条件更新**保护（订单非 `PENDING_PAYMENT` 不流转、支付单非 `PENDING` 不改）
    → 不能重复扣、不能改已付订单。
  - `attachProviderTxnId` 会拒绝「同一渠道交易号落到别的订单」。
  - **补偿扫描路径是安全的**：`compensation.service.ts:138` 重投前**重新调 `checkWebhookEvent`**
    （含金额核对）—— 所以「事件行已落库但处理失败」这条补偿路径不漏。
  - 缺口**只在「直接投递一个未经 `checkWebhookEvent` 的 job」这条路径**。
- **⚠️ 攻击所需的两个信息都容易拿到（主控复核）**：
  - **`tenantId`**：webhook job 的 payload 里**本来就带着 `tenantId`**
    （`webhook.worker.ts:14`）→ 攻击者只要**读一次队列**（`LRANGE` / `KEYS`）
    就能拿到全部租户的 id，不需要枚举。
  - **`referenceNo`（订单号）**：格式是 `日期 + 10 位 36 进制随机`（`order.service.ts:1135`，
    约 51 bit 熵）→ **不可暴力枚举**，但**订单号不是秘密**：
    它会出现在商家后台搜索框、支付跳转 URL、日志里。
    拿到 `tenantId` 后还可用「列出该租户订单」的接口拿到订单号
    （前提是该接口需要登录，见 P1-1 —— 但 P1-1 恰好让消费者令牌能读部分订单数据）。
  - → 综合下来：**只要能写 Redis，一次读取 + 一次投递就能完成针对任意订单的伪造支付**。
- **修法方向**（**建议 ② 与 ③ 一起做**，理由见下）：
  - ① 在消费端 `applyEvent` 里补 `event.amount !== order.totalAmount` 的核对
    （金额从订单反查，不信 job payload）。
  - ② **消费端一律不信 job 里的金额**：金额一律从订单 / 支付单反查
    （与「租户从订单反查」同一思路，`webhook.worker.ts:51-53` 的注释已经写明
    「任务里的 tenantId 必须来自可信源」，金额是同一个道理，只是漏了）。
  - ③ 消费端落地前**复核事件行**：确认 `payment_webhook_events` 里存在
    `(provider, eventId)` 且 `processedAt IS NULL` 的行 —— 相当于给 job 加一道
    「必须先经 HTTP 端点登记」的凭证。
- **⚠️ 修完 ② 之后的残余风险（要说清）**：
  消费端「不信 job 里的金额、只信订单全额」之后，攻击者仍能把订单标记为已支付
  —— 只是**金额被迫等于订单全额**（不能「1 分钱买 100 元商品」了）。
  换句话说：**② 把「任意金额付款」降级为「全额付款」**，
  **没有消除「凭空付款」本身**。
  → 要彻底消除，需要 **③（消费端复核事件行）**：
  确认 `payment_webhook_events` 里存在 `(provider, eventId)` 且 `processedAt IS NULL` 的行
  —— 相当于给 job 加一道「必须先经 HTTP 端点验签登记」的凭证，
  这样**没经过验签端点的 job 一律不生效**。
  → **建议 ② 与 ③ 一起做**：② 便宜（一个 if），③ 才是真正的凭证。
- **✅ 已有的其他护栏（这些不受影响，继续有效）**：
  - 支付单的条件更新（`status: PENDING`）→ 不能重复生效、不能改已付订单。
  - 订单的状态条件更新（`status: PENDING_PAYMENT`）→ 已支付/已关闭的订单不流转。
  - `attachProviderTxnId` 拒绝跨订单的渠道交易号冲突。
- **✅ 修法成本极低（主控核实）**：②**不需要任何额外查询** ——
  `applyEvent` 里 `const order = await this.findOrderByNo(event.referenceNo)`
  返回的 `ReadableOrder` **已经带 `totalAmount`**（`payment.service.ts:2312` 定义），
  且 `applyEventInTx` 的入参 `order` 里也有 `totalAmount`（`:788`）。
  → **只是在 `applyEvent` 里加一个 if 判断**，把 `event.amount` 换成
  `order.totalAmount` 参与后续流转（或直接不信任 `event.amount`）。
  → 对比：`checkWebhookEvent` 里已有同样的判定（`payment.service.ts:628`），
  **照抄即可**。
- **严重级别**：**high**（需要能写 Redis 的前提；但一旦前提成立就是直接资损，
  且**与 P0-5 叠加**——P0-5 让「能写 Redis」从假想变成现实）。
  → **修 P0-5 时应与本条一起做**，否则只锁密码不堵消费端。

### P0-7 一张券被任意一个用户核销后 → 全店所有其他用户手里的同一张券同时失效

> 来源：第二轮资金链路 workflow（`wf_d2ac816c-2c5`）第 1 条交卷，severity=critical。
> 主控已逐行核实代码，**确认成立**。

- **位置**：`api/src/modules/coupon/coupon.service.ts:1118`（`findCandidateCoupons`）
  vs `:741`（`listMine`）—— **两处口径相反**
- **机制**：
  - `findCandidateCoupons:1118-1127` 排除「已被占住/已用掉」的券时：
    ```ts
    const used = await client.couponRedemption.findMany({
      where: {
        couponId: { in: coupons.map((coupon) => coupon.id) },
        status: { in: [CouponRedemptionStatus.RESERVED, CouponRedemptionStatus.USED] },
      },
      select: { couponId: true },
    });
    ```
    → **没有 `customerId` 过滤** → 只要**任意**用户用掉了这张券，
    **整张券对所有其他用户都不可用**。
  - `listMine:741-749` 查核销记录时**带 `customerId`** → 只看**这个用户**自己的记录 → `used=false`。
  - → 两个接口对「这张券还能不能用」的判定依据不同：
    `listMine` 问「**我**用过吗」，`findCandidateCoupons` 问「**有人**用过吗」。
- **数据层放大了它**：`coupon_redemptions_coupon_active_uniq`
  （`prisma/migrations/20261025100000_add_marketing_tables/migration.sql:145-147`）
  是 `ON ("couponId") WHERE "status" IN ('RESERVED','USED')` → **按券全局唯一**，
  与「用户领了 N 张」（`coupon_claims.quantity`）**无关** ——
  `quantity=2` 也只能核销一次。
- **失效场景（workflow 实测）**：同一张 `totalLimit=50` 的店铺券，A、B 两个消费者各领 1 张
  （`claimedCount=2`）。**A 下单占用后**：
  - B 的 `GET /api/v1/coupons/preview?originalAmount=1000` → `"coupons":[]`（候选为空）
  - B 显式带 `couponId` 下单 → **409「该券已被使用」**
  - **A 取消订单后** → B 再下单 201（`reservedCount` 回到 1）
  → 即：**A 领券这一动作，把 B 已合法领取的券一并作废**；
  A 不用这券，B 就永远用不了自己领的券。
- **危害**：
  - 店铺券：「满 100 减 20、限 50 张」的券，**第 1 个消费者下单（哪怕最后取消）**，
    其余 49 个消费者结算页再也看不到这张券，显式指定则 409。
  - **平台券更严重**：`totalLimit=1000` 的平台券，第一个人在**任意一家店**用掉后，
    **全平台所有店的所有消费者**都不能再用这张券。
  - **前后端数据自相矛盾**：这 9 个消费者在「我的券」里都实实在在看到自己领了 1 张
    （`used=false`、`claimedQuantity=1`），但结算页就是用不了。
- **⚠️ 与「一券一实例」设计取舍的关系（要说准）**：
  - 设计文档 `2026-10-25-plan-05a-marketing-design.md:265` 明写
    「券没被用过（**没有** `status IN (RESERVED, USED)` 的核销记录）」；
    计划 `2026-10-25-plan-05a-marketing.md` 勘误表第 5 条承认
    「`reservedCount` 条件更新在本阶段『**一券一实例**』的模型下没有对应的上限字段」
    → 「改为以部分唯一索引作并发闸门」。
  - → **「一券一实例」是已知且被接受的模型简化**，
    但**勘误表只讨论了「并发闸门怎么落地」，没说它会波及别的用户**。
  - ⚠️ **而 `coupon_redemptions` 表结构本身是有 `customerId` 字段的**
    （`schema.prisma:885`）→ **数据模型支持按用户维度**，
    是**唯一索引与候选查询这两处**没有用上它。
  - → **这条不是「设计上就该一券一实例」，而是「简化时没意识到会跨用户波及」**。
    严格说：即使接受「一券一实例」，**「我领了但别人用掉了 → 我的券显示可用却用不了」**
    这个**数据自相矛盾**也必须修 —— 至少 `listMine` 与 `findCandidateCoupons` 的口径要一致。
- **修法方向（按代价从低到高）**：
  - ① **最小修复（只消除数据自相矛盾）**：让 `findCandidateCoupons` 也按 `customerId` 过滤
    → A 的核销不影响 B 的候选。⚠️ 但此时**两人同时用同一张券**会同时进候选 →
    **靠下单时的部分唯一索引兜底**（撞了转 409）→ 至少不会「静默失效」，
    而是「先到先得，后者收到明确的 409」。
  - ② **正确的修法**：把部分唯一索引改成
    `ON ("couponId", "customerId") WHERE "status" IN ('RESERVED','USED')`
    → **一张券可以被不同用户各用一次**（与 `coupon_claims` 的 `quantity` 模型自洽），
    同一用户仍只能用一次。⚠️ **要新增手写迁移**，
    且**建索引前要处理存量**（现有索引下不可能有同券多条有效核销，所以这条应该能直接建）。
    ✅ **我已核实这条改动不会破坏任何现有逻辑**（这是它比其他修法干净的地方）：
    - `reserveInTx`（`coupon-redemption.service.ts:106`）靠 P2002 → 409「该券已被使用」；
      改索引后**同一用户**仍会撞（同 couponId+customerId），**不同用户不再撞** → 正是想要的。
    - `releaseInTx`（`:142`）与 `markUsedInTx`（`:170`）都按 **`id`** 做条件更新
      （`where: { id, status: 'RESERVED' }`），`findReservedInTx` 按 **`orderId`** 查
      → **都不依赖「全局唯一」这个假设** → 改索引后行为不变。
    - `listMine:741` 本来就带 `customerId` → 改索引后它的口径与候选查询自然一致。
    - 计数（`reservedCount`/`usedCount`）的增减是**按核销记录逐条**做的（`adjustCouponCountInTx`）
      → 同一张券被两个用户各用一次，计数减 2 → 与「两张券份」的语义自洽。
    - **发放侧的语义本来就支持②**（我已核实 `schema.prisma:832-834` 与 `coupon.service.ts:461`）：
      `totalLimit` = **总发放份数**、`perUserLimit` = **每用户份数**，
      `coupon_claims.quantity` 记录「这个用户领了几份」→
      「一个用户领 1 份、另一个用户领 1 份、两人都能用」**才是这套模型本来要表达的意思**；
      现在的「全局一券一实例」其实是**索引选错了粒度**，不是模型本身要那样。
  - ③ **与设计方确认「一券一实例」是不是产品要求** —— 如果是，②不该做，
    而应该把 `listMine` 的 `used` 口径改成全局口径（让别人用掉时也显示 `used=true`），
    并让 `coupon_claims.quantity` 的语义改为「该用户可用的券份数」而不是「可同时核销的张数」。
    ⚠️ **这条要先问清楚再动** —— 改错了会让「限 50 张」的券实际只能用 1 张。
- **严重级别**：**critical** —— 面向消费者的**功能失效 + 数据自相矛盾**，
  且平台券场景会**跨店铺、跨用户**波及；触发条件极简单（两个人各领一张券）。

## 二、P1 —— 角色越权与数据正确性

### P1-1 5 个控制器缺 `@Roles`

- `catalog/products`（9 条路由）、`catalog/categories`（4 条）、
  `inventory`（3 条）、`media`（4 条）、`stores` 的 `PATCH me`（1 条）
- **机制**：`@Roles()` 是挂 `RolesGuard` 的唯一入口（`roles.decorator.ts:25`）；
  `RolesGuard.canActivate` 无元数据时 `return true`（`roles.guard.ts:34-42`）；
  `RolesGuard` **刻意没注册成 `APP_GUARD`**（`app.module.ts:23-26`：全局守卫先于
  `JwtAuthGuard` 执行，`request.user` 尚未填充）→ **漏挂 = 静默敞开**。
- **资损链**：消费者令牌 → 改 SKU price 为 1 分 → 库存调整（`quantity` 无上限）
  → 下单 99 件（`MAX_ORDER_QUANTITY=99`）→ 付 0.99 元拿走 99 件。
- **设计依据**：`docs/superpowers/specs/2026-10-22-plan-02-product-center-design.md:612-615`
  的契约表明写「JWT + **商家角色**」。
- **角色取值**：应为 `@Roles(UserRole.MERCHANT_OWNER, UserRole.MERCHANT_STAFF)`
  —— 店员（`MERCHANT_STAFF`）是合法商家角色（设计文档 236-237 行），
  仓库既有写法（`billing.controller.ts:19`、`subscription-payment.controller.ts:41`）同款。
  只有**出款**是 owner-only（阶段 5h 设计明确）。owner-only 会误伤店员。
- **`GET /stores/me` 不加 `@Roles`**：它返回的内容（店名/slug/状态/主题 token）
  消费者本来就能从 `/public/theme` 与 `/stores/by-subdomain` 看到；
  `paymentConfig` 全仓从未被读写（预留字段，实际 `{}`）。只挡 `PATCH me`。
- **兼容性**：受影响的 12 个 e2e 文件全部用商家令牌；`storefront` 完全不用这些接口；
  平台后台也不用 → 加 `@Roles` 不破坏任何现有调用。
- **已核实**：消费者读的是 `/public/*`（`public-catalog.controller.ts`，带 `@Public()`），
  与 `/catalog/products` 完全分离 → 加 `@Roles` 不影响消费者。
- **✅ 第三方独立复现**：对抗验证 workflow 的怀疑者在**运行中的栈**上完整复现了
  资损链（注册 CUSTOMER → 建商品 → `PATCH skus/{id} {price:1}` → 
  `POST inventory/adjustments {quantity:99999}` → `PATCH product {status:PUBLISHED}` →
  公开列表出现 `minPrice=1` → 下单 99 件 → 付 0.01 元），
  独立判定严重级别为 **critical**。这条与我的静态分析一致。
- **⚠️ 不只是写接口（第三方验证补充）**：消费者令牌 `GET /inventory/movements`
  能读到**商家完整的库存流水**（含商家店主的 user id，已确认该 id 的 role=MERCHANT_OWNER），
  `GET /inventory/summary` 也放行 → **同一个洞顺带泄露商家的经营数据与店主账号标识**。
  `products` / `categories` / `media` 的读接口同理。
- **5 个控制器的 21 条路由**已逐条核对：**全部只有 `JwtAuthGuard`（JWT 认证），无一个 `@Roles`**。

### P1-2 批量改价 `SET` 模式不夹 0 → 负价落库

- **位置**：`api/src/modules/catalog/products/products.service.ts:419`
- **机制**：`mode === 'SET' ? value : applyPercent(sku.price, value)`。
  `PERCENT` 走 `applyPercent`（内部 `Math.max(0, rounded)`），
  `SET` **直接用 `value`**，而批量 DTO 的 `value` 是 `@Min(-100)`。
- **注释与代码不一致**：DTO 注释写「SET 模式非负由 service 层夹」—— 代码没夹。
  `Sku.price` 无数据库 check 约束。
- **后果**：不是资损（`order.service.ts:371` 有 `payableAmount < 0` 兜底），
  而是 `minPrice`（`MIN(price)` 聚合）变负 → 前台价格筛选与排序错乱。
- **修法**：`SET` 分支也走 `Math.max(0, value)`。

### P1-3 同一订单在两个渠道各付一次 → 第二笔永久卡库

> 来源：7 维审计 workflow；对抗验证（到达序第 31 条）确认 real=true，级别 **medium**（非 high）。

- **位置**：`api/src/modules/payment/payment.service.ts:1044-1047`
- **机制（对抗验证纠正后的准确表述）**：真正的缺陷是
  **「退款路径是单笔语义，而数据模型允许同一订单多笔成功支付」**——
  `payments` 唯一索引是 `(orderId, channel)`（`payments_order_channel_uniq`），换渠道即建第二行；
  而 `refund()` 只处理 `payments[0]` 一笔，订单转 `REFUNDED` 后是终态（`order-status.ts` 的 `REFUNDED: []`），
  第二笔**永远**无法经唯一退款入口退掉。
  ⚠️ 原报告把「`findMany` 无 `orderBy`」当根因是**偏的**：即使加确定性排序，结局完全一样 ——
  `no orderBy` 只是让「退哪一笔」不可预测的**次要**问题。
- **失效场景**：两渠道都付款 → 渠道 A 的回调把订单转 PAID 并记流水；
  渠道 B 的回调里支付单的条件更新键是 `(orderId, channel, status: PENDING)`
  （`applyEventInTx`，`:822-828`），**与订单状态无关** → 独立转 SUCCESS；
  随后 `transitionInTx(PENDING_PAYMENT→PAID)` 因订单已 PAID 而 `!won`，
  只 warn 后 return —— **但事务照常提交**（与 P0-3 是同一个 `!won` 缺陷）。
  支付单 B 停在 SUCCESS，且 **DEDUCT / 抽佣 / 货款三样流水全没记**
  （这三个调用都在 `!won` 分支之后）→ 商家退款只退到一笔 →
  **客户被扣两次钱只能退一次，另一笔永久卡在库里**。
- **无救援通道（对抗验证全枚举）**：全仓写 `PaymentStatus.REFUNDED` 的只有 `payment.service.ts:1240` 一处；
  28 个 controller 无平台级退款端点；`scripts/` 下无退款脚本；
  `check-ledger.ts` **根本不读 `payments` 表**（`npm run check:ledger` 对孤儿 SUCCESS 支付单报「✅ 流水完整」exit 0）；
  `applyRefundEvent` / `findRefundablePayment` 只认 `REFUNDING` 状态，碰不到 SUCCESS 孤儿。
  孤儿支付单**可被人工发现**（不是无声消失），但没有任何自动化防线会发现它。
- **触发前提（级别 medium 的依据）**：需要**同时启用两个支付渠道**。
  当前仅有的两个实现 `fake` / `sandbox` 都是 devOnly → 生产形态下配了就被启动校验拒绝、
  不配则启动放行但运行时 409（见 P2-A1）→ **该场景今天只在非生产多渠道配置下可达**；
  接入第二个真实渠道（README 列为阶段 6 遗留）时**立刻变成现实资损**。
  `createPayment` 的注释（`:172-175`）明写「同一个订单同一渠道只能有一笔支付单」
  —— 作者的心智模型是「一单一笔」，恰恰漏了跨渠道。
- **已核实**：`refund()`（`:1044-1047`）的 `findMany` **无 `orderBy`**，取 `payments[0]`；
  测试库 `\d payments` 实测唯一索引为 `UNIQUE (orderId, channel) WHERE "orderId" IS NOT NULL`，
  无任何 CHECK 约束；`PaymentStatus.CLOSED` 全仓无写入方（死枚举值）。
- **修法**：与 P0-3 是**同一处结构性修复**（`!won` 分支的语义）：
  支付单成功但订单流转失败时不能只 warn 后提交 SUCCESS ——
  要么整笔回滚，要么落「已收款待人工处理」状态并告警；
  同时退款路径改为**遍历所有 SUCCESS 支付单**（而不是单笔语义），
  并给「订单已终态但仍有 SUCCESS 支付单」加一条自检（需让 `check-ledger` 读 `payments` 表）。

### P1-4 MinIO CORS 变量名写错 → 任意 Origin 被放行

- **位置**：`infra/docker-compose.yml:78`
- **机制**：写的是 `MINIO_CORS_ALLOW_ORIGIN`，MinIO 真实变量名是 `MINIO_API_CORS_ALLOW_ORIGIN`
  → 白名单完全没生效 → MinIO 回落到「反射任意 Origin + `Allow-Credentials: true`」。
- **⚠️ 错名变量有 2 处活代码**：`infra/docker-compose.yml:78` 与 `infra/.env.example:35`
  （另有 3 处历史文档，不影响运行）。
  → 修的时候 **compose 与 .env.example 要一起改**，只改 compose 的话，
  照着 .env.example 配环境的人还是会踩同一个坑。
- **⚠️ compose 的注释是错的**（`infra/docker-compose.yml:77`）：
  「多个来源用英文逗号分隔；**实测该变量对预检请求生效**」——
  这个「实测」是**变量名写错时任何 Origin 都「生效」**，所以看起来是通的，
  恰恰是它掩盖了 bug。
- **仓库已有现成的护栏机制可用**：`api/src/common/config/placeholder-secrets.spec.ts`
  直接**解析 `infra/docker-compose.yml`** 并断言默认值都在拒绝集合内
  （「将来谁改了 compose 默认值却忘了登记到集合，这里立刻红」）。
  → 在同一套机制里加一条「MinIO CORS 变量名必须是 `MINIO_API_CORS_ALLOW_ORIGIN`」的断言即可。
- **验证**：主控已实测 —— 对当前 compose 实例发 `Origin: http://evil.example.com` 的预检，
  返回 `Access-Control-Allow-Origin: http://evil.example.com`；
  `http://localhost:9999`（不在白名单）**也被回显**；
  对照容器用正确变量名时 `evil.example.com` **无 CORS 头**。
- **修法**：改变量名；并加一条「compose 的 CORS 变量名必须是 `MINIO_API_CORS_ALLOW_ORIGIN`」的护栏。
- **⚠️ 危害面要收窄（第三方验证纠正）**：
  - MinIO S3 API 走 **SigV4 签名、不认 cookie** → 攻击者页面能发请求、能读响应，
    但所有响应都是 `403 AccessDenied`（bucket 私有 —— Chainguard 版不支持 `PutBucketPolicy`，
    配不出匿名读，见 `minio.service.ts` 注释）。
  - **MinIO 控制台 19001 不受影响**：实测 `GET /login` 带任意 Origin 时无 ACAO 头，
    `POST /api/v1/login` 也不下发 `Set-Cookie` → 不存在控制台会话跨站骑乘。
  - compose 默认把 MinIO 绑在**回环**（`BIND_HOST` 默认 `127.0.0.1`）→ 只能攻击本机跑着这套栈的人。
  - 真实危害是「**白名单完全没生效**」这个配置事实（将来一旦 bucket 改成可读或
    换成别的对象存储就直接变成数据泄漏），而不是当下的资金损失。
  - 严重级别应从 high 降为 **medium**。

### P1-5 「默认支付方式」不变式没有数据库约束 → 可清空 / 可多份

> 来源：对抗验证 workflow 第 18 条（severity=medium）。主控已复核代码确认成立。

- **位置**：`api/src/modules/payment/payment-method.service.ts`
  - `create`（:61-73）：清默认 + 建新默认**两条语句不在事务里**
  - `setDefault`（:134-145）：事务内清全部默认 + 置目标为默认
  - `remove`（:113-119）：直接删，**不把剩余卡提为默认**
- **机制**：「每租户只有一个默认支付方式」这个不变式**只靠应用层代码保证**：
  - `payment_methods` 表上**没有部分唯一索引** ——
    `prisma/migrations/20261025220000_add_billing_tables/migration.sql:164`
    只有 `CREATE INDEX "payment_methods_tenantId_idx"`（非唯一）。
  - 仓库同仓有现成先例可参照：
    `addresses_tenant_customer_default_uniq`
    （`prisma/migrations/20261024093418_add_transaction_tables/migration.sql:200-202`）。
- **失效场景（分三种）**：
  1. **`setDefault` 传不存在的 / 已被删除的 / 属别家租户的 id** →
     第一步 `updateMany({ where: { tenantId } })` **无条件清空全部默认卡**，
     第二步 `updateMany({ where: { id, tenantId } })` 命中 0 行 →
     **该租户一个默认卡都不剩** → 接口仍返回 **HTTP 200 `{"updated":true}`**（静默成功）。
  2. **并发 `create`** → 两条语句无事务，两次调用都可能在自己清完默认后又被对方清掉，
     或都建出 `isDefault: true` 的行 → **两个默认**。
  3. **`remove` 删掉唯一的默认卡** → 剩下 0 个默认 → 不提位。
- **危害**：`renewal.service.ts:202` 用
  `paymentMethod.findFirst({ where: { tenantId, isDefault: true } })` 取卡扣款 ——
  - **0 个默认** → 走 `if (!method)` 分支 → 日志「等待商家手动支付」+ `expireIfNeeded`
    → **订阅静默过期、平台套餐停摆**（商家看不到任何错误，只看到订阅没了）。
  - **多个默认** → `findFirst` **无 `orderBy`** → 取哪张不确定（行为依赖数据库返回顺序）→
    续费可能扣到商家已解绑或已失效的卡。
  - **不产生跨商户资金流失**：扣的是同租户自己的卡，token 也没有外泄
    （`list` 用 `select` 显式不返回 `token`）。
- **修法**：
  - 加**部分唯一索引** `payment_methods_tenant_default_uniq`：
    `CREATE UNIQUE INDEX "payment_methods_tenant_default_uniq"
       ON "payment_methods" ("tenantId") WHERE "isDefault" = true;`
    —— 仿 `addresses_tenant_customer_default_uniq`
    （`prisma/migrations/20261024093418_add_transaction_tables/migration.sql:200-202`）
    的写法，**手写 `migration.sql`**（`prisma migrate dev` 在本仓不可用）。
    ⚠️ 参照的那条带 `AND "deletedAt" IS NULL`，**本表不需要** ——
    `payment_methods` 没有 `deletedAt` 列（`schema.prisma:1049-1071`），
    解绑是**物理删除**（`payment-method.service.ts:113` 的注释明写
    「支付方式不用保留历史，但核销记录要留」）。
  - `setDefault` 先校验目标存在且属本租户（`findFirst`），不匹配就抛 404/409，**不要先清空**。
  - `remove` 删掉默认卡后，把剩余卡里最新的一张提为默认。
  - `create` 的两条语句包进事务。
  - ⚠️ **加唯一索引前要先处理存量数据**：若现有库里已经有「同租户多个默认」的行，
    索引创建会直接失败 → 先跑一遍清理（每租户只留一个默认）再建索引。
- **严重级别**：**medium**（不跨商户、不直接资损，但会让商家的订阅静默停摆，且当前 API 报 200 掩盖了失败）。

## 三、P2 —— 可用性与工程债

### P2-A 启动与配置：两个 fail-open 的守卫

| # | 问题 | 位置 | 备注 |
|---|---|---|---|
| P2-A1 | **生产环境一个渠道都不配也能启动** | `assert-secure-config.ts:206` | `assertChannelConfig` 的两个校验都是 `for (const channel of enabledByKind[kind])` → **启用列表为空时循环体一次都不执行 → 没有任何断言触发**。`CHANNEL_MODE` 不设也直接放行。第三方实测：`NODE_ENV=production` + 合法全部凭据 + 不配任何渠道 → `assertSecureConfig()` **不抛错**。<br>⚠️ **严重级别是 low，不是 high**（第三方纠正）：运行时全链路 **fail-closed**，**无资损无越权** —— 支付：`PaymentProviderRegistry.get()`（`payment-provider.registry.ts:74`）在渠道未启用时抛 409，**不建支付单、不扣款**；出款审批：`resolveChannelForApproval()` → 注册表 409 → **审批当场失败，不产出打不出钱的单**（符合 AGENTS.md「渠道已停用 → 409 且不审批」）；出款执行：`payout.worker.ts` 的 `claim.channelError` 分支 → `markFailed(failedBeforePayout: true)` → **渠道从未被调用，钱确定没出去**。<br>→ 真实危害只是「**故障推迟到第一笔交易才暴露**」（生产容器正常起来、队列正常消费），属可观测性问题。修法：生产分支加「启用列表为空 → 拒绝启动」，并要求 `CHANNEL_MODE` 显式声明。<br>⚠️ **对抗验证第 30 条补充的消费者侧文案问题（我已核实）**：`payment.service.ts:2302` 的 `listChannels()` 走的是 `registry.registeredChannels()` —— 注释明写「**已注册的渠道名（含未启用，排查用）**」，**不区分是否启用**。而 `payment.controller.ts:91-97` 的 `defaultChannel()` 用它挑默认渠道 → 生产零渠道时它仍返回 `['fake']` → 消费者看到的报错是「**支付渠道 fake 未启用**」而不是「**没有可用的支付渠道**」。<br>→ 修这条时**只加启动断言是不够的**，还要让 `defaultChannel()` 只从**已启用**渠道里挑（`registry` 里已有 `isChannelEnabled` 过滤的变体，见 `payment-provider.registry.ts:95-97`），否则消费者侧的文案仍然误导。 |
| P2-A2 | **账目加密自检在无样本时静默通过** | `payout-encryption-self-check.service.ts:42` | 自检只取「商家收款账户一行 + 出款单快照一行」。库为空时**一行都不取** → 密钥配错（换了 `PAYOUT_ACCOUNT_ENCRYPTION_KEY`、或把 compose 默认值复制到生产）**完全不会被发现**，进程照常启动、CI 与监控全绿 → 直到第一笔出款逐单落 `FAILED`。⚠️ 这条**我原判定为「有意设计」**（注释明写「两处都没有可校验的行 → 静默通过：新库、或还没跑迁移的库都不该因此起不来」）——**该判定仍然成立**（不能改成硬失败），但**缺一条显式 warn** 是真缺陷：「当前库中无已加密样本，密钥正确性未经校验」 |
| P2-A3 | **加密迁移脚本与自检的时序窗口**（对抗验证补充的残余风险） | `api/scripts/migrate-payout-encryption.ts` | 对抗验证第 20 条判本条「not-a-bug」：自检静默通过是设计取舍，且**有密文时是 fail-fast**（跨密钥解密必抛 AES-GCM 认证标签不匹配 → 进程非零退出）。但它指出一个**残余风险**：<br>① 迁移脚本**读不到 compose 注入的环境变量**（脚本跑在 `npm run` 里，只能读本地 `api/.env`，见脚本 `:11-16`）；<br>② 若运维在 api **已启动之后**才用错误的密钥执行 `npm run migrate:payout-encryption -- --force`，存量行会被**用错密钥加密**，而自检已在启动时通过 → **要等下次重启才暴露**。<br>后果可控：出款落 `FAILED` 且 `failedBeforePayout: true`（钱**没打出去**，可安全重试），且写路径另有两道版本闸（`payout.service.ts:318` 申请、`:611` 审批）在 `encryptionVersion !== 1` 时直接 400/409。<br>→ **不构成资金损失**，但运维顺序错误会造成「批量出款失败 + 需人工重跑迁移」。<br>**建议**：迁移脚本执行后**立即**手动触发一次自检（或让脚本自己调用一次解密校验），不要依赖「下次重启」。 |
| P2-A4 | ✅ **账目自检漏检货款冲回**（已修，提交 `6f02d30`） | `api/src/modules/billing/ledger-check.ts:46` | `reversalReceiptOrderIds` 声明了、`scripts/check-ledger.ts:136` 也传进来了，但**全文件从未被读取**（已 grep 确认）；第 126 行只检查抽佣冲回（`reversalSet`）。<br>**失效场景**：订单已退款但缺 `SALE_REVERSAL` 流水 → `npm run check:ledger` 报「✅ 流水完整」exit 0 → 出款时 `receiptAmount` = `merchant_receipts` 求和（`payout.service.ts:1507`），退款冲回缺失 → 只算到 +10000 没有 -10000 → 商家按未退款全额申请出款。<br>⚠️ **严重级别是 medium，不是 P1**（我核实 + 对抗验证第 23 条实测）：① **退款路径本身健全** —— `applyRefundInTx`（`payment.service.ts:1259-1288`）把「订单转 REFUNDED（写 `refundedAt`）+ 抽佣冲回 + 货款冲回」放在**同一个 `$transaction`** 里；② 对抗验证进一步收窄触发前提 —— 正常退款路径**产生不了**这种状态，唯一可达路径是 `receipt.service.ts:268` 与 `:300` 两条**独立的非事务写入**被中断（`backfill()` 外层只有 `tenantContext.run`，**没有 `$transaction`**）或手工改库 → 是「**数据已经坏了**」不是「**数据会坏**」；③ 该脚本**不接任何自动闸门**（`.github/workflows/ci.yml`、`infra/`、`README.md` 均无引用）→ 退出码 0 今天**不会阻止任何发布动作**，其原始用途（5i 切报表口径）已于 2026-10-30 完成。<br>**修法**：补一条「已退款订单必须有 SALE_REVERSAL 流水」的检查。⚠️ **谓词必须用 `totalAmount` 而不是 `commissionAmount`** —— 货款侧的 `shouldBackfillReceiptReversal(refunded, refundedAt, totalAmount)` 按 `totalAmount` 判零额（`receipt.service.ts:66-81`），抽佣侧才按 `commissionAmount`；照抄成 `commissionAmount` 会把「零佣金但有货款」的正常订单误报成缺口 → **脚本永远 exit 1**。另：修好后 `undatedRefundCount` 口径要顺手对齐（货款侧与抽佣侧的「无归期」分开统计）。<br>→ **已按此修**：判定顺序加第 7 步，谓词用 `totalAmount`；`undatedRefundCount` 拆成两侧分开统计。实施记录见 §〇「批次 10 的实施记录」。 |
| P2-17 | **领券总量闸只比较自增前的老值 → 超发（⚠️ 原 P0-1，对抗验证实测后降级）** | `api/src/modules/coupon/coupon.service.ts:562` | **机制**：`where: { claimedCount: { lt: totalLimit } }` 只比较自增前的值，
  而 `data: { claimedCount: { increment: quantity } }` 一次加 `quantity` 张。
  `quantity` 的 DTO 上限是 `@Max(10)`。<br>- **失效场景**：商家建 `totalLimit=1`、`value=100000` 分的券 →
  消费者 `POST /coupons/claim {couponId, quantity: 10}` →
  条件通过 → `claimedCount=10` → 超发 9 张券（每张 ¥1000 量级）。<br>- **验证**：主控已在隔离库实测（库内 `claimedCount=10`、`coupon_claims.quantity=10`），
  隔离库已删除清理。<br>- **同文件对照**：第 473 行的「每用户限领」写的是 `quantity: { lte: limit - quantity }`
  —— 正确表达「加完之后不超过限额」。全仓 25 处增量更新，其余都正确，
  **只有 `claimedCount` 是漏网的**。<br>- **修法**：`{ lt: totalLimit }` → `{ lte: totalLimit - quantity }`。
  注意 `totalLimit === null`（不限量）时 where 要省略。<br>- **⚠️ 危害面要收窄（对抗验证第 27 条实测复现 + 我复核）—— 严重级别应为 low，不是 P0**：
  - **对抗验证经 nginx 网关实测复现**（`Host: demo.platform.test` + `/api/v1/coupons/claim`）：
    `totalLimit=1` 的券，body `{couponId, quantity: 10}` 返回 200，
    库内 `claimedCount=10`、`coupon_claims.quantity=10`；`totalLimit=100` 的券被单账号 10 次请求领空。
    → **失效机制确凿**，但**危害面比原先记的小**。
  - **无直接资金损失** —— 两条独立机制保证：
    ① `coupon_redemptions_coupon_active_uniq`（`ON ("couponId") WHERE status IN ('RESERVED','USED')`，
    `migration.sql:145`）保证一张券全局同时只能有一条有效核销；
    ② **优惠引擎根本不看 `quantity`** —— `findCandidateCoupons`（`coupon.service.ts:1073`）
    查领取记录时只 `select: { couponId: true }` → **领 10 张与领 1 张的抵扣价值完全相同**，
    多出的 ≤9 张是**死券**。
  - **超发有界** —— `quantity` 被 `@Max(10)` 限死，最坏 `claimedCount ≤ totalLimit + 9`，
    越过阈值后 `lt` 恒假 → 下一次请求即 409。
  - **⚠️「其他消费者被挡在促销外」不该记在这条头上（对抗验证纠正）**：
    `perUserLimit === null` 时，**任何人**用 `quantity=1` 重复调 100 次也能领空
    `totalLimit=100` 的池子，**终态完全相同** → 这条 bug 只是把请求数压到 1/10，
    **没有创造新的可利用能力**。仓库也无 Throttler / 频控，nginx 对 `/api/v1/` 直通。
  - **真正归因于这条的只有三点**：① `claimedCount > totalLimit` 的**不变量破坏**；
    ② 多出的 ≤9 张**死券白白吃掉商家库存**；③ 商家后台「已领 N 张」与 storefront 剩余张数**失真**。
  - **触发前提**：`perUserLimit` 为 null 或 ≥ 10（`coupon.service.ts:461` 的
    `if (limit !== null && quantity > limit)` 会先抛 409 并回滚计数）。
  - → **建议把本条从 P0 移到 P2**（low）：机制确凿、修法是一行（`{ lt }` → `{ lte: totalLimit - quantity }`），
    但**没有资损、没有越权、危害面限于「计数失真 + 死券」**。
    ⚠️ 我原先写的「严重级别应从 critical 降为 medium」**仍然偏高** ——
    对抗验证的实测把它压到了 low。 |

### P2-B 测试与护栏：六处「假安全感」（⚠️ 其中 **4 处**已被对抗验证推翻或升级）

| # | 问题 | 位置 | 备注 |
|---|---|---|---|
| P2-B1 | **CI 把唯一的 media 套件整份排除**（媒体链路的**部分**覆盖为零） | `.github/workflows/ci.yml:190` | ⚠️ **修正**：这条被第三方验证**推翻过一半** —— 我原写「`src/modules/media` 在 CI 里零覆盖」是**错的**。实际 CI 仍跑：`api/test/catalog.e2e-spec.ts:714`「设置商品媒体：跨租户的媒体不可引用」（该文件不在排除范围）、`api/test/catalog-public.e2e-spec.ts:308`（前台读媒体列表）、`merchant-admin/test/app/api/body-whitelist.test.ts:133`（上传凭证接口 body 白名单）。<br>✅ **成立的部分**：排除 media 套件本身是**阶段 9 评审过的显式取舍**（设计文档 `2026-11-04-plan-09-tech-debt-cleanup-design.md:126`），不是漏掉的角落；被排除的套件覆盖的「presigned URL 的 host 必须浏览器可达」「上传后 confirm 的 size 复核」「越限文件被删并标 ORPHANED」等**安全逻辑确实零覆盖**，且这是唯一会因为 `MINIO_ENDPOINT`（本机 `localhost:19000`）与 compose 注入的 `minio:9000` 是两套地址而出错的路径。修法：e2e job 加 MinIO service 容器 |
| P2-B2 | **防重复打款的闸 ③ 零测试**，且 DB 兜底的报错文案误导 | `payout-execution.service.ts:666` | 单测里**已备好钩子**（`payout-execution.service.spec.ts:130` 声明 `occupiedEntries?`，`:255` 用它伪造 `payoutEntry.findMany` 返回值），但**没有任何一个用例配置它** → 那句「这批流水已被同期的另一个出款单占用」文案只在源码出现。<br>⚠️ **修正**：闸 ③ 放行后 `tx.payoutEntry.createMany({ skipDuplicates: false })`（`:732`）会撞 `payout_entries_entryId_key`（全局唯一索引）→ **DB 层兜住了，状态不会被改坏**（第三方验证在 `ecommerce_test` 库 `\d payout_entries` 确认索引仍在）。<br>✅ **成立的真问题**：catch 分支（`:808-812`）把 P2002 统一翻成「出款单状态已变（商家可能已重新申请同一期），无法标记为已付款」—— 这句描述的是 `payouts` 的部分唯一索引，**与实际撞的 `payout_entries_entryId_key` 不符** → 操作员拿不到设计里那句「疑似重复付款，需人工退款处理」的明确指向，**关键信号被错误措辞掩盖**。<br>⚠️ 另有「计划承诺未兑现」：阶段 5m 的 e2e 文件头写明闸 ②③④ 的测试「在 Task 7 / Task 8 补」，而 Task 7 实为解卡闸、Task 8 实为对账服务与 API → **闸 ②③④ 的测试最终从未补上**。 |
| P2-B3 | ~~**`/platform/payout-reconciliations/*` 零 403/401 用例**~~ → **已被对抗验证推翻** | `platform-payout-reconciliation.controller.ts:59` | **推翻（对抗验证第 19 条，real=false）** —— 机制经实测有效：控制器类级挂 `@Roles(PLATFORM_ADMIN)`，展开为 `UseGuards(JwtAuthGuard, RolesGuard)`，控制器内无任何 `@Public()` 覆盖 → 8 条路由全部继承。对运行中的 api 容器（127.0.0.1:3000）实测：**未登录全部 401、商家令牌（MERCHANT_OWNER）全部 403**（含 multipart 的 import 端点 —— 守卫先于 `FileInterceptor` 执行）。<br>且「其他每个平台前缀都有 403/401 用例」的**前提本身不准确**：`platform/plans` 与 `platform/coupons` 也缺 401 用例。<br>✅ **仅保留一条可选补充**：`api/test/payout-reconciliation-service.e2e-spec.ts` 加「商家令牌 → 403」+「未登录 → 401」两条，走通用探针 `api/test/rbac.e2e-spec.ts:117-137` 的同一机制即可。<br>（本条降级为「补测建议」，不再是缺陷。） |
| P2-B4 | ~~**对账的两条写路由 HTTP 层零测试**~~ → **已被对抗验证实测推翻** | `platform-payout-reconciliation.controller.ts:217` / `:249` | 对抗验证第 24 条（real=false）**临时写了真实 e2e 实测**（`Test.createTestingModule` + supertest，跑完已删除）：<br>batch-confirm —— 缺 `note` → 400「note must be longer than or equal to 1 characters」；`mode=IDS` 合法 → 200 `{succeeded:[...],failed:[],nextCursor:null}`；`mode=FILTER` → 200；多传 `bogus` → 400「property bogus should not exist」；任务不存在 → 409「只有账单文件导入的对账任务支持批量确认」。<br>confirm-paid —— 缺 `reason` → 400；传旧字段 `payoutNo` → 400「property payoutNo should not exist」；正常入参 → 409（闸①「明细无法复原」）；出款单不存在 → 404；非 UUID → 400。<br>另跑了两个 DTO 的 `@ValidateIf` 分支矩阵（IDS 缺 `itemIds` → 400、`mode` 缺失/非法 → 400、`limit=201` → 400、多余字段 → 400），**全部符合 DTO 注释里的设计意图，没有一条分支走错，也没有 500**。<br>**且不存在「恒真断言」**：服务层断言是实的（`payout-reconciliation.service.spec.ts:1580-1760` 断言具体 id、`PROCESSING→PAID`、留痕 `action=RECONCILE_TO_PAID_BY_FILE`、FILTER 游标越过失败项、并发两方合计不多改单、非 FILE → 409 且 `payout.updateMany` 未被调用），前端侧也有 `platform-admin/test/reconciliation-batch-confirm-route.test.ts`（断言 200/400/401、`toEqual` 完整 body、失败时 `expect(apiFetchMock).not.toHaveBeenCalled()`）。<br>✅ **仅保留一条「回归加固」建议**（不是缺陷）：这两条路由的 DTO 接线（`@Body() dto` 的类型、`@HttpCode(200)`、`@Roles` 守卫、`@Param`）**没有任何自动化测试锚定** → 若将来有人把 `@Body() dto` 改成内联 TS 类型（那样 `ValidationPipe` 会**直接跳过校验**），或去掉 `@HttpCode` 让响应码从 200 变 201，api 侧不会立刻报警（前端那个测试连的是 mock 的 `apiFetch`，根本不碰后端）。 |
| P2-B5 | ~~**「每租户一个默认支付方式」零测试**~~ → **升级为 P1-5** | `payment-method.service.ts:134` | 对抗验证第 18 条把「零测试」推翻为**真缺陷**：问题不是缺测试，是 `setDefault` **会真的清空默认卡**、且 `payment_methods` 表上没有部分唯一索引。已拆出为 **P1-5**（medium）。本条作废，保留在 P1-5 的修法里一并处理。 |
| P2-B6 | ~~**套餐列表的 `total` 断言恒真**~~ → **已被变异测试推翻** | `api/test/billing.e2e-spec.ts:389`（另一处 `:520`） | 对抗验证第 21 条（real=false）用**变异测试**推翻：断言的 `listed.total` 来自**服务端响应体**、`listed.items.length` 由**客户端**从响应数组算出 → 两者来自不同代码路径，**有真实区分度**。实测 5 次变异全部被抓：`total: items.length` → `999999`（2 failed）、`listActive` 改用 `plan.count()`（含已下架套餐，1 failed）、`listAll` 改 `+1`（1 failed）、删掉 `total` 字段（1 failed）、去掉 `status: ACTIVE` 过滤（被另一条断言抓到）。<br>我原写「结构上必然成立」是把**当前实现的属性**当成了**断言的性质** —— 错。<br>⚠️ 附带事实（报告者未提、变异验证补充）：该接口**当前完全无分页**（控制器无分页 DTO、service 的 `findMany` 无 `take/skip`）→ 对不分页列表而言 `total === items.length` **就是语义正确的契约本身**。 |

### P2-C 其余

| # | 问题 | 位置 | 备注 |
|---|---|---|---|
| P2-1 | 三端依赖 4 条（2 critical + 2 high） | 三端 `package.json` | 具体：`tinypool`（critical，RCE）、`vitest`（critical，路径穿越 —— 实际在 `@vitest/mocker` 与 `tinypool` 上）、`postcss`（high，XSS）、`body-parser`（high，DoS；前端经 `shadcn → @modelcontextprotocol/sdk → express` 引入）。**无需升 vitest/next 大版本**：实测 `overrides: {"@vitest/mocker":"4.1.12","tinypool":"2.2.0","postcss":"8.5.31","body-parser":"2.4.0"}` → audit critical/high 全清，storefront 228/228 测试通过 + `next build` 通过。⚠️ `@vitest/mocker@4.1.12` 与 `vitest@3.2.7` 跨大版本，**另两个前端也要各自跑一遍测试确认** |
| P2-1b | **后端依赖 6 个 high** | `api/package.json` | 3 个根因：`multer@2.4.0`（DoS，`<2.5.0` 有洞，**装在 `@nestjs/platform-express/node_modules` 下**）、`body-parser`（见 P2-2，lock 里是 2.3.0）、`deepmerge-ts`（栈溢出，只被 `@prisma/config` 用 → **仅 prisma CLI 运行时受影响，不在 api 服务里**）。前两个 `overrides` 即可修；`deepmerge-ts` 要修只能升 prisma 到 7（**大版本，且 Prisma 6 → 7 迁移成本高，不建议**） |
| P2-2 | `api/package-lock.json` 与实际安装不一致 | `api/package-lock.json` | **已精确确认**：lock 记 `body-parser@2.3.0`（**有 high 漏洞**），实际装 `2.4.0`（已修）。全量比对 1200+ 个包，**只有这 1 处不一致**。CI 用 `npm ci`（严格按 lock 装）→ **CI 跑的是有漏洞版本，本机跑的是修好的版本**。⚠️ `npm audit` 报的正是 lock 的版本，可用它直接验证这条 |
| P2-3 | 登录无限流 + 无失败计数 | `infra/nginx/platform.test.conf:68`、`auth.service.ts:199` | nginx 的 `location /api/v1/` **无 `limit_req` / `limit_conn`**（全文件只有 6 个 location，一个限流指令都没有）；api 无 `@nestjs/throttler`；`auth.service.ts` 里 grep 不到任何失败计数/锁定字段。**真实风险是撞库不是 DoS**（argon2 实测热态 23ms、20 并发 318ms、事件循环未阻塞）。⚠️ 修法要注意：不能给整个 `/api/v1/` 加限流（会误伤商家批量操作），应对**登录路径**单独设 location |
| P2-5 | 畸形查询参数 → 500（对抗验证第 4、12、32 条**实测确认并补充**） | `api/src/modules/catalog/products/products.controller.ts:63-64`、`api/src/modules/inventory/inventory.controller.ts:35-36`、`api/src/modules/order/merchant-order.controller.ts:60-61` | 仓库已有 `toIntOr` 工具（12 个控制器在用），这 2 处分页参数漏了 → `Number('abc')` = NaN → `skip: NaN` → 500。`merchant-order` 的分页参数用了 `toIntOr`，但**时间参数用 `new Date(from)`** → `Invalid Date` → 500。⚠️ 这 3 处**已由第三方在运行中的栈上实测确认 500**（`?from=garbage` / `?to=notadate`）。<br>⚠️ **根因在后端，不是前端中转（对抗验证纠正）**：修 merchant-admin 的中转路由**消除不了 500** —— 实测**直连 api** 的 `/api/v1/inventory/movements?page=abc` 同样 500（`apiFetch` 在服务端直连 `API_BASE_URL`、根本不经 nginx）。**改 api 一处即可挡住全部路径**（含直接 curl api 的路径）。<br>⚠️ **`status` 枚举也不校验（对抗验证第 12 条发现）**：`?status=FOO` → 500（`Invalid value for argument 'status'. Expected ProductStatus.`）—— 控制器把 `status` 标注成 `ProductStatus`，但**裸 `@Query` 没有 DTO** → 全局 `ValidationPipe` 的 `toValidate()` 排除原始类型 → **不校验**；且编译产物 `design:paramtypes` 是 `[String, String, ...]` → **枚举校验根本不生效**（对抗验证直接调 `ValidationPipe` 验证过：`status=FOO -> OK "FOO"`）。<br>⚠️ **仓库自身约定已把它定性为缺陷**：`api/src/common/http/pagination.ts:19-25` 明确写了裸 `@Query` 不走 ValidationPipe；同仓 `platform-report.controller.ts:45-50` 走 `ReportQueryDto` 的 `@IsDateString()`、`payout-reconciliation.dto.ts:23,27` 同款 → **有现成正确范式可照抄**。<br>⚠️ **触发路径要写准**：merchant-admin 的 `GET /api/products` 中转**没有应用内生产调用方**（商家商品列表是 Server Component 直接调 `apiFetch`），但**商品列表页的客户端筛选路径**与**库存流水页**是可达的；`merchant/orders` 的时间参数**前端页面层已用 `Date.parse` 过滤**（`orders/page.tsx:51,54`，注释明写「后端 new Date('乱七八糟') 会得到 Invalid Date」）→ **UI 路径不会送出坏日期，但直接 curl api 会**。 |
| P2-6 | CSV 导出丢 BOM → Excel 乱码 | `platform-admin/.../settlements/export/route.ts:43` | 后端 `platform-settlement.controller.ts:71` 用 `﻿` 加 BOM，但 BFF 用 `response.text()` 读 → **WHATWG 规范要求 TextDecoder 剥除 BOM** → BOM 丢失。⚠️ `merchant-admin` 是**在 BFF 侧加** BOM，两端写法已漂移 → 修法应统一在 BFF 侧加。只影响 Windows + GBK 代码页的 Excel；金额是纯 ASCII 不会乱码 |
| P2-6b | **结算单 CSV 导出超 100 条截断**（⚠️ **不是「静默」**） | `settlement.service.ts:928` | ⚠️ **被第三方验证推翻过一半**：截断在事实上成立（`pageSize: MAX_PAGE_SIZE`=100），但**「静默」不成立** —— 页面**恒等**提示：`platform-admin/.../settlements/page.tsx:116-120` 显示「共 {list.total} 张（本页显示 {items.length} 张）。超过 100 张时请按周期筛选」，而 `list.total` 是真实的 `count`（`settlement.service.ts:913`）不是 `items.length` → **凡截断必触发提示**；且 `platform-settlement.controller.ts:67` 的 Swagger 摘要写明「（最多 100 条）」；服务层注释明写「与列表页文案口径一致」。<br>✅ **成立的部分**：① 不筛选周期时的文件名是 `settlements-all.csv`（`:73`）—— **字面看是全量、实为前 100 行**，运营若绕过页面直接调接口并把文件转交财务，唯一的告知只剩文件名与 Swagger 摘要；② CSV **文件内容本身**没有「共 N 张 / 已截断」说明行；③ `exportCsv` 确实无直接单测、`api/test/settlement.e2e-spec.ts` 也无导出用例（但按主控规则「缺测试本身不算缺陷」，且转义与公式注入的核心逻辑已有 `api/src/common/http/csv.spec.ts` 覆盖）。<br>⚠️ 整个 100 条上限是**阶段 9 已评审结项的设计决策**（设计文档 `:205` 明确「不做跨页全量导出」），属「已记录的已知限制」。 |
| P2-7 | 全新部署 MinIO bucket 不自动创建 | `minio.service.ts:34` | 全仓无 `CreateBucket` 调用；compose 镜像里**没有 `mc`**（注释明写「这个镜像里没有 mc / curl / wget」）→ 没有别的创建途径。实测：presigned URL 签发成功但 PUT 返回 404 `NoSuchBucket`。<br>⚠️ **对抗验证第 22 条（real=true, sev=medium）实测复现并补充了四点**：<br>① **链路完整**：`media.service.ts:117-130` 先 `prisma.media.create` 落一行 `status:'PENDING'`，**再**签 uploadUrl → 「签发成功但 PUT 404」成立，PENDING 行确实留下（24 小时后被 `cleanupOrphans` 标为 `ORPHANED`，但 **media 行从不被硬删** → 垃圾行无限累积）。<br>② **本机现有环境不受影响**：`minio-data` 卷里已有 `ecommerce-media` 目录（2026-10-22 由 plan 02a 的人工 Step 1.5 建的，该 plan 3704-3740 行明写「MinIO 不会自动建 bucket」）→ **只有全新机器 / 全新卷 / 不含该卷的备份恢复才触发**。<br>③ **有一条现成的检测手段被关掉了**：`api/test/media.e2e-spec.ts:270-275` 会真 PUT 并断言 `put.ok`，本来能抓住这个 bug —— 但 `.github/workflows/ci.yml:190` **整条排除了 media 套件**（即 P2-B1）。两条是同一个问题的两面。<br>④ **修起来很轻**：`@aws-sdk/client-s3` **已是 api 的运行时依赖**（`api/package.json:43`）→ 在 `onModuleInit` 里补一次 `HeadBucket` + `CreateBucketCommand` 即可，**无需新增依赖**。<br>⑤ 严重级别 medium：无资损、无越权；商品创建不强制带图（`mediaIds` 走独立接口且 `@ArrayMinSize(0)`）→ 下单/支付链路不受阻，属功能降级；失败显性可诊断（商家立刻看到「上传失败 HTTP 404」）。 |
| P2-8 | 库存流水记下消费者 id（对抗验证第 9 条**实测确认**，并收窄定性） | `api/src/modules/inventory/inventory.controller.ts:19` → `inventory.service.ts:101` | schema 注释写「阶段 2 的库存调整是**商家手动操作，填店主 id**」，但控制器传的是 `user.userId`。因为 P1-1（缺 `@Roles`），**消费者的 userId 会被写进「店主操作」的审计字段**（对抗验证实测：消费者令牌 `POST /api/v1/inventory/adjustments` → **HTTP 201**，响应体 `movement.operatorId = "<消费者 user id>"`）。修完 P1-1 自动消失。<br>⚠️ **定性要收窄（对抗验证纠正）**：这个洞的真正危害是**授权缺失**本身，不是 `operatorId` 字段语义 —— 消费者能改 SKU 价格为 1 分才是资损链（属 P1-1）。而且 **`operatorId` 全仓没有任何消费方**（我已 grep 确认：三个前端都不展示、后端也不读；`schema.prisma:370` 的 `operatorId String?` 只写不读）→ **它目前只是一条没人看的审计痕迹**。<br>→ **建议**：字段语义在 schema 注释里写明「人工调整填操作人 id，RESERVE/RELEASE 为 null」；顺带考虑是否真的需要存这个字段。 |
| P2-9 | 替换规格矩阵可击穿 `maxSkus`（对抗验证第 28 条**实测复现**） | `api/src/modules/catalog/specs/spec-matrix.service.ts:82` | DTO 上限 2 维度 × 20 值 = **400 个组合**；额度检查比的是「当前 SKU 数」。<br>⚠️ **对抗验证实测**（测试库 `ecommerce_test`，套餐 `maxSkus=10`，商家订阅后替换规格矩阵）：**响应 200、租户 SKU 计数 400**，上限 10 被击穿。全仓 `api/src` 里 `sku.create/createMany/upsert` **只有 `spec-matrix.service.ts:284` 这一处** → 唯一创建 SKU 的路径；`maxSkus` 只有 `quota.service.ts:94` 一处被消费；**没有每商品 SKU 上限、没有数据库约束**，租户扩展只做行作用域隔离，挡不住。前端 `merchant-admin/src/app/api/products/[id]/specs/route.ts` 只校验 2 维 × 20 值与文本长度，同样不设额度闸。<br>**设计意图已被违背**：`docs/superpowers/specs/2026-10-25-plan-05b-billing-design.md:536` 写明「maxSkus｜创建 SKU 时｜当前 SKU 数 ≥ 上限 → 拒绝」，且 `grep -rn "maxSkus" api/test/` **零命中** → 无回归覆盖。<br>⚠️ **比「额度绕过」更严重的是「击穿后不可恢复」**（对抗验证补充）：超限后所有替换规格请求一律 409，**缩小矩阵也被拒**（`:82` 的检查只看既有 SKU 数）；软删商品**不释放额度**（`ProductsService.remove()` 只写 `product.deletedAt`，全仓无任何地方软删 SKU）；多余的 SKU 只置 `INACTIVE` 不软删（`:304-310`）→ **SKU 计数只增不减**，商家只能靠平台抬高 `maxSkus` 才能恢复 → **规格编辑功能被永久锁死**。<br>⚠️ **额度检查在事务外**（检查在 `:82`，事务在 `:124` 才开）→ 并发放大：**3 个并发请求实测全部 200、写出 1200 个 SKU**（上限 10）。<br>⚠️ 种子里的试用套餐 `maxSkus=50`（`prisma/seed.ts:415`）且 demo 商家已订阅 → **开箱即达**。<br>严重级别 medium：付费套餐额度绕过（试用档 50 实际可拿 400，约 8 倍）叠加商家自伤型且不可恢复的锁死，但不跨租户、不动钱、不破坏数据。 |
| P2-9b | **INACTIVE 的 SKU 仍占套餐额度**（与 P2-9 同根因，建议一起修） | `api/src/modules/billing/quota.service.ts:118` | `sku.count({ where: { tenantId } })` **不带 `status` 过滤**；租户扩展只自动合并 `deletedAt: null`，而 `INACTIVE` 不是软删 → 商家反复改规格，每次留下一批 INACTIVE 的旧 SKU 虚占额度，最终一个 SKU 都加不了（用户可见的功能性阻塞）。<br>⚠️ 我已核实 `ProductsService.remove()`（`products.service.ts:264-274`）**只写 `product.deletedAt`**，全仓**无任何地方软删 SKU** → **软删商品不释放 SKU 额度**。这一条与 P2-9 构成一条完整的「额度只增不减」链：**P2-9 让额度能被击穿，P2-9b 让击穿后无法恢复**。<br>**修法**：① 额度检查移到**事务内**（消除并发放大）；② `sku.count` 排除 `INACTIVE`，或改用「只数活跃 SKU」的口径；③ 软删商品时**级联软删其 SKU**（否则商品删了额度还在）。 |
| P2-10 | 套餐额度检查「先查后判」不在事务内（对抗验证第 29 条**实测复现**） | `api/src/modules/billing/quota.service.ts:85` | **实测**：`maxProducts=1` 的套餐，商家订阅后**并发**打 10 个 `POST /api/v1/catalog/products` → 状态分布 `[201,201,201,201,201,201,409,409,409,409]`，**201 计数 6**，库内该租户 `product.count = 6` → **上限 1 的套餐实际建出 6 个商品**（50 并发时建出 3 个）。<br>**代码路径**：`quota.service.ts:85` `assertWithinQuota` → `:99` `countUsage` → `:100` `current >= limit` 判定 → **之后才**在 `products.service.ts:169` 执行 `product.create` → 纯「先查后判」。<br>**逐条排查挡住它的机制，全部不存在**：① `products.service.ts` 的 `create()` 内**没有 `$transaction`**（该文件仅 `:317`/`:375`/`:467` 三处事务，都不在 create 路径）；② `quota.service.ts:113` 的 `countUsage` 签名是 `private async countUsage(tenantId, kind)`，**根本没有 `client` 参数**（对比同文件 `:46` 的 `currentPlan(tenantId, client = this.prisma)` 就有）→ **物理上无法接进事务**；③ SKU 路径 `spec-matrix.service.ts:82` 的检查同样位于 `:124` 的 `$transaction` 之前；④ `products` 表只有 `@@index([tenantId,status])` 与 `@@index([tenantId,categoryId])`，**无计数相关唯一索引/触发器**，全仓 grep 无 advisory / Serializable / isolationLevel / Redis 锁，`prisma/migrations/**` 无 trigger；⑤ `infra/nginx/platform.test.conf` 全文无 `limit_req`/`limit_conn`，api 无 `@nestjs/throttler` → **无限流阻碍**。<br>⚠️ **必须并发才触发**，单发请求会被正确拒绝（409）→ 现有 `billing-quota.e2e-spec.ts:417` 的 M13 用例**不是假绿**，它只覆盖串行路径，缺的是**并发用例**。<br>**修法**：① `countUsage` 加**可选 `client` 参数**（照 `currentPlan` 的写法）→ 接进事务；② 额度检查与创建**放进同一个 `$transaction`**；③ 修的时候**两个调用点都要覆盖**（`PRODUCT` 在 `products.service.ts:161`、`SKU` 在 `spec-matrix.service.ts:82`）；④ 加并发 e2e 用例。<br>**本仓库已有正确范式可参照**：`coupon.service.ts:331` 的「必须用条件更新，不能先查后改」+ `updateMany({ where: { claimedCount: { lt: totalLimit } }, data: { increment } })`，**受影响行数为 0 即额度已满**。<br>严重级别 medium：影响限于单租户自身套餐额度，不跨租户、无数据泄漏、无资损 → 属套餐档位的销售漏损 + 运营可见的额度失真，量级受并发窗口约束；但**无限流且触发条件极简单**（10 个并发 POST 即可）→ 可利用性很高。 |
| P2-11 | 账单支付单「先查后建」未处理 P2002（⚠️ 对抗验证 agent 因额度未跑，**主控已补核实：成立，级别 low**） | `payment.service.ts:407` | `obtainInvoicePayment`（`:399-445`）是 `findFirst({ invoiceId, channel })` → 查不到就 `create`，**没有 catch P2002**。同文件明明导入了 `isUniqueViolation` 并在 `:225` / `:686` / `:1993` 三处使用，**唯独这里漏了**。两个调用方可并发：`:330` `createInvoicePayment`（商家后台手动补付，HTTP 请求）与 `:506` `chargeAndSettle`（自动续费，BullMQ 定时 job）之间**没有任何互斥**（`:526` 注释自认「单副本假设，跨副本并发扫描未加锁」）→ 并发时双双查空、双双 create，输家撞 `payments_invoice_channel_uniq`（`20261025220000_add_billing_tables/migration.sql:176`）→ 全局过滤器不识别 Prisma 错误 → **500**。<br>**级别 low 的依据（主控核实）**：输家死在 `create`，发生在渠道调用**之前** → **不产生重复扣款、无资损**；赢家照常扣款；商家再点一次就走复用路径（`findFirst` 查到 PENDING/FAILED → 复用）→ **重试即自愈**，属瞬时 500。<br>**修法**：照 `:225` 的样子 catch `isUniqueViolation` → **事务外**重查走复用分支（本仓约定：P2002 必须在事务外处理）。 |
| P2-12 | README「一键启动」不可用 | `README.md:138`、`infra/docker-compose.yml:119`、`api/Dockerfile:45` | 根因**不只** compose 那一行：`api/Dockerfile:45` 也有 `ENV NODE_ENV=production` → **只删 compose 第 119 行仍会崩**（实测：不给 NODE_ENV，镜像自带 ENV 触发同一报错）。且即使换掉真实 JWT_SECRET / 账目密钥，阶段 9 的 `assertProductionCredentials()` 仍会因 compose 默认 Postgres / MinIO 密码拒绝启动 → **「compose 默认值集合 + production」整体不兼容**，要真跑通必须同时提供 DB/Redis/MinIO 凭据 + 真实 JWT 密钥 |
| P2-13 | 文档口径过时（AGENTS.md + README） | `AGENTS.md:217`、`README.md:461` | **AGENTS.md**：「三个前端没有共享包」与第 17-23、62 行矛盾。**README**：「阶段 4 验收发现的下一阶段优先项」第 1 条「给轮换后的旧令牌一个宽限期」**阶段 5c 已实现**（`auth.service.ts` 有 `REFRESH_GRACE_PERIOD_MS` / `graceExpiresAt` / `token-grace.worker.ts`），但 README 仍列为待办。⚠️ 更隐蔽的危害：AGENTS.md 的旧指引会让有人按「写一份 → `cp` → `diff`」改三端令牌逻辑，**三端薄壳目前没有任何一致性 CI 守卫** → 令牌刷新逻辑静默分叉 |
| P2-15 | **一处违反「落库时刻用 `prisma.databaseNow()`」纪律** | `payment.service.ts:435` | `updatedAt: new Date()`，且 `Payment.updatedAt` 是 `@updatedAt`（Prisma 自动管理）→ 这个赋值**完全多余**。⚠️ 危害很低：`updatedAt` 只用于展示（支付方式列表、收款账户），**不参与任何财务归期或口径**。<br>✅ 已修（提交 `40e3c54`）。<br>⚠️ **原文「全仓唯一一处」不准确**（2026-11-06 复核更正）：`markEventProcessed` 的 `processedAt`（已随 `17213f7` 修掉）、`scanRefunding(now = new Date())`、`order.service.ts` 的 cancelledAt/shippedAt/completedAt、`auth.service.ts` 的 revokedAt 等都还是应用进程时钟。本条只清掉了「完全多余的那个赋值」。<br>✅ **同类存量已于 2026-11-07 收敛**（提交 `a7c0072`）：订单 / 认证 / 退款扫描的落库时刻全部改用库时钟，口径与排除项见 §〇「批次 11 的实施记录」。 |
| P2-16 | **保留子域名列表漏了 `merchant`** → 商家能注册一个访问不到的店铺 | `tenant-models.ts:25` vs `infra/nginx/platform.test.conf:117` | `RESERVED_SUBDOMAINS` 有 `admin` / `api` / `platform`，**唯独没有 `merchant`**（而 nginx 里 `merchant.platform.test` 是**精确匹配**的 server 名）。注册校验（`register-merchant.dto.ts:41`）只查这个集合 → 商家**能**注册子域名 `merchant` → 但 nginx 的精确匹配优先于租户正则 → 该店的店铺前台 `http://merchant.platform.test` 落到商家后台，**店铺打不开**。<br>⚠️ 不是安全漏洞（是可用性 + 枚举），修法：`RESERVED_SUBDOMAINS` 加 `merchant`。<br>（我核实过 nginx 的匹配顺序：精确 > 正则 > 通配符 > 默认 server） |
| P2-14 | `test/rbac.e2e-spec.ts:17-21` 注释在骗人 | 同上 | 写「RolesGuard 由 AppModule 的 APP_GUARD 提供」，与 `app.module.ts:23-26` **直接矛盾** —— 这很可能就是漏挂能存活至今的原因 |

## 四、护栏建议（P1，价值最高）

`@Roles` 逐路由显式开启是**系统性风险**（这次漏挂 5 个，下次可能漏别的）。

- **静态扫描器**：用 TypeScript AST 扫控制器，识别类级/方法级 `@Roles`。
  技术路径已验证可行（探针跑通，`ts.createProgram` + `ts.getDecorators`，
  需 `experimentalDecorators: true`），结果与正则统计吻合。
- **⚠️ 关键：扫描器不能简单地「无 `@Roles` 就报错」**。探针实测：
  **129 个控制器路由里 60 个没有 `@Roles`，但其中只有 21 条是真正的越权**
  （P1-1）。其余 39 条是合法的：消费者路由（auth / cart / address / coupon /
  order / payment）、公开路由（`@Public()` 的 public-catalog）、渠道回调
  （webhook）、假网关（fake-payment）、注册与登录、健康检查。
  → 规则必须区分**「应当有角色限定」的路由**与**「按设计就不该有」**的路由，
  否则规则会永远 exit 1，护栏变成噪音（与 tx 边界扫描器踩过的坑同源）。
- **e2e 断言**：参照 `api/test/coupon.e2e-spec.ts:471` 的现成写法
  （`registerCustomer(merchant.subdomain)` + 期望 403），
  对 5 个控制器补「CUSTOMER 令牌 → 403」。
- **修正 `test/rbac.e2e-spec.ts` 的错误注释**，并让该测试真正验证业务控制器。

## 五、已判定为「设计如此 / 不修」

- **店员能绑支付方式 / 付账单 / 换套餐**（`subscription-payment.controller.ts:41`、
  `billing.controller.ts:19` 的类级 `@Roles(MERCHANT_OWNER, MERCHANT_STAFF)`）：
  注释明说这是「这个店铺」的操作；金额只从账单读；影响的是本店订阅。
  改会误伤日常运营账号。
- **账目加密自检在无数据时静默通过**：注释明写「新库、或还没跑迁移的库都不该因此起不来」。
- **出款抢单无 `orderBy`**：抢单有 `where: { id, status: APPROVED }` 条件更新，同一单只能打一次钱。

## 六、修复顺序建议

> **排序原则**：「改动小 × 危害大」优先。前 5 步都是 1-2 行的改动，可以一起做、一起验。
>
> ⚠️ **三条修法要动数据库，建议合并成一次手写迁移**：
> - **P0-2**：改 `orders_tenant_idempotency_uniq` → `(tenantId, customerId, idempotencyKey)`
> - **P1-5**：新增 `payment_methods_tenant_default_uniq`（部分唯一索引）
> - **P0-7（待确认产品意图后）**：改 `coupon_redemptions_coupon_active_uniq`
>   → `(couponId, customerId)`
> 三处都是 `prisma/migrations/` 下的**新文件**（已落库的迁移不能改，checksum 会变），
> 用 `npx prisma migrate diff` 核对后再 `npx prisma migrate deploy`。
> **改索引前务必先在有真实数据量的库上试**（见第九节）。

1. **P1-1 五个控制器加 `@Roles(MERCHANT_OWNER, MERCHANT_STAFF)`**（21 条路由）
   + P1-2 批量改价夹 0
   —— 唯一一条「普通消费者即可获得店主级写权限」的漏洞，利用成本近零、后果直接改价改库存。
   `@Roles` 装饰器与 `RolesGuard` 已存在并被 `merchant/orders`、`merchant/coupons` 正常使用 →
   **照抄现成模式即可**，不是新增机制。
2. **P0-2 幂等键归属** —— ⚠️ 要连带改唯一索引（新增迁移），见 P0-2 的 A/B 两条修法。
3. **P0-4 出款佣金口径改 fail-closed** —— 与 `ledger.ts:237` 的既有判定对齐，
   **正确口径就写在同一个模块里**，只需让写路径采纳它。
   ⚠️ **但不能「一律 fail-closed」** —— 零佣金商家天然没有结算单，会被误伤；
   必须用「该期是否有抽佣流水」区分两种「无结算单」（见 P0-4 条目）。
   **且不要用「回落聚合 CommissionEntry 算佣金」** —— 数值仍以结算单为准。
4. **P0-5 Redis 密码守卫**（1 行）+ **P0-6 消费端复核金额**（**必须同时做**）
   + **P2-A1 生产渠道列表为空拒绝启动**（同为 fail-open）
   ⚠️ P0-5 只锁门不堵路 —— **P0-6 才是堵路**（消费端不信 job 里的金额）。
   只做 P0-5 的话，「能写 Redis」这个前提一旦成立，资损路径依然敞开。
   ⚠️ P0-6 建议 **②（金额从订单反查）+ ③（复核事件行）一起做**：
   ② 只是一行 if（`order.totalAmount` 现成可用，**零额外查询**），
   ③ 才是真正的凭证（没经验签端点登记的 job 一律不生效）。
5. **P1-4 MinIO CORS 变量名**（compose + `.env.example` 两处）
   + **P2-7 bucket 自动创建** + **P2-3 登录限流**
6. **P0-7 券跨用户失效** —— ⚠️ **动手前必须先确认产品意图**（见 P0-7 条目的三种修法）：
   - 若「一券一实例」**不是**产品要求 → 改部分唯一索引为 `(couponId, customerId)`（**新增迁移**）
     + `findCandidateCoupons` 按 `customerId` 过滤；
   - 若是产品要求 → 至少让 `listMine` 的 `used` 口径与 `findCandidateCoupons` 一致
     （消除「我的券显示可用却用不了」的自相矛盾）。
   ⚠️ **改错了会让「限 50 张」的券实际只能用 1 张** → 别急着动，先问清楚。
7. **P2-17 领券总量闸**（1 行）+ **P1-5 默认支付方式不变式**（部分唯一索引 + 归属校验）
8. **护栏**：AST 静态扫描器（规则要区分「应当有角色限定的路由」与「按设计就不该有的」，
   见第四节）+ e2e 断言（CUSTOMER 令牌 → 403）
   + **P2-B2 闸 ③ 用例**（钩子已备好，只差一个用例）
   + **P2-B4 回归加固**（两条对账写路由的 DTO 接线无测试锚定：
   `@Body() dto` 改成内联 TS 类型会让 `ValidationPipe` 直接跳过校验）
   （P2-B3 已降级为补测建议，P2-B4 已被实测推翻但留加固建议，
   P2-B5 已升级为 P1-5，P2-B6 已被变异测试推翻）
9. **P0-3 支付回调状态机 + P1-3 双渠道退款** —— 同一处结构性修复：
   订单流转失败时按订单真实状态分流（已 PAID = 重复投递、已 CLOSED/CANCELLED = 迟到扣款需退款），
   并把多渠道的第二笔 SUCCESS 支付单纳入退款路径。改动面较大，需单独设计。
   ⚠️ **P0-3 的修法必须覆盖 CANCELLED 路径**（不只是 15 分钟超时），
   且要给出「平台内无法退款」的补救出口 —— 商家现在对这类单**没有任何系统内手段**。
10. **P2-A4 账目自检补货款冲回检查** —— ✅ 已完成（提交 `6f02d30`，实施记录见 §〇）
   （⚠️ 谓词用 `totalAmount` 不是 `commissionAmount`，否则零佣金订单被误报）
11. **P2 各项**（含 P2-B2 闸 ③ 用例、P2-15 时间戳纪律、P2-A3 迁移后立即自检）
    —— ✅ 全部完成（提交 `40e3c54`、`b264ac5`、`ce98ae4`、`1c5d94c`、`3fb8550`，
    实施记录见 §〇「批次 11 的实施记录」）。
    其中 **P2-9 + P2-9b + P2-10 是同一条链**（套餐额度），
    修法：额度检查进事务 + `countUsage` 加可选 `client` 参数 + 排除 INACTIVE + 软删商品级联软删 SKU。
    ⚠️ 落地时补充了两条原条目没写到的：**必须先锁 `subscriptions` 行**（只搬进事务挡不住并发放大），
    且**不能锁 `tenants` 行**（外键的 `FOR KEY SHARE` 与 `FOR UPDATE` 冲突 → 与下单路径成死锁环）。
    **P2-5** 三处 500 修在 **api 侧**（不是前端中转）。⚠️ 时间参数用
    `@Type(() => Date) + @IsDate`，**不是 `@IsDateString()`** —— 后者会放过 `20260101`。

---

## 九、还没被任何一方验证过的部分（诚实标注）

这些是我在评估过程中**看过但没有深挖**的区域，**不代表没问题**，只代表本次审计没覆盖到：

| 区域 | 为什么没深挖 | 建议 |
|---|---|---|
| **三端的组件测试** | storefront/merchant-admin/platform-admin 的测试主要是 BFF 与 lib 层；组件测试只在部分文件用 jsdom | 阶段 9 记录的「merchant-admin 缺组件测试基建」就是这条 |
| **Next.js 15 / React 19 的运行时行为** | 依赖漏洞之外没查框架自身的边界（Server Component 的缓存、`revalidate` 语义） | 与前端 BFF 一起看 |
| **nginx 的其他 server 块** | 只读了 `location /api/v1/` 与 5 个 server 块的骨架 | 5 个 server 块（主站 / api / storefront / merchant / platform）之间的路由分流没逐条验<br>⚠️ **部分已被对抗验证覆盖**：它经 nginx 网关（`Host: demo.platform.test`）实测了领券接口，**确认 `/api/v1/` 是直通、storefront BFF 的 `quantity` 白名单只挡 UI 路径不挡手写 API** |
| **三端 BFF 路由的系统扫描**（71 个 route.ts） | 专项扫描 workflow（5 个维度）因模型额度耗尽 **0/5 中止** | ✅ **已覆盖的抽查全通过**：主控逐字段核对 6 个关键路由（`stores/me`、`tenants/[id]/status`、`billing/settlements`、两处批量上限 200）；对抗验证顺带实测了导出 BOM（P2-1）、商品列表参数键白名单、订单列表日期转发、storefront 券 `quantity` 丢弃<br>⚠️ merchant-admin 的 35 个路由只过了上面几个，**未逐个过白名单** |
| **第二轮资金链路的 3 个方向** | 专项 workflow 因额度耗尽 **3/4 中止**（出款与结算口径 / 退款与冲回链路 / 订单金额口径） | 跑完的那 1 向产出了 P0-7（券跨用户失效）并经主控核实；**3 个未跑的方向不算已验证**，后续动手前值得补 |
| **Prisma 迁移在生产数据上的实际行为** | 只核对了索引定义与迁移清单，没在有真实数据量的库上跑 `migrate deploy` | 改 P0-2 的索引前，务必先在有数据的库上试<br>⚠️ 本机 `ecommerce` 与 `ecommerce_test` 两库的 `payment_methods` **都是 0 行** → P1-5 的部分唯一索引在本机可以直接建，但**不代表生产库没有「同租户多个默认」的存量** |
| **真实渠道的接入** | 仓库只有 fake / sandbox 实现，真渠道（微信 / 支付宝）**一行代码都没有** | 上生产前必须走「新渠道准入」的契约套件 |
| **备份与恢复脚本** | `infra/backup.sh` / `restore.sh` 读过文件名，没逐行审 | 平台自管备份的可用性是另一条线 |

---

## 十、评估本身的局限

- **我改动过的东西已全部还原**：`git status` 除本清单文件外干净；
  第三方验证在开发库留下的 317 个探测账号已删除（关联业务数据本就为 0）；
  隔离验证库（coupon_vrfy / idem_vrfy / nan_vrfy）已 DROP；
  探针容器（minio-cors-probe / minio-bucket-probe / minio-cors-commacheck / minio-cors-test2）已 rm；
  临时 .mjs / .ts 探针文件已删。
- **失败注入曾短暂改过源码**（`media.service.ts` 删掉 size 校验那 16 行），
  已用 `git checkout --` 还原 —— 这是 AGENTS.md「失败注入必须独占」纪律下的常规操作。
- **开发库 `ecommerce` 与测试库 `ecommerce_test` 未被破坏**：所有实测都在隔离库
  或只读查询上做。
- **本清单不是「全部问题的完备列表」**：它是一次高强度审计的产物，
  覆盖了资金链路、权限、并发、配置、测试护栏五个维度，
  但**不等于穷尽**。三个后台 workflow 已全部终局：对抗验证 31/32 交卷
  （缺的 1 条主控补核实）、第二轮资金链路 1/4、前端 BFF/nginx 扫描 0/5 ——
  后两者因模型额度耗尽（429）中止，未跑完的方向见**九**，不算已验证。
- **验证用的临时产物已清干净**：对抗验证 agent 留下的 7 个 `api/test/tmp-audit-coupon*.e2e-spec.ts`
  与 1 个 `api/test/zz-a31-repro.e2e-spec.ts` 探针文件已删除；
  `git status` 除本清单文件外干净。

---

## 七、三份独立审计的交叉核对结论

本清单由三条独立路径交叉验证：

| 来源 | 方法 | 覆盖 |
|---|---|---|
| 主控（我） | 逐条读代码 + **4 条隔离环境实测复现** | 全部 39 条 |
| 对抗验证 workflow（`wf_d02ac039-66a`） | 怀疑者逐条推翻，39 个 agent 中 **31 个交卷**（32 条声明 + 7 个完整性批判；批判与 1 条验证因额度 429 中止，缺的那条由主控补核实） | 前 32 条 |
| 7 维度审计 workflow（`wf_6a19d5a2-152`） | 22 个 agent，14 条高危对抗验证 | 全仓 |
| 资金链路 + 遗漏猎手 workflow（`wf_d2ac816c-2c5`） | 11 维度 + 对抗验证 | 进行中 |

**交叉核对带出的 12 处修正**（都是第三方发现的，我原判断不够准）：

1. **P0-2 的修法被证伪**：只加 `customerId` 会把「泄漏」变成「500」→
   必须同时改唯一索引，或在两条路径上单独抛 409。
2. **原 P0-1（领券超发）的严重级别从 critical 降到 low**（对抗验证实测复现后）：
   机制确凿，但**优惠引擎根本不看 `quantity`**（`findCandidateCoupons` 只 `select: { couponId: true }`）
   → 领 10 张与领 1 张的抵扣价值**完全相同**，多出的 ≤9 张是死券 → **无资损**。
   且「其他消费者被挡在促销外」不该记这条头上（`perUserLimit=null` 时
   任何人重复调 100 次也能领空，终态相同）→ 本条只是把请求数压到 1/10。
   → **已降级为 P2-17**。
3. **P1-4 的危害面收窄**：MinIO 走 SigV4 不认 cookie → 响应全是 `403 AccessDenied`，
   控制台会话也不受影响 → 从 high 降到 medium。
4. **P0-4 多了「两套规则互相矛盾」这个关键事实**：
   `ledger.ts:237` 明确 fail-closed，而 `payout.service.ts:1460` 放行 →
   **能真正打钱的那套是错的**，且商家在申请页能看见「平台佣金 ¥0.00」。
5. **P2-4 / P2-B1 被推翻过一半**：我原写「media 在 CI 里零覆盖」是**错的** ——
   `catalog.e2e-spec.ts:714`（媒体跨租户拒绝）等三处仍在 CI 跑，
   且排除本身是阶段 9 评审过的**显式取舍**。成立的部分只是「被排除套件的安全逻辑零覆盖」。
6. **P2-6b 的「静默截断」被推翻**：页面**恒等**提示「共 N 张…超过 100 张时请按周期筛选」，
   且 `list.total` 是真实 count。成立的部分只是「CSV 文件内容里没有说明行、
   文件名 `settlements-all.csv` 字面像全量」。100 条上限本身是**阶段 9 已结项的设计决策**。
7. **P2-B3 被推翻（对抗验证实测）**：对账接口的 `@Roles(PLATFORM_ADMIN)` 机制**经实测有效**
   —— 未登录 401、商家令牌 403（含 multipart 端点）。我原写「从未被 HTTP 层验证过」不准确；
   该条降级为补测建议。连带发现我原写的「其他每个平台前缀都有 403/401 用例」也不准确
   （`platform/plans`、`platform/coupons` 也缺 401 用例）。
8. **P2-B5 升级为 P1-5（对抗验证发现的新缺陷）**：
   「默认支付方式」不变式只靠应用层、**表上没有部分唯一索引** →
   `setDefault` 传不存在的 id 会**清空全部默认卡并返回 200**，`remove` 不提位、
   `create` 两条语句无事务 → 商家订阅静默停摆。
9. **P2-B6 被变异测试推翻**：我原写 `expect(listed.total).toBe(listed.items.length)`
   是「结构上必然成立」的恒真断言 —— **错**。`total` 来自**服务端响应体**、
   `items.length` 由**客户端**算出 → 两条不同代码路径，**有真实区分度**。
   变异测试（5 次改动全部被抓）比读代码判断可靠得多。
10. **原 P1-3（账目自检漏检货款冲回）降级为 P2-A4（medium）**：
    退款三步在**同一个 `$transaction`** 里（`payment.service.ts:1259-1288`）→
    正常退款路径**产生不了**这种损坏状态；唯一可达路径是 `backfill()` 里
    两条**独立的非事务写入**被中断 → 是「数据已经坏了」不是「数据会坏」；
    且该脚本**不接任何自动闸门** → 退出码 0 今天不阻止任何发布动作。
11. **P2-B4 被实测推翻**：对抗验证临时写了真实 e2e，测出这两条路由的
    DTO 校验分支与状态码映射**全部正确**（无 500、无走错分支），
    且服务层断言是实的（不是恒真）→ 属「覆盖率记录」不是缺陷。
12. **P0-4 的修法要加一个区分（对抗验证第 26 条）**：我原写「无结算单 → 一律 fail-closed」
    —— **会误伤零佣金商家**：零额抽佣不记流水（`commission.service.ts:110`）→
    结算单生成覆盖不到（`settlement.service.ts:305-309` 返回 `{ kind: 'empty' }`）→
    **零佣金商家天然没有结算单**。
    → 修法必须区分「本该有佣金但漏跑结算单」（→ 409）与「真的零佣金」（→ 允许）。
    可行判据是**该期是否有抽佣流水**（只用于判断「该不该有佣金」，不用来算数值）。
    同条还纠正了损失幅度：**损失 = 佣金率（5%），不是货款全额**。
13. **P0-3 的触发面比原先记的宽（对抗验证第 25 条）**：`CANCELLED` 路径同样成立，
    且**真实渠道的延迟回调是常态**（数秒到数分钟）；更要紧的是
    **平台内没有任何补救路径** —— `refund()` 要求订单 `PAID`/`SHIPPED` → 商家无法在系统内退款；
    且 `check-ledger` 只查 `paidAt` 非空的订单 → **查不出这些孤儿 SUCCESS 支付单**，
    全仓也无孤儿扫描器 → 静默卡住、不会告警。
14. **P2-9 实测复现且比原先记的更严重（对抗验证第 28 条）**：
    实测 200 + 写出 400 个 SKU（上限 10）；**额度检查在事务外** → 3 个并发请求写出 1200 个；
    且**击穿后不可恢复**（缩小矩阵也被拒、软删商品不释放额度）→ 规格编辑被永久锁死。

**主控独立复核带出的 1 处新增**（对抗验证没提，我在核实 P0-5 时发现）：

15. **P0-6 消费端不核对金额**（新条）：**验签与金额核对都只在 webhook 的 HTTP 端点做**，
    消费端两件事都不做 → 能写 Redis 的人投递一个 job 就能把任意订单标记为已支付，
    **金额填 1 分钱照样流转** → 直接资损。
    ⚠️ 精确边界：**只有「订单支付」路径缺** —— 退款路径有核对
    （`applyRefundEventInTenant` 比 `event.amount !== payment.amount`）、
    订阅路径也有核对（`applySubscriptionEvent` 比 `invoice.amount !== event.amount`）。
    ⚠️ **P0-5 只锁门不堵路** —— 两者必须一起修。
    ✅ 好消息：`applyEvent` 里 `order.totalAmount` 现成可用 → **修法零额外查询**。
    ⚠️ 但 ② 只能把「任意金额付款」降级为「全额付款」，**要彻底消除需要 ③（复核事件行）**。

**收尾批次的 3 处补充**（最后两份交卷 + 主控补核实，2026-11-05 晚）：

16. **对抗验证内部也会互相矛盾 —— A30 与 A32 对「生产能不能启动」给出了相反前提，主控用源码裁决**：
    A30（双渠道退款）的理由里写「生产环境 assertSecureConfig 会因两个渠道都是 devOnly 直接拒绝启动」，
    A32（渠道零配置）实测「生产不配任何渠道 → 启动放行」。
    **A32 对**：`enabledChannels()` 在生产不配时返回 `[]`（`channel-config.ts:84`），
    `assertChannelConfig` 的两个 `for` 循环一次都不执行 → 无断言触发（这正是 P2-A1 的机制）；
    「配了才被拒」与「不配能启动」同时成立，两条交卷并不冲突，但 A30 把「生产无法启用渠道」
    误写成了「生产无法启动」。本文档按核实后的准确表述记录（P0-3 末条、P1-3 触发前提均已修正）。
17. **P1-3 的根因归因被纠正（A30）**：「`findMany` 无 `orderBy`」不是根因 —— 即使加确定性排序，
    退款仍是单笔语义、订单转 `REFUNDED` 即终态，第二笔照样永久卡库。
    真正的缺陷是「退款路径单笔语义 × 数据模型允许同订单多渠道各一笔成功支付」（详见 P1-3）。
18. **P2-11 由主控补核实（A31 的验证 agent 因额度未跑）**：机制成立 ——
    `obtainInvoicePayment` 的 `findFirst` → `create` 没有 catch P2002，两个调用方（手动补付 / 自动续费）
    可并发 → 输家 500；但输家死在渠道调用之前、重试走复用路径自愈 → **级别 low**（详见 P2-11）。

**三方一致、且经过实测的「唯一 critical」**：P1-1（消费者可改价改库存）。
**三方一致的最高危三条**：P1-1（越权）、P0-4（平台白送佣金）、P0-3（钱收了货不发）。

---

## 八、我独立核实后判定为「健全」的部分（不必担心）

为免误解，把**我逐行读过、确认没有问题的关键路径**也记下来：

| 路径 | 核实结论 |
|---|---|
| **退款落账** | `applyRefundInTx`（`payment.service.ts:1231`）把「支付单转 REFUNDED + 订单转 REFUNDED + 抽佣冲回 + 货款冲回」放在**同一事务**；两次冲回都用条件更新（`status: RESERVED` → `USED`），重复执行安全 |
| **金额口径链** | `originalAmount`（原价）→ `payableAmount`（实付）→ `totalAmount` = 实付 → `merchant_receipts.amount` = 实付 → 抽佣基数 = `payableAmount`；结算单 `netAmount = grossAmount + reversalAmount` = 净佣金。**整条链的基数一致** |
| **出款执行的三道闸** | 明细金额合计、明细笔数、`netAmount == receiptAmount − commissionAmount` —— 都在（但全是**内部自洽**校验，拦不住「佣金 0」） |
| **出款渠道锁定** | 审批时把渠道写进 `payouts.payoutChannel`，与状态改 `APPROVED` 同一个 `updateMany` → 审批后改配置不影响已审批单 |
| **队列幂等** | 出款重试的 jobId 带轮次（`currentAttempt + 1`）、`removeOnComplete` 已设；自动续费用固定 `jobSchedulerId: billing-scan` 去重；账单有 `invoices_subscriptionId_periodStart_key` 唯一索引兜底 |
| **券的核销计数** | `reservedCount` / `usedCount` 与 `couponRedemption` 记录严格同步，条件更新保证幂等；`claimedCount` 是**独立的发放计数**，与核销计数分离 |
| **超时释放与支付回调的并发** | 两侧都用 `status = 'PENDING_PAYMENT'` 的条件更新，数据库保证只有一方能赢（**前提**是回调在订单流转失败时正确处理支付单 —— 那正是 P0-3） |
| **退款消费端的金额核对** | `applyRefundEventInTenant`（`payment.service.ts:1484`）比 `event.amount !== payment.amount` → 不符就拒绝流转。**退款路径的「消费端不复核金额」缺口不存在** |
| **订阅消费端的金额核对** | `applySubscriptionEvent`（`payment.service.ts:1919`）比 `invoice.amount !== event.amount` → 不符就拒绝（护栏 M10）。**订阅路径同样不存在该缺口**（P0-6 只影响「订单支付」一条路径） |
| **补偿扫描的重投路径** | `compensation.service.ts:138` 重投前**重新调 `checkWebhookEvent`**（含金额核对）→ 「事件行已落库但处理失败」这条补偿路径**不漏**（P0-6 的缺口只在「直接投递未经核对的 job」） |
| **`attachProviderTxnId` 的跨订单冲突防护** | 同一 `(provider, providerTxnId)` 落到别的订单会被拒绝（`payment.service.ts:1955`），且绑定放在**业务事务之外** → P2002 冲突不会把订单流转一起回滚 |
