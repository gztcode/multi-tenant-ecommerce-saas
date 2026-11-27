# 需求与规划

本目录集中存放项目的需求、设计、实施计划与验收记录。以前这些内容散落在根
`README.md` 和各阶段文档里，从本次整理起统一收口到这里。

> 截至 2026-11-27 梳理：下面第三节的状态表是**状态口径的唯一来源**，
> 根 README 只保留一行当前阶段。全仓只有这一处梳理时间戳。

## 一、需求来源

| 来源 | 说明 | 落到哪里 |
|------|------|---------|
| 业主提出的功能需求 | 直接给出目标或问题描述 | 按 [`TEMPLATE.md`](TEMPLATE.md) 建独立文件 |
| 前一阶段验收留下的遗留项 | 验收记录里「遗留问题」「下一阶段优先项」两节 | 汇总进 [`backlog.md`](backlog.md)，排期后建独立文件 |
| 线上/联调暴露的缺陷 | 手工验收、失败注入、CI 反复失败 | 同上 |
| 技术债盘点 | 阶段性的技术债清单与全仓审计 | 归档在 [`archive/plans/`](archive/plans/)，未解决项进 backlog |

## 二、推进与命名约定

**推进顺序固定**：需求 → 设计（design）→ 实施计划（plan，勾选式 Task）→ 代码 → 验收记录
（acceptance）→ 更新本文档的状态表。每个 plan 开头的 §0「全局约定 / 动手前必须知道」
优先于直觉，里面有失败注入、定向 lint、迁移手写等纪律。

| 文档类型 | 命名 | 放哪里 |
|---------|------|--------|
| 需求 | `YYYY-MM-DD-<主题>.md` | 本目录（讨论中/已排期/进行中） |
| 已完成的需求 | 同上 | `archive/requirements/`（按需创建，目前尚无实例） |
| 设计 | `YYYY-MM-DD-plan-<阶段号>-<主题>-design.md` | `archive/specs/`（完成后归档） |
| 计划 | `YYYY-MM-DD-plan-<阶段号>-<主题>.md` | `archive/plans/` |
| 验收 | `YYYY-MM-DD-plan-<阶段号>-acceptance.md` | `archive/plans/` |

已完成或已过期的一律移入 [`archive/`](archive/)，**不删除**；归档内容不再维护，
只作为决策依据。当前还在讨论、尚未实现的需求留在本目录，不要提前归档。
需求完成后移到 `archive/requirements/`（该目录按需创建，目前尚无实例；
首个使用者须同时补 [`archive/README.md`](archive/README.md) 的索引）。

## 三、当前状态

| 阶段 | 主题 | 状态 |
|------|------|------|
| 1 ~ 10 | 地基与身份 → 商品中心 → 交易链路 → 前端打磨 → 营销与资金链路（5a~5m）→ 渠道适配层 → 工程加固 → 资金与并发 → 技术债清理 → 事务边界收口 | ✅ 已完成并验收通过 |
| 11 | 可观测性与生产部署加固（pino 日志、Prometheus 指标、告警 webhook、生产 TLS 与 compose override、RedisLockService） | ✅ 已完成并验收通过（[验收记录](archive/plans/2026-11-07-plan-11-observability-deploy-acceptance.md)） |
| 11b | npm workspaces 化（根唯一 lockfile，5 个子包共用 `@ecom/frontend-shared`） | ✅ 已完成（PR #30，merge `6b1eddf`，[CI run](https://github.com/gztcode/multi-tenant-ecommerce-saas/actions/runs/42450549593)）；有实现、无设计/计划/验收归档 |
| 11c | 浏览器级 e2e（Playwright golden path） | ✅ 已完成（PR #31，merge `88583bb`，[CI run](https://github.com/gztcode/multi-tenant-ecommerce-saas/actions/runs/42452795536)）；有实现、无设计/计划/验收归档 |
| 11d | 退货入库流程 | ✅ 已完成（PR #32，merge `9e287b3`，[CI run](https://github.com/gztcode/multi-tenant-ecommerce-saas/actions/runs/42488083335)）；有实现、无设计/计划/验收归档 |
| 下一阶段 | **阶段 11 之后的剩余技术债**：0 项待办、6 项已放弃（留档）、6 项已裁决（留档）、1 项等业主裁决 —— 见 [`backlog.md`](backlog.md) 第二节 | ⏳ 未排期 |

阶段 11 与 11b/11c/11d 交付内容的详细叙述见[阶段进度记录](archive/stage-history.md)；
11b/11c/11d 没有各自的归档文档，实现证据见 [`archive/README.md`](archive/README.md) 的阶段索引。

## 四、索引

| 文档 | 内容 |
|------|------|
| [`backlog.md`](backlog.md) | 待办与技术债：按当前代码与 PR 校准过的条目（状态 / 完成证据 / 估算 / 阻塞原因） |
| [`TEMPLATE.md`](TEMPLATE.md) | 需求模板：背景、目标、验收标准、涉及模块、风险取舍、关联文档 |
| [`archive/README.md`](archive/README.md) | 阶段 1 ~ 11 与 11b/11c/11d 的设计 / 计划 / 验收索引（历史，已过期但保留；11b~11d 只有实现证据） |
| [`archive/stage-history.md`](archive/stage-history.md) | 原 README 顶部的阶段进度叙述 |

## 五、写文档的几条实用约定

- **验收标准要能跑**：写清命令、接口路径、页面路径、断言，不要写「体验良好」。
- **计划里写清失败注入点**：故意改坏哪一行、期望哪条测试变红——这是回归护栏的来源。
- **取舍写进设计**：明确列出「本阶段不做」的事及理由，否则下次会被当成遗漏。
- **过时不要删**：移入 `archive/` 并在索引里标注「历史/已过期」。
