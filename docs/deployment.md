# 部署与运维说明

> 本文覆盖：环境变量清单、本地/Docker/生产三种部署方式、数据库迁移流程、监控告警、备份与回滚、常见故障排查。

---

## 1. 环境变量

完整清单与逐项注释见仓库根目录 [`.env.example`](../.env.example)。以下只列**必须理解语义**的部分。

### 1.1 启动即校验（fail fast）

`apps/api/src/config/env.ts` 用 zod 在进程启动时校验所有环境变量，缺失或非法会**直接拒绝启动并打印具体缺哪一项**。这是刻意设计：内部工具的部署往往由不熟悉全部配置的同学操作，「启动即失败 + 明确指出问题」比「运行到某个接口才 500」的排查成本低一个数量级。

生产环境额外强校验：

- `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` 长度 ≥ 32 且不得是模板里的示例值（含 `change-me` / `dev-only` / `please-override` 会被拒绝）；
- 两个密钥必须不同（共用密钥意味着 refresh token 可以当 access token 用）；
- `AI_PROVIDER` 选了真实厂商但未配对应 API Key → 拒绝启动。

### 1.2 关键变量

| 变量 | 生产建议 | 说明 |
| --- | --- | --- |
| `NODE_ENV` | `production` | 影响日志格式、错误详情、Swagger 开关、密钥强校验 |
| `DATABASE_URL` | 独立数据库账号，最小权限 | 应用账号不需要 DDL 权限；迁移用单独账号 |
| `DATABASE_POOL_SIZE` | `CPU核数 × 2 + 磁盘数`，PgBouncer 前置时取实例数的 1/4 | 多实例部署时按「实例数 × 池大小 ≤ 数据库最大连接数」反推 |
| `REDIS_URL` | 独立实例 + 密码 | 用于限流与任务 |
| `JWT_ACCESS_TTL` | `15m` ~ `2h` | 敏感场景用 15m，代价是刷新请求变多 |
| `JWT_REFRESH_TTL` | `14d` | 超过 30 天用户体验差、泄露风险高 |
| `BCRYPT_ROUNDS` | `12`（CI/测试可降 4） | 每 +1 成本翻倍；12 ≈ 250ms |
| `AI_PROVIDER` | `openai` / `deepseek` 等 | 未配 Key 时会自动降级为 mock 并告警 |
| `AI_MONTHLY_BUDGET_CNY` | 按团队规模设定 | 超预算拒绝新任务（HTTP 402），这是成本熔断线 |
| `COLLECTOR_MODE` | `live` | `mock` 返回确定性仿真数据，仅用于联调 |
| `LOG_PRETTY` | `false` | 生产必须 JSON，否则日志采集系统无法解析 |
| `AUDIT_LOG_RETENTION_DAYS` | `365` | 审计日志保留期，按月定时清理 |

---

## 2. 本地开发

### 2.1 有 Docker

```bash
pnpm install
cp .env.example .env
pnpm infra:up                                    # 起 PostgreSQL（+ Redis，见下方说明）
pnpm --filter @creatorops/api prisma:generate
pnpm db:migrate                                  # 或按 §3.3 先生成迁移基线
pnpm db:seed
pnpm dev                                         # 前端 5173 + 后端 3100
```

### 2.2 没有 Docker：用本机已装的 PostgreSQL

**Redis 不需要**：当前代码没有任何地方读取 `REDIS_URL`（限流用进程内计数，定时任务用进程内调度），
`docker-compose.yml` 里的 redis 服务是为将来引入分布式限流/队列预留的。所以只准备 PostgreSQL 即可。

一键脚本（Windows，已装 PostgreSQL 的情况）：

```powershell
.\scripts\setup-database.ps1
# 中途会询问 postgres 超级用户密码；脚本幂等，可反复执行
```

脚本做的事等价于手动执行：

```sql
CREATE ROLE creatorops WITH LOGIN PASSWORD 'creatorops' CREATEDB;
CREATE DATABASE creatorops WITH ENCODING 'UTF8' OWNER creatorops TEMPLATE template0;
```

```bash
# 然后
pnpm --filter @creatorops/api prisma:generate
# 注意：本机数据库若还是空的，需先按 §3.3 生成迁移基线
pnpm --filter @creatorops/api prisma:deploy
pnpm db:seed
pnpm dev
```

