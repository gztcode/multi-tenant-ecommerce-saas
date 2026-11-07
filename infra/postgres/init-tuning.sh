#!/bin/bash
# 数据库运行时调优（阶段 11：部署加固）——在 docker-entrypoint-initdb.d
# 阶段（超级用户、建库刚完成）对**当前初始化的数据库**生效。
#
# ## statement_timeout：为什么必须有
#
# 多租户共享一个库，恶意/失控租户的一条慢查询就能长期占用连接池
# （默认池只有 5 条连接，阶段 10 刚把「事务内借第二条连接」清干净），
# 拖垮全平台。8 秒是保护性默认值：正常业务查询（含分页报表）远快于它，
# 真正需要长跑的只有迁移与后台批处理——它们走脚本，可以显式
# `SET statement_timeout = 0` 或由 DBA 会话调整。
#
# ## 生效范围（重要）
#
# - 只对**本次初始化的数据库**（$POSTGRES_DB，即开发库 ecommerce）生效；
# - e2e 的测试库 ecommerce_test 是之后由测试基建创建的，**不带超时**——
#   测试里的慢查询（锁竞争重试等）不应被生产阈值打断；
# - docker-entrypoint-initdb.d 只在**数据卷首次创建**时执行。
#   已存在的数据库用 DEPLOY.md §数据库加固里的 ALTER DATABASE 手动补。
#
# STATEMENT_TIMEOUT_MS 置 0 可禁用（不设置超时）。

set -euo pipefail

TIMEOUT_MS="${STATEMENT_TIMEOUT_MS:-8000}"

if [ "$TIMEOUT_MS" = "0" ]; then
  echo "[init-tuning] STATEMENT_TIMEOUT_MS=0，跳过 statement_timeout 设置"
  exit 0
fi

echo "[init-tuning] 为数据库设置 statement_timeout = ${TIMEOUT_MS}ms"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
ALTER DATABASE "$POSTGRES_DB" SET statement_timeout = '${TIMEOUT_MS}ms';
SQL
