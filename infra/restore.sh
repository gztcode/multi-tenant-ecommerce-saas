#!/usr/bin/env bash
# 从 ./backups/<时间戳>/ 恢复数据。
# 用法：
#   ./restore.sh postgres ./backups/<时间戳>/postgres-ecommerce.sql.gz --yes
#   ./restore.sh minio    ./backups/<时间戳>/minio-data.tgz --yes
#   ./restore.sh redis    ./backups/<时间戳>/redis-data.tgz --yes
# 不带 --yes 只打印计划，不动任何数据。
set -euo pipefail
cd "$(dirname "$0")"

if [ -f .env ]; then
  # shellcheck disable=SC1091
  set -a; source .env; set +a
fi

PG_USER="${POSTGRES_USER:-ecommerce}"
PG_DB="${POSTGRES_DB:-ecommerce}"

usage() {
  echo "用法：$0 <postgres|minio|redis> <备份文件> [--yes]" >&2
  exit 2
}

[ $# -ge 2 ] || usage
TARGET="$1"
FILE="$2"
CONFIRM=0
if [ "${3:-}" = "--yes" ]; then
  CONFIRM=1
elif [ $# -ge 3 ]; then
  usage
fi

[ -f "$FILE" ] || { echo "[restore] 备份文件不存在：$FILE" >&2; exit 1; }
ABS_FILE="$(cd "$(dirname "$FILE")" && pwd)/$(basename "$FILE")"

find_volume() {
  docker volume ls --format '{{.Name}}' | grep -E "$1\$" | head -n1 || true
}

case "$TARGET" in
  postgres)
    echo "[restore] 计划：停止 api → 用 $ABS_FILE 覆盖数据库 $PG_DB → 启动 api"
    [ "$CONFIRM" = "1" ] || exit 0
    docker compose stop api
    # ⚠️ `ON_ERROR_STOP=1`：SQL 中途报错必须让脚本非零退出，
    #    不能「恢复了一半却显示完成」。
    gunzip -c "$ABS_FILE" | docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DB"
    docker compose start api
    ;;
  minio|redis)
    VOL="$(find_volume "$TARGET-data")"
    if [ -z "$VOL" ]; then
      echo "[restore] 找不到 $TARGET-data 卷" >&2
      exit 1
    fi
    echo "[restore] 计划：停止 $TARGET → 清空卷 $VOL → 解包 $ABS_FILE → 启动 $TARGET"
    [ "$CONFIRM" = "1" ] || exit 0
    docker compose stop "$TARGET"
    docker run --rm \
      -v "$VOL":/data \
      -v "$(dirname "$ABS_FILE")":/backup:ro \
      alpine sh -c "find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} + && tar xzf /backup/$(basename "$ABS_FILE") -C /data"
    docker compose start "$TARGET"
    ;;
  *)
    usage
    ;;
esac

echo "[restore] 完成：$TARGET"