`.env` 保持 `.env.example` 的默认值即可：

```
DATABASE_URL=postgresql://creatorops:creatorops@localhost:5432/creatorops?schema=public
```

**关于 PostgreSQL 版本**：本项目在 PostgreSQL 16 上设计（`docker-compose.yml` 用 `postgres:16-alpine`），
实测在 PostgreSQL 17 上同样可用。若你本机装的是 17 或更高版本，`scripts/setup-database.ps1`
可能需要通过 `-PgBin` 指定实际路径，例如：

```powershell
.\scripts\setup-database.ps1 -PgBin 'C:\Program Files\PostgreSQL\17\bin'
```

---

## 3. Docker 部署

### 3.1 开发依赖编排

```bash
docker compose up -d              # 仅 postgres + redis
docker compose logs -f postgres
docker compose down               # 保留数据卷
docker compose down -v            # 连数据一起删除（危险）
```

### 3.2 全栈容器化

```bash
# 生产必须通过环境变量注入密钥，绝不写进镜像或 compose 文件
export JWT_ACCESS_SECRET="$(openssl rand -base64 48)"
export JWT_REFRESH_SECRET="$(openssl rand -base64 48)"
export AI_PROVIDER=deepseek
export DEEPSEEK_API_KEY=sk-...

docker compose --profile full up -d --build
# 前端 http://localhost:8080   后端 http://localhost:3100
```

**镜像设计**

- `apps/api/Dockerfile`：多阶段构建（deps → build → runner），生产镜像用非 root 用户，只拷贝 `dist` 与 `node_modules` 的生产依赖。
- `apps/web/Dockerfile`：`node:20-alpine` 构建 → `nginx:alpine` 托管。`apps/web/nginx.conf` 提供：
  - SPA history 路由 fallback（否则刷新 `/creators/xxx` 会 404）；
  - `/api` 反向代理到 `http://api:3100`（浏览器同源，避免 CORS 与跨域 cookie 问题）；
  - 静态资源长缓存 + `index.html` 不缓存（保证发布后用户能拿到新版本）。

### 3.3 首次建立迁移基线（重要）

仓库当前**没有提交基线迁移**（创建业务表的那个迁移）。`prisma/migrations/` 下只有两个手写迁移，其中一个就是创建 `code_sequences` 表的迁移。

**为什么没有基线**：开发环境（受限沙箱）无法执行 `prisma migrate dev`——它需要启动查询引擎与 shadow database（均需 spawn 子进程，被沙箱拒绝）。与其提交一份未经校验的手写 DDL（列类型/默认值/外键顺序很容易与 Prisma 期望产生偏差），不如让它在正常环境由 Prisma 自己生成。

首次拉起数据库时执行：

```bash
# 1) 生成基线 DDL（不需要 shadow database，从「空」对比到当前 schema）
mkdir -p apps/api/prisma/migrations/0_init
pnpm --filter @creatorops/api exec prisma migrate diff \
  --from-empty \
  --to-schema-datamodel apps/api/prisma/schema.prisma \
  --script > apps/api/prisma/migrations/0_init/migration.sql

# 2) 标记为「已应用」——因为库是空的，这里只是登记历史，不真正执行
pnpm --filter @creatorops/api exec prisma migrate resolve --applied 0_init

# 3) 应用其余迁移（如 code_sequences）并写入演示数据
pnpm --filter @creatorops/api prisma:deploy
pnpm db:seed
```

> 如果只是想快速试跑、不在意迁移历史，也可以用 `pnpm --filter @creatorops/api exec prisma db push` 直接把 schema 推到数据库（不生成迁移文件），然后再手动创建 `code_sequences` 表：
> ```sql
> CREATE TABLE IF NOT EXISTS code_sequences (
>   scope VARCHAR(64) PRIMARY KEY,
>   value BIGINT NOT NULL DEFAULT 0,
>   updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
> );
> ```
> **但生产环境不要用 `db push`**：它不做历史记录，后续无法安全演进。

### 3.4 迁移在部署流水线中的位置

```bash
# 部署顺序（关键：先迁移再加实例，避免新代码访问不存在的字段）
pnpm --filter @creatorops/api prisma:deploy   # 仅应用已有迁移，不生成
# 迁移成功后再滚动更新应用实例
```

