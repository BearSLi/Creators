# 陌生机器运行手册

> 目标：在一台**全新的机器**上，从零把这个项目跑起来。
> 本文只讲「怎么装起来、怎么确认装对了」。日常运维、监控、备份、生产部署见 [deployment.md](deployment.md)；
> 应用运行期的故障排查见 [deployment.md §9](deployment.md)。

---

## 1. 前置条件

| 依赖 | 版本 | 检查命令 | 说明 |
| --- | --- | --- | --- |
| Node.js | ≥ 20.11 | `node -v` | 由 `package.json` 的 `engines` 声明 |
| pnpm | ≥ 9 | `pnpm -v` | `packageManager` 锁定 `pnpm@9.12.0`；装不上就 `corepack enable` |
| PostgreSQL | 16+ | `psql --version` | Docker 或本机安装皆可 |
| Redis | — | — | **不需要**。当前没有任何代码读取 `REDIS_URL` |
| Git | 任意 | `git --version` | 仅拉代码时需要 |

> 若 `pnpm -v` 报「不支持的引擎」，说明版本过低。`corepack enable && corepack prepare pnpm@9.12.0 --activate`
> 会读取 `packageManager` 字段自动装对版本。

---

## 2. 启动步骤

```bash
# ---------- 1) 拉代码并安装依赖 ----------
git clone <仓库地址> creatorops && cd creatorops
pnpm install

# ---------- 2) 准备环境变量 ----------
cp .env.example .env              # Windows: copy .env.example .env
# 至少改这三项，见 §3
#   DATABASE_URL
#   JWT_ACCESS_SECRET
#   JWT_REFRESH_SECRET

# ---------- 3) 准备数据库（三选一）----------
# A. 用 Docker（会占用宿主机 5432）
pnpm infra:up

# B. 用本机已装的 PostgreSQL（幂等，会提示输入 postgres 超级用户密码）
pnpm db:setup

# C. 手动执行 SQL（**必须指定 OWNER**，否则第 5 步迁移会因属主问题失败）
#    psql -U postgres -c "CREATE ROLE creatorops LOGIN PASSWORD 'creatorops' CREATEDB;"
#    psql -U postgres -c "CREATE DATABASE creatorops ENCODING 'UTF8' OWNER creatorops;"

# ---------- 4) 生成 Prisma 客户端 ----------
pnpm --filter @creatorops/api prisma:generate

# ---------- 5) 执行迁移建表 ----------
pnpm db:deploy

# ---------- 6) 写入演示数据（幂等）----------
pnpm db:seed

# ---------- 7) 启动 ----------
pnpm dev
```

启动后：

| 服务 | 地址 |
| --- | --- |
| 前端 | http://localhost:5173 |
| 接口文档（Swagger） | http://localhost:3100/api/docs |
| 健康检查 | http://localhost:3100/api/health/ready |

演示账号见 [README §六](../README.md)，密码统一 `CreatorOps@2026`。

### 关于第 5 步：不要用 `migrate resolve`

`apps/api/prisma/migrations/0_init/migration.sql`（初始建表基线）**已经提交在仓库里**，直接 `pnpm db:deploy` 就会执行它建出 18 张业务表。

```bash
# ✗ 错误做法：只把迁移标记为「已执行」，不运行任何 SQL
prisma migrate resolve --applied 0_init
#   结果：库是空的 → 第 6 步 db:seed 报「表不存在」

# ✓ 正确做法
pnpm db:deploy
```

`pnpm db:baseline` 只在基线文件缺失或被清空时才需要（脚本会自检并重新生成）；基线存在时它是**空操作**，直接跳过。

---

## 3. 环境变量

配置集中在**仓库根目录的 `.env`**。有两个容易踩的点：

1. **Prisma CLI 不会往上找 `.env`**（只在 schema 同目录或命令执行目录查找）。所以所有涉及 Prisma 的脚本都经 `scripts/with-env.mjs` 包装把根目录 `.env` 注入子进程 —— 请始终用 `pnpm db:deploy` / `pnpm db:seed`，不要直接调 `prisma`。
2. **服务启动时会用 zod 强校验**，不合法直接拒绝启动并打印缺失项。

### 必填（缺失或格式不对 → 拒绝启动）

| 变量 | 要求 |
| --- | --- |
| `DATABASE_URL` | 必须以 `postgres` 开头，如 `postgresql://creatorops:creatorops@localhost:5432/creatorops?schema=public` |
| `JWT_ACCESS_SECRET` | ≥ 16 位 |
| `JWT_REFRESH_SECRET` | ≥ 16 位，且必须与 access 密钥**不同** |

### 生产环境额外要求

| 要求 | 说明 |
| --- | --- |
| 两个 JWT 密钥均 ≥ 32 位 | 生成方式：`openssl rand -base64 48` |
| 不能包含 `change-me` / `dev-only` / `please-override` | 防止「改了环境变量忘了改密钥」上线 |
| `NODE_ENV=production` | 同时会收紧 CORS 到 `WEB_ORIGIN` 白名单 |

