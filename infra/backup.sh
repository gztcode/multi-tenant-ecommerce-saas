#!/usr/bin/env bash
# 数据备份：PostgreSQL 主库（ecommerce）全量 + MinIO 数据卷 + Redis 数据卷，落到 ./backups/<时间戳>/。
# 用法：cd infra && ./backup.sh
# 定时：crontab 里加 `0 3 * * * cd /path/to/电商项目/infra && ./backup.sh >> backup.log 2>&1`
#       ⚠️ cron 的 PATH 常不含 docker（macOS 上尤其如此），示例里前两行要设：
#       PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
# 恢复：postgres 用 `gunzip -c <文件> | docker compose exec -T postgres psql -U ecommerce <db>`；
#       minio 用 `tar xzf <文件> -C <挂载点>`（先停 minio 容器）。
set -euo pipefail
cd "$(dirname "$0")"

BACKUP_DIR="${BACKUP_DIR:-./backups}"
# 备份保留天数（默认 7）。超过的目录在备份成功后清理。
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-7}"
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

# 缺失卷的默认行为：失败退出。cron 场景需要显式选择才跳过。
ALLOW_MISSING_VOLUMES="${ALLOW_MISSING_VOLUMES:-0}"

# 保留天数必须是正整数：0 会让 `-mtime +0` 删掉所有超过 1 天的备份。
if ! [[ "$BACKUP_KEEP_DAYS" =~ ^[1-9][0-9]*$ ]]; then
  echo "[backup] BACKUP_KEEP_DAYS 必须是正整数：$BACKUP_KEEP_DAYS" >&2
  exit 1
fi

# 0) 确保 postgres 已就绪（容器没起时 pg_dump 会直接失败）。
#    ⚠️ cron 场景下这一步也会把 postgres 拉起——这是有意的：
#    备份前先保证数据源可用，失败早于写文件。
docker compose up -d --wait postgres

# 1) PostgreSQL 逻辑备份（pg_dump 版本与容器一致，直接用服务内执行）
echo "[backup] postgres: $PG_DB"
docker compose exec -T postgres pg_dump -U "$PG_USER" --clean --if-exists "$PG_DB" \
  | gzip > "$DEST/postgres-$PG_DB.sql.gz"
# ⚠️ 备份后立即校验 gzip 完整性：损坏的备份比没有备份更危险。
#    校验失败立即删掉损坏文件并非零退出，避免被当成「有一份备份」。
if ! gunzip -t "$DEST/postgres-$PG_DB.sql.gz"; then
  echo "[backup] postgres 备份校验失败，删除损坏文件：$DEST/postgres-$PG_DB.sql.gz" >&2
  rm -f "$DEST/postgres-$PG_DB.sql.gz"
  exit 1
fi
echo "[backup] postgres 备份校验通过"

# 2) MinIO 数据卷热备（尽力而为：容器运行中 tar，可能有写入中的不一致，本机开发够用；
#    compose 项目名来自中文目录名，卷名动态查，不硬编码）。
# ⚠️ 先取卷清单：docker daemon 不可达时这一步直接失败退出，
#    不能靠管道尾的 || true 把「查不到卷」和「docker 挂了」混为一谈。
VOLUMES="$(docker volume ls --format '{{.Name}}')"
# 管道尾 || true：grep 无匹配退出码 1 会被 pipefail 当整条失败，
# 这里只放行「确实没有该卷」，不放行 docker 本身的失败（上面已先执行）。
MINIO_VOL="$(printf '%s\n' "$VOLUMES" | grep -E 'minio-data$' | head -n1 || true)"
if [ -z "$MINIO_VOL" ]; then
  echo "[backup] 找不到 minio-data 卷" >&2
  if [ "$ALLOW_MISSING_VOLUMES" != "1" ]; then
    exit 1
  fi
  echo "[backup] ALLOW_MISSING_VOLUMES=1，跳过 MinIO 备份" >&2
else
  echo "[backup] minio volume: $MINIO_VOL"
  docker run --rm \
    -v "$MINIO_VOL":/data:ro \
    -v "$(cd "$DEST" && pwd)":/backup \
    alpine tar czf "/backup/minio-data.tgz" -C /data .
  if ! tar tzf "$DEST/minio-data.tgz" >/dev/null; then
    echo "[backup] MinIO 备份校验失败，删除损坏文件" >&2
    rm -f "$DEST/minio-data.tgz"
    exit 1
  fi
  echo "[backup] MinIO 备份校验通过"
fi

# 3) Redis 数据卷热备（AOF 可能有写入中的不一致，本机开发够用）
REDIS_VOL="$(printf '%s\n' "$VOLUMES" | grep -E 'redis-data$' | head -n1 || true)"
if [ -z "$REDIS_VOL" ]; then
  echo "[backup] 找不到 redis-data 卷" >&2
  if [ "$ALLOW_MISSING_VOLUMES" != "1" ]; then
    exit 1
  fi
  echo "[backup] ALLOW_MISSING_VOLUMES=1，跳过 Redis 备份" >&2
else
  echo "[backup] redis volume: $REDIS_VOL"
  docker run --rm \
    -v "$REDIS_VOL":/data:ro \
    -v "$(cd "$DEST" && pwd)":/backup \
    alpine tar czf "/backup/redis-data.tgz" -C /data .
  if ! tar tzf "$DEST/redis-data.tgz" >/dev/null; then
    echo "[backup] Redis 备份校验失败，删除损坏文件" >&2
    rm -f "$DEST/redis-data.tgz"
    exit 1
  fi
  echo "[backup] Redis 备份校验通过"
fi

# 4) 保留策略：删除超过 N 天的备份目录（当前这次刚创建，不会被删）
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d \
  -mtime +"$BACKUP_KEEP_DAYS" -exec rm -rf {} +

echo "[backup] 完成 → $DEST"
ls -lh "$DEST"
