# 阶段 1 验收记录

验收日期：2026-10-21
验收范围：计划 1「平台地基与身份体系」（`2026-10-21-plan-01-foundation-identity.md` 的 Task 1–13）
结论：**通过**

---

## 一、自动化测试

| 项目 | 命令 | 通过标准 | 实测 |
|------|------|---------|------|
| 后端单元测试 | `cd api && npm test` | 全部通过 | **79 passed / 79 total** |
| 后端 e2e | `cd api && npm run test:e2e` | 全部通过 | **81 passed / 81 total**（7 个套件） |
| 后端覆盖率（e2e 口径） | `cd api && npm run test:cov:e2e` | statements ≥ 60% | **63.9%** ✅ |
| 后端覆盖率（单测口径） | `cd api && npm run test:cov` | — | 26.17%（只统计单元测试触及的隔离模块，非项目真实覆盖率） |
| 后端类型检查 | `cd api && npx tsc --noEmit` | 无错误 | 通过 |
| 后端 lint | `cd api && npm run lint` | 0 error | 0 error / 0 warning |
| storefront 类型/lint/构建 | `cd storefront && npx tsc --noEmit && npm run lint && npm run build` | 无错误 | 全部通过 |
| merchant-admin 类型/lint/构建 | 同上 | 无错误 | 全部通过 |
| platform-admin 类型/lint/构建 | 同上 | 无错误 | 全部通过 |

> **覆盖率两个口径的说明**：`npm test` 的 jest `rootDir` 是 `src`，只跑单元测试，因此只统计到隔离机制那一个模块（26%）。业务逻辑主要由 e2e 覆盖，`npm run test:cov:e2e` 才是项目真实覆盖率（**63.9%**，超过 60% 的验收线）。

---

## 二、容器化编排

| 场景 | 预期 | 实测 |
|------|------|------|
| `docker compose build` | 四个镜像构建成功 | ✅ api / storefront / merchant-admin / platform-admin 全部成功 |
| `docker compose up -d` | 六个服务起来 | ✅ postgres(healthy) / api(healthy) / storefront / merchant-admin / platform-admin / nginx |
| 经 nginx 访问后端健康检查 | 200 | `curl http://localhost/api/v1/health` → `{"status":"ok",...}` ✅ |
| 经 nginx 访问店铺前台 | 200（店铺不存在时降级提示，不 500） | `Host: demo.platform.test` → HTTP 200 ✅ |
| 经 nginx 访问两个后台的登录页 | 200 | merchant / platform 登录页均 HTTP 200 ✅ |
| 网关注入子域名头生效 | 店铺页显示正确的店铺名 | 经 nginx 注册商家 `acme` 后访问 `acme.platform.test` → 页面显示「Acme 测试店铺」✅ |
| 全新数据卷启动 | 自动跑迁移 | `docker-entrypoint.sh` 执行 `prisma migrate deploy`，全新库上输出「All migrations have been successfully applied」✅ |

---

## 三、手动验收场景

| # | 场景 | 通过标准 | 实测 |
|---|------|---------|------|
| 1 | 商家注册开店 | 201，返回令牌与租户 | ✅ `MERCHANT_OWNER` / `tenantId` 非空 |
| 2 | 子域名重复注册 | 409 | ✅ |
| 3 | 商家登录 | 200，返回 accessToken 与 refreshToken | ✅ |
| 4 | 密码错误登录 | 401，文案与「邮箱不存在」完全一致 | ✅ 无时序可区分（补了 dummy argon2 校验） |
| 5 | 刷新令牌轮换 | 新旧令牌不同，旧令牌再刷新 401 | ✅ |
| 6 | 登出后刷新令牌失效 | 401 | ✅ |
| 7 | 登出需带 access token | 不带 → 401；带别人的 token 登出别人的令牌 → 401 | ✅ |
| 8 | 并发刷新同一枚令牌 | 一次 200 一次 401，**不牵连其它设备** | ✅ |
| 9 | 重放已轮换的令牌 | 401，该用户全部令牌族作废 | ✅ |
| 10 | 商家 A 查不到商家 B 的店铺 | 隔离生效 | ✅ A 看到 1 个、B 看到 0 个 |
| 11 | 商家 A 改设置不影响 B | 隔离生效 | ✅ B 的店铺未被篡改 |
| 12 | 商家访问平台超管接口 | 403 | ✅ |
| 13 | 平台超管查商家列表 | 200，含刚注册的商家 | ✅ |
| 14 | 商家被停用后 token 立即失效 | 401 | ✅（停用是租户级的，不吊销会话的缺口已修） |
| 15 | 消费者注册（带子域名） | 201，`role = CUSTOMER` | ✅ |
| 16 | 消费者注册（不带子域名） | 404 | ✅ |
| 17 | 跨租户同邮箱消费者登录 | 按店铺子域名落到对应租户 | ✅ 不带子域名时回退到最早创建的 |
| 18 | 店铺前台登录 → 概览 | 显示店铺名 | ✅（真实浏览器 CSRF 链路） |
| 19 | 商家后台改店铺设置 | 提示「已保存」，数据库确实更新 | ✅（真实浏览器点击 + 数据库核对） |
| 20 | 平台后台改商家状态 | 刷新后状态已变 | ✅（真实浏览器点击 + 数据库核对） |
| 21 | 统一错误响应格式 | `{ code, message, traceId }` | ✅ 400/401/403/404/409/租户越权/500 七类全覆盖，X-Trace-Id 透传 |
| 22 | OpenAPI 文档 | 路径带全局前缀，DTO schema 完整 | ✅ `/api/docs` 200，`paths` 为 `/api/v1/...`，6 个 DTO schema 属性齐全，无绝对路径残留 |
| 23 | 伪造 / 过期 / alg:none 的 JWT | 一律 401 | ✅ 三种篡改方式全被拒 |
| 24 | 平台超管邮箱唯一 | 重复插入被数据库拒绝 | ✅ 部分唯一索引 `users_platform_admin_email_key` 生效 |
| 25 | 同租户同邮箱（大小写变体） | 被拒绝 | ✅ `users_email_ci_key` 生效 |
| 26 | 跨租户同邮箱 | 允许 | ✅ |