### 其余（都有默认值，按需调整）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `API_PORT` | `3100` | 后端端口 |
| `WEB_ORIGIN` | `http://localhost:5173` | CORS 白名单（生产用逗号分隔多个） |
| `DATABASE_POOL_SIZE` | `10` | 连接池上限 |
| `BCRYPT_ROUNDS` | `12` | 密码哈希成本，CI 可降到 4 加速 |
| `AI_PROVIDER` | `mock` | `openai` / `anthropic` / `gemini` / `deepseek` / `mock` |
| `AI_FALLBACK_PROVIDER` | `mock` | 主 Provider 失败时的降级目标 |
| `AI_DEFAULT_MODEL` | `gpt-4o-mini` | 种子里 Prompt 模板的初始模型名 |
| `AI_MONTHLY_BUDGET_CNY` | `2000` | 月度预算，超限自动降级并告警 |
| `COLLECTOR_MODE` | `mock` | 未配置平台凭证时返回可复现的仿真数据 |
| `STORAGE_DRIVER` | `local` | `local` 落盘到 `STORAGE_LOCAL_DIR`，或切 `s3` |
| `SETTLEMENT_PAYMENT_TERM_DAYS` | `30` | 账期天数，影响结算单应付款日 |

完整清单与逐项注释见 [.env.example](../.env.example)。

> **用真实 AI Provider 时**：必须同时提供对应的 `*_API_KEY`（否则启动即失败）。
> 若同时改了模型名，记得跑 `pnpm db:sync-models` —— **生效的模型来自数据库里的 Prompt 模板记录**，
> 它优先于 `AI_DEFAULT_MODEL`，只改 `.env` 不生效。

---

## 4. 确认装对了

按顺序跑一遍，每步都应有明确输出：

```bash
# 1) 迁移记录与表结构是否一致（列出迁移文件、已应用记录、缺失的表）
pnpm db:doctor

# 2) 服务能否起来
pnpm dev
curl http://localhost:3100/api/health/ready        # 期望 200 + status: ok
```

再打开 http://localhost:5173 ，用 `admin@juxingzhimei.com` / `CreatorOps@2026` 登录：

| 检查点 | 期望 |
| --- | --- |
| 登录 | 能进经营看板，左侧导航完整 |
| 数据 | 看板有 KPI 数字、流水趋势图有数据（说明 seed 成功） |
| 权限 | 换 `audit@` 登录后所有「保存/审批」按钮消失或提示无权限 |
| 接口文档 | http://localhost:3100/api/docs 能打开并列出 62 个接口 |

---

## 5. 建库阶段的常见阻塞

只列**搭建阶段**会挡住你、且现象容易被误判的几种。运行期故障见 [deployment.md §9](deployment.md)。

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `P3016`：必须是表 `_prisma_migrations` 的属主 | 建库时没指定 `OWNER`，表被超级用户创建过 | `pnpm db:nuke -- --yes` 重建库（**会清空数据**），然后 `pnpm db:deploy` + `pnpm db:seed` |
| `P3018` + `语法错误 在 "" 或附近的` | 迁移文件带了 UTF-8 BOM | `pnpm db:baseline -- --force` 重新生成（脚本会剥 BOM 并复检首字节） |
| `db:seed` 报「表不存在」 | 用了 `migrate resolve --applied` 跳过了建表 | `pnpm db:doctor` 确认后 `pnpm db:nuke -- --yes` → `pnpm db:deploy` → `pnpm db:seed` |
| `Environment variable not found: DATABASE_URL` | 直接调了 `prisma`，没走包装脚本 | 用 `pnpm db:*` 系列命令 |
| `Could not find Prisma Schema` | Prisma CLI 的工作目录不对 | 同上；或 `pnpm db:doctor`（自带定位逻辑） |
| `@prisma/client did not initialize yet` | 没生成客户端 | `pnpm --filter @creatorops/api prisma:generate` |
| 大量 `TS2307` 模块找不到 | 同上，客户端未生成导致级联报错 | 同上，然后重跑 `pnpm -r typecheck` |
| `pnpm infra:up` 端口占用（5432） | 本机已装 PostgreSQL 且服务在运行 | 停掉本机服务，或改用 `pnpm db:setup` 走本机实例 |

> `pnpm db:nuke` 是**破坏性操作**：它会 DROP 并重建整个数据库。脚本会要求输入 `yes` 确认，
> 且会校验目标库名与 `.env` 的 `DATABASE_URL` 一致（防止误删别的库）。

---

## 6. 拉代码后如果只想做静态检查

不建库也能跑的部分（秒级出结果，不需要数据库）：

```bash
pnpm --filter @creatorops/api check:prisma-usage   # Prisma 模型/枚举名一致性
pnpm enum:check                                    # 前后端枚举一致性
pnpm -r typecheck                                  # 全量类型检查
node apps/web/scripts/static-check.mjs             # 前端静态一致性
```

CI 的完整关卡与命令见 [deployment.md §10](deployment.md)。
