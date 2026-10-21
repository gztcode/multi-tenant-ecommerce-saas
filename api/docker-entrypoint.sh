#!/bin/sh
set -e

# 数据卷为空时数据库里没有表，服务会因 relation does not exist 反复重启。
# migrate deploy 是幂等的：schema 已是最新时它不做任何事。
echo "正在执行数据库迁移…"
npx prisma migrate deploy

exec "$@"