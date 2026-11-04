#!/usr/bin/env bash
# 数据备份：PostgreSQL 主库（ecommerce）全量 + MinIO 数据卷，落到 ./backups/<时间戳>/。
# 用法：cd infra && ./backup.sh
# 定时：crontab 里加 `0 3 * * * cd /path/to/电商项目/infra && ./backup.sh >> backup.log 2>&1`
#       ⚠️ cron 的 PATH 常不含 docker（macOS 上尤其如此），示例里前两行要设：
#       PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
# 恢复：postgres 用 `gunzip -c <文件> | docker compose exec -T postgres psql -U ecommerce <db>`；
#       minio 用 `tar xzf <文件> -C <挂载点>`（先停 minio 容器）。
set -euo pipefail
cd "$(dirname "$0")"

BACKUP_DIR="${BACKUP_DIR:-./backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$BACKUP_DIR/$STAMP"
mkdir -p "$DEST"

# 读 .env（存在才读），与 compose 的默认值保持一致
if [ -f .env ]; then
  # shellcheck disable=SC1091
  set -a; source .env; set +a
fi
PG_USER="${POSTGRES_USER:-ecommerce}"
PG_DB="${POSTGRES_DB:-ecommerce}"

# 1) PostgreSQL 逻辑备份（pg_dump 版本与容器一致，直接用服务内执行）
echo "[backup] postgres: $PG_DB"
docker compose exec -T postgres pg_dump -U "$PG_USER" "$PG_DB" \
  | gzip > "$DEST/postgres-$PG_DB.sql.gz"

# 2) MinIO 数据卷热备（尽力而为：容器运行中 tar，可能有写入中的不一致，本机开发够用；
#    compose 项目名来自中文目录名，卷名动态查，不硬编码）。
#    管道尾 || true：grep 无匹配退出码 1 会被 pipefail 当整条失败，在走到下面的
#    友好提示之前就把脚本杀掉，postgres 备份已做完却静默跳过 MinIO——不想这样。
MINIO_VOL="$(docker volume ls --format '{{.Name}}' | grep -E 'minio-data$' | head -n1 || true)"
if [ -z "$MINIO_VOL" ]; then
  echo "[backup] 找不到 minio-data 卷，跳过 MinIO 备份" >&2
else
  echo "[backup] minio volume: $MINIO_VOL"
  docker run --rm \
    -v "$MINIO_VOL":/data:ro \
    -v "$(cd "$DEST" && pwd)":/backup \
    alpine tar czf "/backup/minio-data.tgz" -C /data .
fi

echo "[backup] 完成 → $DEST"
ls -lh "$DEST"
