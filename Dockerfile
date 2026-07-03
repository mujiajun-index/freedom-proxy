# syntax=docker/dockerfile:1

# ===== 构建阶段：编译 TS + 把 public 打包进 dist =====
FROM node:20-alpine AS builder
WORKDIR /app
# 先拷依赖描述，利用层缓存
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
# 产出 dist/；public 经 scripts/copy-assets.cjs 进入 dist/public（部署自包含）
RUN npm run build

# ===== 运行阶段：纯 Node 内置模块，无需 node_modules =====
FROM node:20-alpine AS runtime
RUN apk add --no-cache tzdata
WORKDIR /app
# 配置与日志写到 /app/data（由 compose 挂载卷持久化）；默认时区 Asia/Shanghai（访问日志按本地时间）
ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    CONFIG_PATH=/app/data/config.json \
    ACCESS_LOG_PATH=/app/data/access.jsonl
COPY package.json ./
COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/server/index.js"]
