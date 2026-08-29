FROM node:20-alpine AS client-builder
WORKDIR /app/client
COPY client/package*.json ./
# 国内服务器构建慢/失败时，可在 build 命令传入其它源：
#   docker compose build --build-arg NPM_REGISTRY=https://registry.npmjs.org
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN npm ci --registry=${NPM_REGISTRY}
COPY client/ ./
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY server/ ./server/
COPY package*.json ./
# 注意：不将 .env 烘焙到镜像中，应通过 docker-compose 挂载或环境变量注入
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN npm ci --omit=dev --registry=${NPM_REGISTRY}
COPY --from=client-builder /app/client/dist ./client/dist

# 数据目录归属 node 用户（容器以非 root 运行）
RUN mkdir -p /app/data && chown -R node:node /app/data

# 健康检查（PORT 可通过环境变量修改，需保持一致）
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3100}/health" || exit 1

VOLUME /app/data
EXPOSE 3100
USER node
CMD ["node", "server/index.js"]
