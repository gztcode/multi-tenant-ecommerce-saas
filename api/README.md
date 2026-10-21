# api — 多租户电商 SaaS 后端

NestJS 11 + Prisma 6 + PostgreSQL 16。

## 本地运行

```bash
# 依赖与配置
npm install && cp .env.example .env

# 数据库迁移与种子（计划 3 起可用）
npm run prisma:deploy && npm run prisma:seed

# 开发模式
npm run start:dev
```

服务默认监听 `http://localhost:3000`，API 前缀 `/api/v1`（Task 5 起生效），
接口文档 `http://localhost:3000/api/docs`（Task 9 起生效）。

## 测试

```bash
npm test              # 单元测试
npm run test:e2e      # 端到端测试
npm run test:cov      # 覆盖率
npm run lint          # 静态检查
```

数据库连接：`postgresql://ecommerce:ecommerce@localhost:15432/ecommerce`
（宿主机端口 15432，容器内 5432；本机端口分配见仓库根 README。）

根目录 `README.md` 与 `docs/superpowers/plans/` 有完整说明。