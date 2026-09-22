# ---------- Stage 1: 构建 ----------
# 构建上下文是仓库根目录（见 docker-compose.yml 的 build.context: .）
FROM node:20-alpine AS builder

WORKDIR /repo

# 先只拷贝清单文件：只要依赖没变，这一层就命中缓存，
# 业务代码天天改也不会重复下载 node_modules
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/api/package.json apps/api/package.json

# corepack 让镜像内的 pnpm 版本与 package.json 的 packageManager 字段一致
RUN corepack enable \
  && (pnpm install --frozen-lockfile --filter @creatorops/web... || pnpm install --no-frozen-lockfile --filter @creatorops/web...)

COPY tsconfig*.json ./
COPY apps/web ./apps/web

WORKDIR /repo/apps/web
# 构建参数而不是 ENV：VITE_ 变量会被编译进静态资源，
# 生产环境应传相对路径 /api，由 nginx 反代，避免把后端域名写死在产物里
ARG VITE_API_BASE_URL=/api
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN pnpm build

# ---------- Stage 2: 运行 ----------
FROM nginx:alpine AS runner

RUN rm -f /etc/nginx/conf.d/default.conf
COPY apps/web/nginx.conf /etc/nginx/conf.d/creatorops.conf
COPY --from=builder /repo/apps/web/dist /usr/share/nginx/html

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