---

## 四、机制级验证（恒真自检）

每个关键护栏都做过**失效注入**——把保护逻辑临时改坏，确认对应的测试**真的会失败**。这一项是本次验收的重点：没有它，"测试全绿"可能只是断言写错了。

| 护栏 | 注入方式 | 结果 |
|------|---------|------|
| 租户隔离（读） | 去掉 `where.tenantId` | 测试失败 ✅（且进一步确认真实越权需绕开扩展，扩展是唯一防线） |
| 租户隔离（写） | `upsert` / `createManyAndReturn` / `updateManyAndReturn` 不拦截 | 4 条测试失败 ✅ |
| 角色守卫 | 角色比对改成恒真 | 「商家访问平台专属端点返回 403」失败 ✅ |
| 停用会话 | 去掉租户状态检查 | 2 条测试失败 ✅ |
| 刷新并发 | 去掉条件更新 | 并发用例失败 ✅ |
| 嵌套写误报 | 判定放宽 | 主题 token 用例失败 ✅ |

---

## 五、阶段 1 交付物清单

| 交付物 | 位置 |
|--------|------|
| 后端 API | `api/`（NestJS 11 + Prisma 6 + PostgreSQL） |
| 消费者店铺前台 | `storefront/`（Next.js 15 + NextAuth v5） |
| 商家后台 | `merchant-admin/` |
| 平台超管后台 | `platform-admin/` |
| 容器编排 | `infra/docker-compose.yml`（6 服务）+ `infra/nginx/platform.test.conf` |
| 数据模型 | `api/prisma/schema.prisma` + 6 条迁移 |
| 隔离机制 | `api/src/common/tenant/`（AsyncLocalStorage + Prisma query extension） |
| 接口文档 | `http://localhost:3000/api/docs` |
| 设计文档 | `docs/superpowers/specs/2026-10-21-multi-tenant-ecommerce-saas-design.md` |
| 实施计划 | `docs/superpowers/plans/2026-10-21-plan-01-foundation-identity.md` |

---

## 六、已知遗留项（不阻塞阶段 1，但需排期）

| # | 事项 | 影响 | 建议 |
|---|------|------|------|
| 1 | 后端未开 CORS | 前端**不能**在客户端组件里直连后端 API，写操作必须走各自的同源中转路由 | 保持同源架构（已如此实现）；若将来要前端普遍直连，需在 `main.ts` 加 CORS 白名单并单独立项 |
| 2 | `@nestjs/swagger` CLI 插件的上游缺陷 | 插件遇到本地枚举会生成 `require("<绝对路径>")`，导致服务无法启动 | 已停用插件的文件扫描，schema 改由显式 `@ApiProperty` 提供。**新增 DTO 字段必须显式写 `@ApiProperty`**，否则文档静默缺字段 |
| 3 | lockfile 与 npm 版本隐式耦合 | 容器里 npm 10 装不上本仓库 npm 11 生成的 lockfile | 容器镜像已升到 npm 11；根治办法是统一 lockfile 版本 |
| 4 | `JWT_SECRET` / `AUTH_SECRET` 在 compose 里是明文固定值 | 仅适用于本机开发 | 真实部署必须改用外部 secret 注入 |
| 5 | 停用商家会让每条请求多一次租户状态查询 | 认证路径的开销 | 阶段 1 接受；后续可加短 TTL 缓存或令牌版本号 |
| 6 | 刷新令牌重放的两种来源（触发者 / 被连带作废）共用 `REPLAY` 标记 | 审计时无法区分 | 后续加一列区分 |
| 7 | 后端 `POST /tenants/:id/status` 无删除租户的端点 | —— | 有意为之：租户停用走 `SUSPENDED`，物理删除仅用于注册回滚 |

---

## 七、下一阶段

计划 2（商品中心与店铺前台浏览）、计划 3（交易链路）、计划 4（营销、平台计费与平台超管）尚未编写。动笔前应先对照阶段 1 已实现的接口与命名，避免返工。