**生产禁止使用 `prisma migrate dev`**：它会检测 schema 漂移并可能触发重置。生产只用 `migrate deploy`。

**破坏性变更的三步法**（避免停机）：

1. 本次发布：加新字段（可空或带默认值），代码同时兼容新旧；
2. 数据回填（后台脚本/一次性任务）；
3. 下次发布：代码只读新字段，随后清理旧字段。

---

## 4. 生产部署（非容器：PM2 + Nginx）

```bash
# 后端
pnpm --filter @creatorops/api build
NODE_ENV=production node apps/api/dist/main.js      # 或用 PM2

# PM2 示例（cluster 模式；注意 cluster 下定时任务会被每个 worker 触发）
pm2 start apps/api/dist/main.js --name creatorops-api -i 2 --env production

# 前端
pnpm --filter @creatorops/web build
# 将 apps/web/dist 交给 Nginx 托管
```

### ⚠️ 多实例与定时任务

`SchedulerModule` 里的任务（月度结算生成、到期提醒、日志清理）**在集群模式下每个实例都会触发**。

- 业务层幂等保证不会重复出账（唯一约束 + 幂等键），所以不会产生错误数据；
- 但会产生重复的日志与无谓的数据库压力。

推荐方案（任选）：

| 方案 | 做法 | 适用 |
| --- | --- | --- |
| **独立 worker 进程**（推荐） | Web 实例设 `SCHEDULER_ENABLED=false`，单独跑一个 worker 只开调度 | 中大型部署 |
| Redis 选主锁 | 任务执行前 `SETNX scheduler:lock:{task} TTL`，抢到锁才执行 | 无独立 worker 时 |
| 单实例 | 只部署一个后端实例 | 内部小工具 |

> 当前代码未内置上述开关（保持零外部依赖），实施时在 `ScheduledJobsService` 的每个 `@Cron` 方法开头加锁判断即可，边界清晰。

---

## 5. Nginx 参考配置

```nginx
server {
  listen 443 ssl http2;
  server_name creatorops.juxingzhimei.com;

  ssl_certificate     /etc/nginx/certs/fullchain.pem;
  ssl_certificate_key /etc/nginx/certs/privkey.pem;

  # 安全响应头（应用层已有 Helmet，网关层再加一层）
  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header X-Frame-Options "DENY" always;
  add_header Referrer-Policy "strict-origin-when-cross-origin" always;

  client_max_body_size 4m;    # 与后端 body 上限对齐（批量导入达人需要）

  # 前端静态资源
  root /var/www/creatorops;
  index index.html;

  location /assets/ {
    expires 1y;
    add_header Cache-Control "public, immutable";
  }

  location / {
    try_files $uri $uri/ /index.html;     # SPA history 路由
    add_header Cache-Control "no-cache";  # index.html 不缓存
  }

  location /api/ {
    proxy_pass http://127.0.0.1:3100;
    proxy_http_version 1.1;

    # 必须传递真实客户端 IP，否则审计日志与限流会记到 Nginx 的 IP 上
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Request-Id $request_id;      # 让请求 ID 从网关开始贯穿
    proxy_set_header Host $host;

    proxy_read_timeout 60s;   # AI 任务最长 45s 超时，网关需略大于它
  }
}
```

> **重要**：应用已设置 `trust proxy = 1`，因此必须保证只有**一层**可信代理。多一层 CDN 时要相应调整为 2，否则 `X-Forwarded-For` 可被客户端伪造，导致审计 IP 失真。

---

## 6. 监控与告警

### 6.1 健康检查

| 端点 | 用途 | 特性 |
| --- | --- | --- |
| `GET /api/health` | 存活探针（liveness） | 不查外部依赖，只证明进程能响应 |
| `GET /api/health/ready` | 就绪探针（readiness） | 检查数据库连通性，返回 503 表示未就绪 |

**为什么分两个**：数据库抖动时，如果存活探针也查数据库，k8s 会不停重启容器——重启并不能修复数据库，只会放大故障。存活探针必须只反映「进程自身是否健康」。

```yaml
# k8s 探针参考
livenessProbe:
  httpGet: { path: /api/health, port: 3100 }
  initialDelaySeconds: 20
  periodSeconds: 15
readinessProbe:
  httpGet: { path: /api/health/ready, port: 3100 }
  initialDelaySeconds: 15
  periodSeconds: 10
  failureThreshold: 3
```

