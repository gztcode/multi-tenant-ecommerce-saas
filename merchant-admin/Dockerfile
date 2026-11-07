# 多阶段构建：依赖 -> 构建 -> 运行
#
# 依赖 Next.js 官方推荐的 standalone 产物（next.config.ts 里的 output: 'standalone'）：
# 构建阶段会把 server.js 与运行期真正用到的依赖收敛进 .next/standalone，
# 运行阶段直接 node .next/standalone/server.js，不需要完整 node_modules。
#
# ⚠️ **npm workspaces 布局**（阶段 11b）：根 lockfile 是唯一 lockfile，
#    `npm ci --workspace <app>` 只装该端（含其 workspace 依赖
#    @ecom/frontend-shared，npm 会自动把它符号链接到 /app/packages/frontend-shared）。
#    build context 是**仓库根**（compose 里 `context: ..`），路径从根算。

# ---------- 依赖阶段 ----------
FROM node:22-alpine AS deps
RUN npm install -g npm@11
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/frontend-shared/package.json packages/frontend-shared/package.json
COPY merchant-admin/package.json merchant-admin/package.json
RUN npm ci --workspace merchant-admin

# ---------- 构建阶段 ----------
FROM node:22-alpine AS builder
RUN npm install -g npm@11
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY packages/frontend-shared/ packages/frontend-shared/
COPY merchant-admin/ merchant-admin/
WORKDIR /app/merchant-admin

RUN npm run build

# ---------- 运行阶段 ----------
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# HOSTNAME 必须显式设为 0.0.0.0，否则 Next.js 只监听 localhost，
# 容器外（nginx 容器）连不上。
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# standalone 产物自带一份裁剪过的 node_modules；.next 其余部分（静态资源、
# public）是运行时仍要读的，必须单独复制。
COPY --from=builder /app/merchant-admin/.next/standalone ./
COPY --from=builder /app/merchant-admin/.next/static ./.next/static
COPY --from=builder /app/merchant-admin/public ./public

EXPOSE 3000
CMD ["node", "server.js"]
