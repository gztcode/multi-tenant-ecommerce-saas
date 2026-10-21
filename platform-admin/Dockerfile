# 多阶段构建：依赖 -> 构建 -> 运行
#
# 依赖 Next.js 官方推荐的 standalone 产物（next.config.ts 里的 output: 'standalone'）：
# 构建阶段会把 server.js 与运行期真正用到的依赖收敛进 .next/standalone，
# 运行阶段直接 node .next/standalone/server.js，不需要完整 node_modules。

# ---------- 依赖阶段 ----------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------- 构建阶段 ----------
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# platform-admin 没有 NEXT_PUBLIC_* 变量，无需在构建期注入。
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
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

EXPOSE 3000
CMD ["node", "server.js"]