### 6.2 日志

- 生产输出 JSON（`LOG_PRETTY=false`），字段含 `req.id` / `level` / `context` / `msg`。
- **请求 ID 是最重要的排查抓手**：响应头 `X-Request-Id`、错误响应体 `requestId`、审计记录 `requestId` 三处一致，可据此串起「用户报错 → 服务端日志 → 审计记录」。
- 建议接入 Loki 或 ELK，并按 `level` 建告警：`level=error` 5 分钟内超过 10 条即告警。

### 6.3 需要监控的指标

| 指标 | 来源 | 建议阈值 |
| --- | --- | --- |
| 接口 P95 延迟 | 网关或 APM | > 1s 告警（看板聚合接口可放宽到 2s） |
| 5xx 比例 | 日志聚合 | > 1% 告警 |
| 数据库连接池占用 | `pg_stat_activity` | > 80% 告警（说明 `DATABASE_POOL_SIZE` 需要调整或存在连接泄漏） |
| 慢查询数 | 应用日志（>300ms） | 持续出现即排查缺失索引 |
| AI 月度成本 | `GET /api/ai/usage` | > 80% 预算告警（应用在 100% 时已熔断） |
| AI 降级率 | `status=FALLBACK_USED` 占比 | > 10% 说明主 Provider 不稳定 |
| 结算生成失败数 | 定时任务日志 / `skippedReasons` | 有 `合同冲突` 类原因必须人工介入 |
| 超期未打款结算单 | `status=APPROVED AND dueDate < now` | 每天检查（应用有站内提醒） |

### 6.4 外部告警通道

`.env` 预留 `ALERT_WEBHOOK_URL`（企微/钉钉机器人）。当前版本通过站内 `Notification` 表实现提醒，接入外部通道只需在 `ScheduledJobsService` 生成通知的同时调用 webhook。

---

## 7. 备份与恢复

### 7.1 备份策略

| 对象 | 方式 | 频率 | 保留 |
| --- | --- | --- | --- |
| PostgreSQL | `pg_dump -Fc` 全量 + WAL 归档（PITR） | 全量每日 01:00，WAL 连续 | 全量 30 天，月度归档 1 年 |
| 上传附件 | 对象存储版本控制（切 S3 后） | 实时 | 同业务要求 |
| `.env` 密钥 | 密钥管理服务（Vault/KMS） | 变更时 | 永久（含轮换历史） |

```bash
# 全量备份
pg_dump -Fc -h $DB_HOST -U creatorops creatorops > creatorops-$(date +%F).dump

# 恢复到新库（演练用，绝不要直接覆盖生产库）
createdb -h $DB_HOST -U postgres creatorops_restore
pg_restore -h $DB_HOST -U postgres -d creatorops_restore creatorops-2026-01-01.dump
```

### 7.2 恢复演练

**每季度必须做一次**：把最近一次备份恢复到新库，然后跑 `prisma migrate status` 与关键业务查询（结算单金额合计、达人数量）。没有演练过的备份等于没有备份。

### 7.3 回滚

| 场景 | 回滚方式 |
| --- | --- |
| 应用代码问题 | 回退镜像 tag / `git revert` 后重新部署（数据库未变，可直接回退） |
| 迁移引入非破坏性变更（加字段/加表） | 应用可回退，字段留着不影响 |
| 迁移引入破坏性变更 | **必须走第 3.3 节的三步法**，不要做需要回滚的破坏性变更 |
| 数据被误改 | 用审计日志定位变更内容 → 从备份 PITR 恢复到临时库 → 提取受影响行 → 人工核对后修复 |

---

## 8. 安全运维清单

- [ ] 生产环境 `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` 为随机 48 字节且互不相同（启动时会校验）
- [ ] 数据库账号最小权限：应用账号无 DDL 权限，迁移用独立账号
- [ ] 数据库不暴露公网端口，仅内网访问
- [ ] Redis 设置密码且不暴露公网
- [ ] 强制 HTTPS，开启 HSTS；证书自动续期（certbot / 云厂商）
- [ ] `WEB_ORIGIN` 精确配置为生产域名（不要用 `*`）
- [ ] Swagger 在生产关闭（`NODE_ENV=production` 时自动关闭）
- [ ] 敏感字段加密：确认 `JWT_ACCESS_SECRET` 稳定（**更换它会导致已加密的证件号无法解密**，这是当前实现的已知约束，生产应改为独立 KMS 数据密钥）
- [ ] 审计日志保留期符合公司合规要求
- [ ] 离职员工的账号及时禁用（禁用会自动撤销其全部会话）
- [ ] 定期审查 `Role` 权限覆盖项（`permissionOverrides`），清理临时授权

