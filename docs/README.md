# 文档索引

本目录存放项目文档。根 [`README.md`](../README.md) 只保留简介、技术栈、目录结构与
最小快速开始，细节按主题拆到下面各篇。

## 主题文档

| 文档 | 内容 | 适合谁 |
|------|------|--------|
| [架构设计](architecture.md) | 系统组成、请求链路、多租户隔离、订单状态机与库存流水、模块依赖与渠道抽象 | 新人、改核心逻辑前 |
| [开发指南](development.md) | 本地环境搭建、本机端口、示例账号、测试命令、npm workspaces、假网关、渠道配置、代码规范与推送 | 日常开发 |
| [数据库](database.md) | 数据模型约定、迁移流程、测试库、`pg_trgm`、备份与恢复 | 改 schema、上线前 |
| [部署指南](deployment.md) | compose 全栈容器、生产部署（TLS、密钥、升级、回滚）、Nginx 与运维脚本 | 部署与运维 |
| [需求与规划](requirements/README.md) | 需求模板、当前待办、历史阶段的设计/计划/验收归档 | 了解来龙去脉 |

## 各子项目 README

| 文档 | 内容 |
|------|------|
| [`AGENTS.md`](../AGENTS.md) | 面向 AI 助手与新人：目录布局、命令、不可违反的约定、踩坑记录（**动手前必读**） |
| [`api/README.md`](../api/README.md) | 后端模块目录、租户隔离、订单状态机、渠道契约速查 |
| [`storefront/README.md`](../storefront/README.md) | 消费者前台：路由、同源中转、主题、测试 |
| [`merchant-admin/README.md`](../merchant-admin/README.md) | 商家后台：路由、中转路由白名单、组件测试 |
| [`platform-admin/README.md`](../platform-admin/README.md) | 平台超管后台：路由、运营页、测试 |
| [`packages/frontend-shared/README.md`](../packages/frontend-shared/README.md) | 三端共享包：目录、导出约定、与薄壳的关系 |
| [`api/src/common/payment/README.md`](../api/src/common/payment/README.md) | 支付/出款渠道契约与注册表、新渠道准入 |

## 文档约定

- 新增主题文档放本目录，文件名用小写英文短横线（`development.md`）。
- 需求、设计、计划、验收记录一律放 [`requirements/`](requirements/README.md)，
  模板见 [`requirements/TEMPLATE.md`](requirements/TEMPLATE.md)。
- 文档之间的引用用**相对路径**，改动目录时同步修链接。
- 文案统一简体中文；代码、命令、路径、标识符保留英文原文。
