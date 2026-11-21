#!/bin/sh
# 把 RATE_LIMIT_* 阈值展开成 nginx 的 limit_req_zone / limit_req 语句。
#
# ## 为什么需要这个脚本
#
# 官方 nginx 镜像的 entrypoint 先用 envsubst 把 /etc/nginx/templates/*.template
# 渲染到 /etc/nginx/conf.d/，再按文件名顺序执行 /docker-entrypoint.d/*.sh。
# 本脚本挂成 26-rate-limit.sh，在 20-envsubst-on-templates.sh 之后跑，
# 替换模板里预留的占位行。
#
# 为什么不能直接用模板变量（${RATE_LIMIT_FRONT_RATE}）：
#   1. envsubst 不是 shell，不支持 ${VAR:-默认值} —— 变量没配就渲染成空，
#      `rate=r/s` 是语法错误 → nginx 起不来 = 整站不可用；
#   2. envsubst 不校验值 —— 配置里写错一个字符（`20r/s`、`-5`、`abc`）同样
#      渲染出坏配置。阈值是**运维手填**的，必须挡在渲染期。
#
# ## 失败方向（重要）
#
# 阈值缺失 / 非法 → 回落到本脚本内置的**保守默认值**，并在 stderr 点名是哪个
# 变量。绝不渲染出坏配置：渲染失败时配置文件保持原样，nginx 仍能启动。
#
# 脚本整个没跑（没挂载 / 没有执行位）→ 占位行保持注释 → **限流不生效但服务
# 正常**。这是有意的取舍：限流失效是可观测的降级（日志 + 渲染测试会红），
# 而配置写坏是整站不可用。可证伪性由 prod-conf.render.test.mjs 保证 ——
# 那里断言占位行必须被展开成 limit_req。
#
# ## 默认值从哪来
#
# 全部是**保守占位**，上线前必须按真实访问日志校准（docs/DEPLOY.md §9）：
#   - front：三个前端的 location /（浏览器真实流量入口）
#   - api  ：直连 api 的 /api/v1（脚本、第三方集成）
#   - auth ：api 的 /api/v1/auth/（认证端点从紧）
#
# 用法：render-rate-limit.sh [配置文件路径]
#   默认 /etc/nginx/conf.d/prod.conf（模板 prod.conf.template 的渲染产物）。

CONF="${1:-/etc/nginx/conf.d/prod.conf}"

log() {
    echo "render-rate-limit: $*" >&2
}

if [ ! -f "$CONF" ]; then
    echo "render-rate-limit: 找不到 $CONF，跳过（限流不生效，nginx 照常启动）"
    exit 0
fi

# ---- 阈值校验 ----
#
# 只接受纯数字，且限长 6 位（≤999999）：
#   - 阈值会**原样拼进 nginx 配置**，放行任意字符等于配置注入；
#   - 超长数字在 `test` 的整数比较里可能溢出报错，索性当非法处理。
# rate 必须 ≥1（0r/s 是 nginx 语法错误），burst 允许 0（= 不留突发余量）。
pick() {
    name=$1
    raw=$2
    fallback=$3
    min=$4

    if [ -z "$raw" ]; then
        log "$name 未设置，使用默认值 $fallback"
        VALUE=$fallback
        return
    fi

    case "$raw" in
        *[!0-9]*)
            log "$name=\"$raw\" 非法（只接受非负整数），回落到默认值 $fallback"
            VALUE=$fallback
            return
            ;;
    esac

    # 去掉前导 0，避免 "020" 这类写法带来的歧义
    trimmed=$(printf '%s' "$raw" | sed 's/^0*//')
    [ -z "$trimmed" ] && trimmed=0

    if [ "${#trimmed}" -gt 6 ]; then
        log "$name=$raw 超出允许范围（最多 6 位数字），回落到默认值 $fallback"
        VALUE=$fallback
        return
    fi
    if [ "$trimmed" -lt "$min" ]; then
        log "$name=$raw 小于下限 $min，回落到默认值 $fallback"
        VALUE=$fallback
        return
    fi

    VALUE=$trimmed
}