---

## 9. 常见故障排查

| 现象 | 可能原因 | 排查 |
| --- | --- | --- |
| 服务启动即退出，日志有「环境变量校验失败」 | 缺少必填变量，或生产用了示例密钥 | 日志会逐项列出缺失/非法字段，照单补 `.env` |
| `prisma migrate` 报找不到 `DATABASE_URL` | Prisma CLI 与运行时读取的 env 文件不同 | 本项目在 `src/config/env.ts` 中显式加载根目录 `.env`；CLI 也读根目录，确认 `apps/api/.env` 没有覆盖它 |
| 前端 401 后一直跳登录页 | refresh token 失效（被撤销/过期）或前后端时钟偏差过大 | 查 `refresh_tokens` 表该用户记录；检查服务器 NTP |
| 刷新页面 404 | Nginx 缺少 SPA history fallback | 确认 `try_files $uri $uri/ /index.html` |
| 结算生成全部 skipped | 达人均无可结算内容，或合同非 `ACTIVE`，或内容已结算过 | 看接口返回的 `skippedReasons` 数组，有明确原因 |
| 结算生成报「存在多份生效合同」 | 合同区间重叠（通常由绕过审批直接改库造成） | 查该达人 `status=ACTIVE` 的合同区间，终止其中一份 |
| 结算单提交时报「明细汇总与单据金额不一致」 | 手改过金额、并发调整、或历史数据迁移 | 作废后重新生成结算单 |
| AI 任务全部 402 | 月度预算用尽 | `GET /api/ai/usage` 查看用量；调整 `AI_MONTHLY_BUDGET_CNY` 或等下月重置 |
| AI 任务状态 `FALLBACK_USED` 很多 | 主 Provider 不稳定或超时设置过紧 | 看 `fallbackReason`；调大 `AI_REQUEST_TIMEOUT_MS` 或更换 Provider |
| AI 输出报 `SCHEMA_MISMATCH` | Prompt 约束变弱或模型能力不足 | 查看 `renderedPrompt` 与原文；新建 Prompt 版本加强约束 |
| 数据库连接数打满 | `DATABASE_POOL_SIZE × 实例数` 超过数据库上限 | 计算实际连接数，调小池大小或引入 PgBouncer |
| 审计日志里 IP 都是同一个 | Nginx 未传 `X-Forwarded-For`，或 `trust proxy` 层级不对 | 检查 Nginx 配置与 `trust proxy` 数值是否匹配代理层数 |
| 列表页越来越慢 | 关键词模糊搜索无法走索引 | 查慢查询日志；数据量增长后引入 `pg_trgm` GIN 索引 |

---

## 10. CI 流水线

`.github/workflows/ci.yml` 定义四道关，顺序按「反馈速度」排列——先跑最快能发现问题的检查，让开发者在一分钟内拿到结论：

| 关卡 | 内容 | 为什么这样安排 |
| --- | --- | --- |
| 1. 静态校验 | `check:prisma-usage` → `enum:selftest` → `enum:check` → 后端 typecheck → 前端 typecheck → `openapi:export` + `openapi:check` → lint | 无需数据库，约 1 分钟出结果。先跑三类「跨边界一致性」校验（模型名/枚举值/接口字段），即使 `prisma generate` 失败也能先给出模型层面的结论 |
| 2. 单元测试 | `test:cov`（含覆盖率阈值） | 结算引擎与权限矩阵有覆盖率门槛：资金与安全代码不允许「没测试就合并」 |
| 3. 集成测试 | 真实 PostgreSQL + Redis，`prisma:deploy` → `db:seed` **执行两遍** → e2e | 验证两件手工测试最容易漏的事：迁移能否在干净库跑通、种子脚本是否幂等。e2e 覆盖资金主链路与权限红线 |
| 4. 构建 | 全量 `pnpm build` 并上传前端产物 | watch 模式会掩盖构建错误，这里显式验证产物可产出 |

