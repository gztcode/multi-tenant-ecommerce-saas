# 多阶段构建：依赖 -> 构建 -> 运行
#
# 依赖阶段必须装 devDependencies：`prisma generate` 与 `nest build` 都在 devDependencies 里。
# 运行阶段只装生产依赖，镜像小得多。

# ---------- 依赖阶段 ----------
FROM node:22-alpine AS deps
# Prisma 的引擎在 Alpine 上需要 openssl（libssl），否则 generate 阶段会报
# "unable to require openssl" 类错误。
RUN apk add --no-cache openssl
# node:22-alpine 自带 npm 10，它的 `npm ci` 对 lockfile 的校验比 npm 11 严格，
# 会因为本仓库 lockfile（由 npm 11 生成）的元数据漂移直接失败。
# 统一到 npm 11，与生成本地 node_modules 的版本保持一致。
RUN npm install -g npm@11
WORKDIR /app
# 只复制清单，让这一层的缓存不受源码改动影响。
COPY package.json package-lock.json ./
RUN npm ci

# ---------- 构建阶段 ----------
FROM node:22-alpine AS builder
RUN apk add --no-cache openssl
RUN npm install -g npm@11
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# prisma generate 必须显式跑：@prisma/client 的产物落在 node_modules/.prisma 里，
# 光靠 npm install 不会生成，运行时 new PrismaClient() 会直接抛错。
RUN npx prisma generate
RUN npm run build
# ⚠️ **产物路径必须是 dist/main.js**（不是 dist/src/main.js）——
# 在 api/ 下新增顶层目录（如 scripts/）会改变 TypeScript 的公共根目录，
# 产物就多出一层 src/，与运行阶段的 `node dist/main.js` 对不上，
# 容器会起不来（Cannot find module '/app/dist/main.js'）。
# ⚠️ 单测与 e2e 都从源码跑（ts-jest / ts-node），**发现不了产物路径变了** ——
# 所以在这里断言一次，让镜像构建就失败，而不是让容器崩溃循环。
RUN test -f /app/dist/main.js

# ---------- 运行阶段 ----------
FROM node:22-alpine AS runner
RUN apk add --no-cache openssl
# 同上：运行阶段的 `npm ci --omit=dev` 也需要 npm 11 才能通过 lockfile 校验。
RUN npm install -g npm@11
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 运行期需要 prisma CLI 来执行 `prisma migrate deploy`，全局装一份。
RUN npm install -g prisma@6

# schema 与迁移历史：migrate deploy 与运行时 client 都要读它。
COPY prisma ./prisma
# 运行阶段必须重新 generate：`npm ci --omit=dev` 装的是「未经生成」的
# @prisma/client（产物在 node_modules/.prisma 里，安装过程不会生成）。
# 不在这里生成的话，启动时 new PrismaClient() 直接抛
# "@prisma/client did not initialize yet"。
RUN npx prisma generate

COPY --from=builder /app/dist ./dist

# 启动前先跑 `prisma migrate deploy`：数据卷是空的（新机器、或刚 down 完重建）
# 时数据库里没有表，服务会因 relation does not exist 反复重启。
# 迁移是幂等的，已有 schema 的情况下是空操作。
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
# 入口与 package.json 的 start:prod 一致，都是 dist/main.js。
# （此前产物在 dist/src/main.js：tsconfig.build.json 没排除 prisma/，
#  编译器推断出的公共根目录变成了项目根，产物多了一层 src/。已修。）
CMD ["node", "dist/main.js"]