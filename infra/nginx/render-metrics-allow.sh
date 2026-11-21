#!/bin/sh
# 把 METRICS_ALLOW_CIDR 展开成 nginx 的 allow 语句（Prometheus 抓取端点白名单）。
#
# ## 为什么需要这个脚本
#
# 官方 nginx 镜像的 entrypoint 先用 envsubst 把 /etc/nginx/templates/*.template
# 渲染到 /etc/nginx/conf.d/，再按文件名顺序执行 /docker-entrypoint.d/*.sh
# （.sh 会被**执行**，不是 source）。本脚本挂成 25-metrics-allow.sh，
# 在 20-envsubst-on-templates.sh 之后跑，替换模板里预留的占位符行。
#
# 为什么不能直接用模板变量：
#   1. envsubst 不是 shell，不支持 ${VAR:-默认}；
#   2. nginx 的 allow 指令**一条只吃一个地址/CIDR**，逗号分隔的列表写不成
#      一条指令（写成 `allow a,b;` 会被 nginx 当成非法地址 → 配置语法错误）。
#
# ## 失败方向（重要）
#
# 变量为空 / 脚本没被执行 → 模板里的占位符保持注释 → 该 location 只剩 deny all
# → 抓取全部拒绝。**任何异常都只会收紧、不会放行**。
#
# 写错的条目（比如 10.0.0.0/33）会被**跳过并打日志**，不会写进配置：
# 一条非法 allow 语句会让 nginx **启动失败**，代价是整站不可用 ——
# 那比「少放行一个网段」严重得多。
#
# 用法：render-metrics-allow.sh [配置文件路径]
#   默认 /etc/nginx/conf.d/prod.conf（模板 prod.conf.template 的渲染产物）。

CONF="${1:-/etc/nginx/conf.d/prod.conf}"
PLACEHOLDER='#@METRICS_ALLOW_CIDR@'

if [ ! -f "$CONF" ]; then
    echo "render-metrics-allow: 找不到 $CONF，跳过（metrics 保持 deny all）"
    exit 0
fi

ALLOW_FILE=$(mktemp) || exit 1

# 逗号分隔 → 每行一条 allow 语句；顺手去掉空白项；
# 非法条目跳过（并在日志里点名），不让 nginx 因一个手误起不来。
printf '%s' "${METRICS_ALLOW_CIDR:-}" \
    | tr ',' '\n' \
    | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' \
    | grep -v '^$' \
    | awk '
        # 返回 1 = 像个能用的地址（IPv4 严格校验；IPv6 只做形状校验）
        function ok(s,   n, p, i, a, cnt) {
            p = 0
            n = index(s, "/")
            if (n > 0) {
                p = substr(s, n + 1)
                s = substr(s, 1, n - 1)
                if (p !~ /^[0-9]+$/) return 0
            }
            if (s ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/) {
                cnt = split(s, a, ".")
                for (i = 1; i <= 4; i++) {
                    if (a[i] + 0 > 255) return 0
                }
                return (p == 0) || (p + 0 <= 32)
            }
            if (s ~ /^[0-9a-fA-F:]+$/) {
                return (p == 0) || (p + 0 <= 128)
            }
            return 0
        }
        ok($0) { print "        allow " $0 ";"; next }
        { print "render-metrics-allow: 跳过非法条目：" $0 > "/dev/stderr" }
    ' > "$ALLOW_FILE"

COUNT=$(wc -l < "$ALLOW_FILE" | tr -d ' ')

# 占位符行整行替换成 allow 语句（没有 allow 时整行删掉，只剩 deny all）。
if ! awk -v placeholder="$PLACEHOLDER" -v allowfile="$ALLOW_FILE" '
    index($0, placeholder) > 0 {
        while ((getline line < allowfile) > 0) print line
        close(allowfile)
        next
    }
    { print }
' "$CONF" > "$CONF.tmp"; then
    rm -f "$ALLOW_FILE" "$CONF.tmp"
    echo "render-metrics-allow: 展开失败，$CONF 未改动（metrics 保持 deny all）" >&2
    exit 1
fi

mv "$CONF.tmp" "$CONF"
rm -f "$ALLOW_FILE"

echo "render-metrics-allow: 已写入 $COUNT 条 allow 到 $CONF"