### 10.1 三类跨边界一致性校验，以及它们各自拦什么

这一类 bug 的共同点是：**TypeScript 与单元测试都发现不了**。前端自己的枚举声明和用它的页面都在前端这一侧，`status === 'PENDING'` 两边取自同一个手写联合类型，类型系统只能保证「前端和自己一致」，永远自洽。所以必须引入**另一侧的事实**来对照。

| 校验 | 事实来源 | 拦下的问题 | 真实案例 |
| --- | --- | --- | --- |
| `check:prisma-usage` | `schema.prisma` | 模型名拼错、非法委托方法、枚举名写错 | `prisma.creater` |
| `enum:check` | `schema.prisma` 的 `enum` | 前端枚举成员与后端**不等**（多了/少了/拼错），以及页面里裸写的错误状态值 | 15 个枚举中 9 个有漂移：`ContractStatus` 多了 `APPROVED`/`REJECTED`、`ProjectStatus` 写成 `IN_PROGRESS` 且把 `CANCELED` 拼成 `CANCELLED`、`AiTaskStatus` 用 `PENDING`/`FALLBACK`（后端是 `QUEUED`/`FALLBACK_USED`）…… |
| `openapi:check` | 后端 OpenAPI 规范 | 前端提交/解析了后端 DTO 里没有或类型不符的字段 | 新建项目提交了 DTO 里不存在的 `status`、`description` |

`enum:check` 有两层保险：**先比对枚举声明**（静态、必查），**再扫描页面里的大写字面量**（拦住 `SettlementDetailPage` 里裸写的 `'CANCELLED'` 这类没走常量表的用法）。脚本自带 `--self-test`，用构造数据反向验证「它确实会报错」——因为一个因为正则写坏而永远输出「通过」的检查脚本，比没有检查更危险。

> `enum:check` 在开发过程中真的抓到过自己的漏洞：第一版把「可疑字面量」的正则写成强制要求至少一个下划线，结果 `'PENDING'` / `'FALLBACK'` 这两个单词型取值全被漏掉——而它们正是最典型的事故值。是 `--self-test` 里的用例把它暴露出来的。

**CI 环境变量的取值原则**：使用**明显的假值**（如 `ci-only-access-secret-not-for-production-...`），长度满足校验但不复用任何真实密钥。`AI_PROVIDER=mock`、`COLLECTOR_MODE=mock` 保证 CI 不依赖外部服务、不产生费用。

**本地等价命令**（提交前自查）：

```bash
pnpm verify            # = enum:check + 全仓 typecheck + 全仓 test
pnpm contract:verify   # = enum:check + openapi:export + openapi:check
pnpm enum:selftest     # 只验证校验脚本自身是否有效
pnpm -r lint
pnpm build
```

> ⚠️ **前端 typecheck 曾经是个空操作**。`apps/web/package.json` 原先写的是 `tsc --noEmit`，而 `apps/web/tsconfig.json` 是 `{ "files": [], "references": [...] }` 形式的 solution 配置——`tsc` 对它执行的结果是「检查 0 个文件」，却一直报 0 error。所有前端类型错误（含上面那一整批枚举漂移）都被这一行悄悄吞掉。现已改为显式指定 `-p tsconfig.app.json && -p tsconfig.node.json`。
>
> **教训**：「类型检查通过」这句话，必须先确认它真的检查了东西。验证方法：故意改坏一个类型，看它是否报错。

---

## 11. 升级与维护窗口

| 操作 | 是否需要停机 | 说明 |
| --- | --- | --- |
| 应用代码部署（无破坏性迁移） | 否 | 滚动更新；迁移先于新实例启动 |
| 加索引 | 否（大表建议用 `CREATE INDEX CONCURRENTLY`） | Prisma 生成的迁移默认非并发，大表需手工调整 |
| 加字段/加表 | 否 | 三步法第 1 步 |
| 改字段类型/删字段 | 是（或走三步法） | 尽量避免；必须做时选在业务低峰 |
| Prompt 模板调整 | 否 | 新建版本 + 灰度，随时可回滚（这正是把 Prompt 放库里的价值） |
| 调整分润比例 | 否 | 对**新签合同**生效；已生效合同按不可修改原则需终止重签 |
