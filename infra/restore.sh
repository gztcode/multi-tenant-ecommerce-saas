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

# ⚠️ 卷名必须从容器反向查实际挂载，不能 grep 卷列表再取第一个：
#    机器上若有其他项目残留的同名卷（如本机 `ecommerce_minio-data` 与
#    `infra_minio-data` 并存），`grep '<name>-data$' | head -n1` 按字母序会取到
#    没被挂载的残留卷 → 恢复打到错误（且可能为空）的卷。
#    从容器 `<container>` 反向查 `.Name`，取到的一定是这个 compose 项目实际挂载的卷
#    （container_name 在 compose 里显式声明，可依赖）。
find_volume() {
  docker inspect "$1" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' 2>/dev/null
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
    # 容器名：compose 里显式声明的 container_name（ecommerce-minio / ecommerce-redis）。
    VOL="$(find_volume "ecommerce-$TARGET")"
    if [ -z "$VOL" ]; then
      echo "[restore] 找不到 $TARGET-data 卷" >&2
      exit 1
    fi
    # ⚠️ `${VOL}` 必须带大括号：bash 3.2（macOS 自带）在 `set -u` 下，变量名后
    #    紧贴全角字符会把首字节吞进变量名（`$VOL（` → 查 `VOL�`）→ 误报 unbound。
    echo "[restore] 计划：停止 $TARGET → 预检并解包 $ABS_FILE 到卷 ${VOL}（失败不清空）→ 启动 $TARGET"
    [ "$CONFIRM" = "1" ] || exit 0
    docker compose stop "$TARGET"
    # ⚠️ 解包必须有「预检 + 原子替换」语义（与 backup.sh 的 tar tzf 校验对称）：
    #    旧实现先 rm -rf 清空卷再 tar xzf，备份损坏时卷已清空、数据只恢复一半，
    #    旧数据也没了（双失）。现在先 tar tzf 预检，再解包到卷内临时目录
    #    （同一文件系统），全部成功才清空替换；解包失败旧数据原封不动。
    #    残留的 .restore-tmp-*（替换前中断）会被下一次恢复当旧内容清掉，自愈。
    docker run --rm \
      -v "$VOL":/data \
      -v "$(dirname "$ABS_FILE")":/backup:ro \
      alpine sh -c 'set -e
        F="/backup/'"$(basename "$ABS_FILE")"'"
        # ① 预检：损坏的备份在清空卷之前就失败退出
        tar tzf "$F" >/dev/null
        # ② 解包到卷内临时目录（同一文件系统），失败则旧数据原封不动
        TMP="$(mktemp -d /data/.restore-tmp-XXXXXX)"
        tar xzf "$F" -C "$TMP"
        # ③ 替换：清掉旧内容（保留临时目录），再把新内容移回卷根（同卷 mv 原子）
        find /data -mindepth 1 -maxdepth 1 ! -path "$TMP" -exec rm -rf {} +
        find "$TMP" -mindepth 1 -maxdepth 1 -exec mv {} /data/ \;
        rmdir "$TMP"'
    docker compose start "$TARGET"
    ;;
  *)
    usage
    ;;
esac

echo "[restore] 完成：$TARGET"