pick RATE_LIMIT_FRONT_RATE "${RATE_LIMIT_FRONT_RATE:-}" 20 1
FRONT_RATE=$VALUE
pick RATE_LIMIT_FRONT_BURST "${RATE_LIMIT_FRONT_BURST:-}" 100 0
FRONT_BURST=$VALUE
pick RATE_LIMIT_API_RATE "${RATE_LIMIT_API_RATE:-}" 20 1
API_RATE=$VALUE
pick RATE_LIMIT_API_BURST "${RATE_LIMIT_API_BURST:-}" 40 0
API_BURST=$VALUE
pick RATE_LIMIT_AUTH_RATE "${RATE_LIMIT_AUTH_RATE:-}" 10 1
AUTH_RATE=$VALUE
pick RATE_LIMIT_AUTH_BURST "${RATE_LIMIT_AUTH_BURST:-}" 20 0
AUTH_BURST=$VALUE

ZONES_FILE=$(mktemp) || exit 1
FRONT_FILE=$(mktemp) || { rm -f "$ZONES_FILE"; exit 1; }
API_FILE=$(mktemp) || { rm -f "$ZONES_FILE" "$FRONT_FILE"; exit 1; }
AUTH_FILE=$(mktemp) || { rm -f "$ZONES_FILE" "$FRONT_FILE" "$API_FILE"; exit 1; }

# limit_req_zone 在 http 上下文（列 0）；limit_req 在 location 内（缩进 8 空格）。
cat > "$ZONES_FILE" <<EOF
limit_req_zone \$binary_remote_addr zone=front_general:10m rate=${FRONT_RATE}r/s;
limit_req_zone \$binary_remote_addr zone=api_general:10m rate=${API_RATE}r/s;
limit_req_zone \$binary_remote_addr zone=api_auth:10m rate=${AUTH_RATE}r/s;
EOF
echo "        limit_req zone=front_general burst=${FRONT_BURST} nodelay;" > "$FRONT_FILE"
echo "        limit_req zone=api_general burst=${API_BURST} nodelay;" > "$API_FILE"
echo "        limit_req zone=api_auth burst=${AUTH_BURST} nodelay;" > "$AUTH_FILE"

# 占位行整行替换（四个占位符一次过，避免多次改文件）。
# 替换失败 → 配置文件保持原样（占位行仍是注释），nginx 仍能启动。
if ! awk \
    -v zones="$ZONES_FILE" \
    -v front="$FRONT_FILE" \
    -v api="$API_FILE" \
    -v auth="$AUTH_FILE" '
    function emit(file,   line) {
        while ((getline line < file) > 0) print line
        close(file)
    }
    index($0, "#@RATE_LIMIT_ZONES@") > 0 { emit(zones); next }
    index($0, "#@RATE_LIMIT_FRONT@") > 0 { emit(front); next }
    index($0, "#@RATE_LIMIT_API@") > 0 { emit(api); next }
    index($0, "#@RATE_LIMIT_AUTH@") > 0 { emit(auth); next }
    { print }
' "$CONF" > "$CONF.tmp"; then
    rm -f "$ZONES_FILE" "$FRONT_FILE" "$API_FILE" "$AUTH_FILE" "$CONF.tmp"
    log "展开失败，$CONF 未改动（限流不生效，nginx 照常启动）"
    exit 1
fi

# 模板与脚本版本不一致时（新增了占位符但忘了在这里展开）会留下注释行：
# 不影响启动，但限流会静默缺失，必须点名。
if grep -q '^[[:space:]]*#@RATE_LIMIT_' "$CONF.tmp"; then
    log "警告：以下占位行未被展开（模板与脚本版本不一致？）："
    grep '^[[:space:]]*#@RATE_LIMIT_' "$CONF.tmp" >&2
fi

mv "$CONF.tmp" "$CONF"
rm -f "$ZONES_FILE" "$FRONT_FILE" "$API_FILE" "$AUTH_FILE"

echo "render-rate-limit: 已写入限流阈值到 $CONF（front ${FRONT_RATE}r/s burst ${FRONT_BURST}；api ${API_RATE}r/s burst ${API_BURST}；auth ${AUTH_RATE}r/s burst ${AUTH_BURST}）"
