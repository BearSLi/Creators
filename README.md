# CreatorOps · 达人合作管理平台

> 聚猩智媒内部达人合作全流程管理系统：把「找达人 → 谈合同 → 做内容 → 看数据 → 算钱 → 打款」这条链路，从散落的 Excel 与微信群，收进一个有权限、有留痕、有 AI 辅助的系统里。

**技术栈**：React 18 + TypeScript + NestJS 10 + PostgreSQL 16+ + Prisma 5

---

## 一、这个系统解决什么问题

聚猩智媒的核心业务是**达人孵化与内容商业化**：签约达人、生产短剧/剧情/种草内容、在抖音/小红书/B站/视频号（以及 TikTok/YouTube 等海外平台）分发，再与品牌方按效果或流水结算分成。这条链路在系统化之前的典型痛点：

| 业务痛点 | 现实后果 | CreatorOps 的做法 |
| --- | --- | --- |
| 达人信息散落在 Excel、微信、多个平台后台 | 同一个达人被两个商务重复触达，报价不一致 | 统一达人库 + 平台账号矩阵 + 负责人唯一归属 + 数据范围隔离 |
| 合同条款（分成比例、独家、账期）靠人记 | 结算时才发现「这份合同是 7:3 还是 6:4」，扯皮 | 合同内嵌分润规则，结算引擎直接读合同算钱，条款与金额强绑定 |
| 结算靠 Excel 手算，多级抽成 + 代扣税 | 尾差累积、口径不一，达人对账不信任 | 纯函数结算引擎，以「分」为单位的整数计算，金额守恒可复算，全链路留痕 |
| 内容数据靠人工截图登记 | 数据滞后、口径不一致，结算争议无证据 | 采集器统一入口 + 快照表按天唯一幂等 + 数据来源标记可信度 |
| 达人状态（线索/建联/签约/暂停/拉黑）靠口头同步 | 给「已解约」的达人排期、给「线索」出结算 | 状态机强制校验流转，非法流转直接拒绝并返回可选下一步 |
| 谁能看达人手机号、谁能改结算金额没有边界 | 敏感信息外泄、资金操作无复核 | RBAC + 数据范围 + 资源归属三级校验，资金操作双人复核 |
| 出了问题不知道谁改的 | 无法追责，也无法复盘 | 声明式审计埋点，写操作全覆盖（操作人/前后快照/IP/请求 ID） |
| AI 只是「玩具」，用了但说不清价值 | 无法判断该不该继续投入 | AI 任务全量落库（token/成本/耗时/采纳率）+ 预算熔断 + 降级可见 |

**一句话**：这不是一个 CRUD 演示项目，而是围绕「钱算得准、权管得住、事追得到」设计的业务系统。

---

## 二、技术栈与选型理由

| 层次 | 技术 | 为什么选它 |
| --- | --- | --- |
| 前端 | React 18 + TypeScript + Vite | 内部工具迭代速度优先；Vite 冷启动秒级 |
| 前端状态 | TanStack Query + React Context | 服务端状态（列表/详情/缓存失效）交给 Query，本地状态（登录态）用 Context，避免一个全局 store 装所有东西 |
| 前端图表 | ECharts | 中文生态好、运营看板常用图表类型齐全 |
| 后端 | NestJS 10 | 模块化 + 装饰器 + DI 天然适合「按业务域切模块」；守卫/拦截器正好承载鉴权与审计这类横切关注点 |
| ORM | Prisma 5 | 类型安全、迁移可审查；`withTransaction` 让资金类操作的事务边界清晰 |
| 数据库 | PostgreSQL 16+ | 事务与约束能力是资金系统的底线：唯一约束就是幂等保证，`Decimal` 就是金额正确性保证 |
| 校验 | class-validator + zod | DTO 层挡格式，zod 挡 AI 输出结构（LLM 返回也会缺字段） |
| 日志 | NestJS 内置 Logger | 结构化字段（level/context/message）+ 请求 ID 贯穿全链路。pino 已列入 `.env` 预留但**当前未接入**——为一个内部工具增加重日志依赖不划算 |

**刻意不引入的东西**（内部工具的成本意识）：微服务、消息队列中间件、GraphQL、UI 组件库、ORM 二级缓存。理由见 [docs/architecture.md](docs/architecture.md)「技术选型与取舍」。

> **关于 Redis**：`docker-compose.yml` 里有 redis 服务、`.env.example` 里有 `REDIS_URL`，但**当前没有任何代码读取它** ——
> 限流用 `@nestjs/throttler` 的进程内计数，定时任务用 `@nestjs/schedule` 的进程内调度。
> 本地不启 Redis 也能完整跑通，这两处是为将来引入分布式限流 / 队列 / 定时任务选主预留的。

---

## 三、整体架构

### 3.1 请求链路

```
浏览器 (React 18 + TanStack Query)
      │  /api/*（开发期由 Vite 代理，生产由 Nginx 反代）
      ▼
NestJS 全局装配（apps/api/src/bootstrap.ts）
      ├─ 中间件    requestId 注入 → 响应头 X-Request-Id、错误体、审计记录三处一致
      ├─ 全局管道  ValidationPipe + 空串规范化（表单未填的选填项按 undefined 处理）
      ├─ 全局守卫  JwtAuthGuard（认证）→ PermissionsGuard（功能权限）
      ├─ 拦截器    AuditInterceptor（写操作留痕）→ ResponseEnvelopeInterceptor（统一响应信封）
      └─ 异常过滤  AllExceptionsFilter（内部异常 → 稳定业务错误码，绝不外泄堆栈/SQL）
      ▼
业务模块（auth / creators / contracts / projects / contents / brands / settlements / ai / …）
      ▼
PrismaService（连接池、事务重试、慢查询日志） → PostgreSQL
```

### 3.2 分层与模块边界

- **Controller** 只做参数绑定与权限声明，不写业务判断；
- **Service** 承载业务规则与事务边界，通过 `PrismaService` 访问数据库；
- **共用层** `src/common/` 放横切能力（异常、过滤器、拦截器、DTO 工具、金额/加密/数据范围工具），不依赖具体业务模块；
- **可纯函数化的核心逻辑必须抽成纯函数**：结算引擎、各状态机、渲染器都不含 IO，因此可以被穷举测试。

### 3.3 全局装配为什么独立成 `bootstrap.ts`

`main.ts` 与 e2e 测试复用**同一份**全局配置，避免「测试环境能过、线上 500」这类因装配差异导致的问题。

### 3.4 三个贯穿全局的约定

1. **金额一律用整数「分」**，比率一律用**基点整数**（`1000` = 10%）—— 绝不用浮点；
2. **同一份事实只有一个来源**：枚举中文映射只在 `apps/web/src/utils/constants.ts`，页面里不得裸写英文枚举值；权限点只在 `apps/api/src/modules/auth/permissions.ts`；
3. **状态只能走状态机**：任何 `update({ status })` 都必须经过流转校验，非法流转返回 `allowedNext` 让前端渲染合法操作。

---

## 四、功能地图

```
CreatorOps
├── 经营看板         KPI / 达人合作漏斗 / 流水趋势 / 平台与垂类分布 / 头部达人 / 待办
├── 达人管理
│   ├── 达人库        多维筛选（关键词/状态/分级/垂类/平台/负责人/标签/粉丝区间）
│   ├── 达人详情      基本信息 / 平台账号矩阵 / 内容表现 / 合同 / 结算 / 状态流转 / 操作记录
│   ├── 新建编辑      含平台账号动态录入、标签、档期偏好
│   └── 综合评估      四维度加权打分（内容/商务/配合/数据）
├── 品牌管理         客户主数据、等级、账期、合同与项目汇总
├── 合同管理         拟定 → 提交审核 → 审批生效 → 续约/终止；分润规则；结算预估
├── 项目与内容       项目排期、内容生产流水线（选题→脚本→拍摄→剪辑→审核→发布→下线）
│   └── 数据采集      平台账号与内容数据同步（官方接口/第三方/截图/人工，来源可追溯）
├── 结算管理         按账期生成 → 提交 → 审批（双人复核）→ 打款 → 争议/作废；CSV 导出
├── AI 工作台        脚本生成 / 标题优化 / 达人匹配 / 评论洞察 / 合规预检 / 结算异常解释 / 运营日报
│   ├── Prompt 模板   版本化、灰度、不可就地篡改（保证历史可追溯）
│   └── 成本用量      预算占用、各类型成本与耗时、人工采纳率
├── 员工与权限       账号、角色、权限点、团队树、会话管理
└── 审计日志         全量写操作留痕、字段级 diff、按资源查看变更时间线
```

---

## 五、项目结构

```
creatorops/
├── apps/
│   ├── api/                        # NestJS 后端
│   │   ├── prisma/
│   │   │   ├── schema.prisma       # 数据模型（18 个模型 / 15 个枚举，含索引与约束设计）
│   │   │   ├── migrations/         # SQL 迁移（0_init 为初始建表基线）
│   │   │   └── seed.ts             # 业务自洽的演示数据（幂等）
│   │   └── src/
│   │       ├── bootstrap.ts        # 全局装配（管道/守卫/拦截器/过滤器），e2e 复用
│   │       ├── config/             # 环境变量校验（zod，启动即失败）
│   │       ├── common/             # 横切能力：异常、过滤器、拦截器、DTO 工具、金额/加密/范围工具
│   │       ├── prisma/             # PrismaService（连接池、事务重试、慢查询）
│   │       └── modules/
│   │           ├── auth/           # 认证 + RBAC 权限矩阵 + 数据范围
│   │           ├── ai/             # AI 能力层（Provider 抽象 / Prompt 模板 / 成本治理）
│   │           ├── settlements/    # 结算引擎（纯函数）+ 单据状态机
│   │           ├── creators/       # 达人 + 状态机 + 标签
│   │           ├── contracts/      # 合同 + 分润规则 + 结算预估
│   │           ├── projects/ contents/ brands/ users/
│   │           ├── dashboard/      # 经营看板聚合
│   │           ├── audit/          # 审计日志
│   │           ├── scheduler/      # 定时任务（结算生成、到期提醒、清理）
│   │           └── health/         # 存活/就绪探针
│   └── web/                        # React 前端
│       └── src/{api,auth,components,hooks,pages,styles,utils}
├── docs/                           # 架构、权限、API、部署、AI 规范等文档
├── scripts/                        # 数据库与一致性校验脚本
├── docker-compose.yml
└── .env.example
```

---

## 六、快速开始

### 前置条件

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 20.11 | `package.json` 的 `engines` 声明 |
| pnpm | ≥ 9 | `packageManager` 锁定 `pnpm@9.12.0`，`corepack enable` 可自动匹配 |
| PostgreSQL | 16+ | Docker 或本机安装皆可 |
| Redis | **不需要** | 当前代码没有任何地方读取 `REDIS_URL`（见 §二 说明） |

### 步骤

```bash
# 1) 安装依赖
pnpm install

# 2) 准备环境变量（模板里有全部可调参数与注释）
cp .env.example .env          # Windows: copy .env.example .env

# 3) 准备数据库（PostgreSQL 16+）
#    A. 用 Docker（注意：会占用宿主机 5432，与本机已装的 PostgreSQL 冲突）
pnpm infra:up
#    B. 用本机已装的 PostgreSQL（幂等，会询问 postgres 超级用户密码）
pnpm db:setup
#       也可手动执行（**必须指定 OWNER**，否则后续迁移会报属主错误 P3016）：
#         CREATE ROLE creatorops LOGIN PASSWORD 'creatorops' CREATEDB;
#         CREATE DATABASE creatorops ENCODING 'UTF8' OWNER creatorops;

# 4) 生成 Prisma 客户端
pnpm --filter @creatorops/api prisma:generate

# 5) 执行迁移建表（基线 0_init 已提交在仓库里）
pnpm db:deploy

# 6) 写入演示数据（幂等，可反复执行）
pnpm db:seed

# 7) 启动前后端（并行）
pnpm dev
```

> 不要用 `prisma migrate resolve --applied 0_init` 代替第 5 步 —— 它只把迁移**标记为已执行**，
> 不运行任何 SQL，会得到一个空库，紧接着 `db:seed` 报「表不存在」。仓库里
> `apps/api/prisma/migrations/0_init/migration.sql` 已经提交，直接 `pnpm db:deploy` 即可。

### 访问地址

| 服务 | 地址 |
| --- | --- |
| 前端 | http://localhost:5173 |
| 接口文档（Swagger） | http://localhost:3100/api/docs |
| 健康检查 | http://localhost:3100/api/health/ready |

### 演示账号

密码统一 `CreatorOps@2026`。

| 角色 | 账号 | 可用范围 |
| --- | --- | --- |
| 系统管理员 | `admin@juxingzhimei.com` | 全部权限，员工与角色管理 |
| 运营 | `ops@juxingzhimei.com` | 达人全生命周期、内容排期、结算生成（不能审批结算） |
| 商务 | `bd@juxingzhimei.com` | 品牌与合同（数据范围只含自己负责的达人） |
| 内容 | `content@juxingzhimei.com` | 内容生产与审核（看不到合同金额与结算） |
| 财务 | `finance@juxingzhimei.com` | 结算审批与打款（不能改达人资料） |
| 审计 | `audit@juxingzhimei.com` | 全量只读 + 审计日志（任何写操作都被拒绝） |

---

## 七、常用命令

```bash
# 开发
pnpm dev                   # 前后端并行
pnpm dev:api               # 仅后端（3100）
pnpm dev:web               # 仅前端（5173）

# 构建与检查
pnpm build                 # 全量构建
pnpm typecheck             # 全量类型检查
pnpm lint                  # 代码检查
pnpm test                  # 单元测试
pnpm test:e2e              # 端到端测试（需要数据库）
pnpm verify                # 提交前自查：enum:check + typecheck + test

# 数据库
pnpm db:setup              # 在本机 PostgreSQL 上创建角色与库（幂等）
pnpm db:deploy             # 应用迁移（生产/新机器用这个）
pnpm db:migrate            # 创建/应用迁移（开发环境）
pnpm db:seed               # 写入演示数据（幂等）
pnpm db:reset              # 重置数据库并重新初始化
pnpm db:doctor             # 检查迁移记录与表结构是否一致
pnpm db:sync-models        # 把数据库里 Prompt 模板的模型名同步为 .env 的配置
pnpm infra:up / infra:down # 启停容器化的 PostgreSQL（+ Redis，当前未使用）

# 前后端契约
pnpm openapi:export        # 导出后端 OpenAPI 规范到 docs/openapi.json
pnpm openapi:check         # 校验前端请求类型与规范是否一致
pnpm enum:check            # 校验前后端枚举取值是否一致
pnpm contract:verify       # = enum:check + openapi:export + openapi:check
```

---

## 八、环境变量

配置集中在**仓库根目录的 `.env`**（模板见 [.env.example](.env.example)，每一项都有注释）。应用自身能读到它，但 **Prisma CLI 不会往上找**，因此所有涉及 Prisma 的脚本都经 `scripts/with-env.mjs` 包装注入 —— 这也是为什么用 `pnpm db:deploy` / `pnpm db:seed` 而不是直接调 `prisma`。

启动时用 zod 强校验，不合法直接拒绝启动。需要关注的几项：

```bash
# 必填：服务启动时校验，缺失或格式不对会拒绝启动
DATABASE_URL=postgresql://creatorops:creatorops@localhost:5432/creatorops?schema=public
JWT_ACCESS_SECRET=...      # 至少 16 位；生产环境要求 ≥32 位且不能含 change-me/dev-only
JWT_REFRESH_SECRET=...     # 同上，且必须与 access 密钥不同

# 不配 Key 也能完整体验 AI 功能（mock provider 返回结构合法的确定性结果）
AI_PROVIDER=mock
# 未配置平台凭证时采集器走 mock 模式，返回可复现的仿真数据
COLLECTOR_MODE=mock

# 其余（端口、限流、日志、存储、账期、告警等）都有默认值，按需调整
```

> 切换到真实 AI Provider（`openai` / `anthropic` / `gemini` / `deepseek`）时必须同时提供对应的
> `*_API_KEY`，否则启动即失败。若同时改了模型名，记得执行 `pnpm db:sync-models` ——
> 生效的模型来自数据库里的 Prompt 模板记录，它优先于 `AI_DEFAULT_MODEL`。

---

## 九、核心设计要点

**1. 结算引擎：把「算钱」当成一个可以被证明正确的函数**
金额全程用「分」的整数与基点整数运算，绝不用浮点；关键不变量 `平台费 + 公司分成 + 达人分成 === 总流水` 在每次计算后断言，并有穷举 300+ 组合的属性式测试守护。尾差按「公司让利」原则归集给达人 —— 合作方对账时这一点比多赚几分钱重要得多。见 `apps/api/src/modules/settlements/settlement.calculator.ts`。

**2. 幂等不是口号，而是三层机制**
结算单 `(creatorId, periodStart, periodEnd)` 唯一约束 + 明细 `idempotencyKey` 唯一 + 已审批单据跳过。所以定时任务可以放心重复执行与补跑；AI 任务用 `idempotencyKey` 直接防住「用户狂点按钮重复扣费」。

**3. 权限三级校验，而不是「角色对不对」**
功能权限（能不能调接口）+ 数据范围（能看哪些行：商务只看自己负责的达人）+ 资源归属（这条数据是不是你的）。第三级在 Service 层显式调用，不依赖「列表接口已经过滤了」这种假设。

**4. 状态机集中定义，非法流转返回可选下一步**
达人与合同/项目/内容/结算都有状态机，非法流转 409 并返回 `allowedNext`，前端据此渲染按钮 —— 前后端不会因为「谁能从哪到哪」的理解不一致而出现灰色按钮或 500。

**5. 审计是横切能力，不靠人工埋点**
`@Audit({ action, resource })` 声明在 Controller 上，拦截器统一记录操作人、前后快照、IP、UA、请求 ID、耗时。密码/证件号/令牌自动脱敏 —— 审计日志本身不能变成新的泄露渠道。

**6. AI 被当成「有成本的外部依赖」来治理**
Provider 抽象（openai/anthropic/gemini/deepseek/mock）+ 超时与有限重试 + 失败降级且状态可见 + 预算熔断 + Prompt 版本化与灰度 + 输出 zod 校验 + 采纳率统计。mock provider 不是占位符，它按任务类型返回**结构合法且确定性**的结果，因此前端联调、CI 与离线演示都能真跑。

**7. 面向「业务真的会用」的设计**
达人状态变更必须填原因、合同生效中禁止改分润条款、已发布内容禁止改标题、删除达人前检查业务链路、结算审批需要双人复核 —— 这些约束都在拦住「图省事但会留下烂账」的操作。这类约束恰恰是内部工具能否长期活下去的关键。

---

## 十、已知限制与后续演进

诚实地列出当前边界（详见 [docs/architecture.md](docs/architecture.md)）：

1. **平台数据采集为适配器骨架**：真实接入抖音/小红书开放平台需要企业资质与逐平台联调。`HttpCollectorDriver` 提供了鉴权、超时、重试、错误转换的完整骨架，`MockCollectorDriver` 返回可复现的仿真数据用于联调与演示。
2. **账号级手动采集端点缺失**：当前只有内容级 `POST /api/contents/:id/sync-metrics`。账号级采集已由每日定时任务（06:30）批量执行，手动触发端点尚未暴露，前端相应按钮会如实提示「接口未开放」。
3. **下拉候选接口缺失**：达人/品牌筛选目前需输入 UUID，未提供「按关键词返回候选列表」的轻量接口。万级达人下不宜拉全量拼下拉，需要专门的搜索接口。
4. **文件存储默认落本地磁盘**：已抽象 `STORAGE_DRIVER`（local/s3），生产建议切对象存储。
5. **定时任务单实例假设**：多实例部署需要选主（Redis 锁）或独立 worker 进程，方案见部署文档。
6. **敏感字段密钥轮换未完成**：证件号已用 AES-256-GCM 加密，密文带 `v1` 前缀为轮换预留，双读迁移方案在文档中。
7. **未接入真实支付通道**：打款为「人工打款 + 凭证回填」，符合内部工具现状，不越界做资金通道。
8. **限流基于内存**：多实例部署时实际阈值 = 配置值 × 实例数，生产应改用 Redis 存储。
9. **构建与部署链路尚未完整验证**：生产构建、容器化全栈启动、CI 流水线未在真实环境跑通；`apps/api/Dockerfile` 缺失。当前验证状态见 [docs/engineering-notes.md §3](docs/engineering-notes.md)。

---

## 十一、文档索引

**① 设计与规范**

| 文档 | 内容 |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | 分层与模块边界、关键链路时序、技术选型取舍、并发与幂等、已知限制 |
| [docs/data-model.md](docs/data-model.md) | 18 张表的实体关系、金额与比率约定、内容/项目状态机、索引设计意图、一致性约束汇总 |
| [docs/permissions.md](docs/permissions.md) | 三级校验模型、角色数据范围、39 个权限点全矩阵、敏感信息处理、新增权限点清单 |
| [docs/api.md](docs/api.md) | 响应信封、错误码表与 `fieldErrors` 契约、数据格式约定、完整接口清单、前端请求层要求 |
| [docs/ai-guidelines.md](docs/ai-guidelines.md) | AI 架构约定、Prompt 编写规范与可复用模板库、AI 使用红线 |
| [docs/getting-started.md](docs/getting-started.md) | 陌生机器上的完整运行手册：前置检查、逐项配置、命令顺序、验证清单 |

**② 工程与运维**

| 文档 | 内容 |
| --- | --- |
| [docs/deployment.md](docs/deployment.md) | 环境变量、本地/Docker/PM2+Nginx 部署、迁移流程与基线、监控告警、备份恢复、CI 流水线 |
| [docs/code-review-checklist.md](docs/code-review-checklist.md) | 代码审查清单（资金、边界、安全、状态机、事务、跨边界一致性、前端专项） |
| [docs/engineering-notes.md](docs/engineering-notes.md) | 工程记录：跨边界一致性校验的设计与由来、真实缺陷复盘、当前验证状态与自查方式 |

**③ 方案与规划**

| 文档 | 内容 |
| --- | --- |
| [docs/product-plan.md](docs/product-plan.md) | 产品建设方案：为什么值得做、要投多少、多久见效、什么情况下该停；含 AI 能力方案与度量体系 |
| [docs/roadmap.md](docs/roadmap.md) | 迭代路线图：Phase 0–3 排序与理由、优先级总表、度量仪表盘、风险登记册 |
| [docs/project-review.md](docs/project-review.md) | 独立复盘：结论摘要与评分、业务链路拆解、亮点、风险与不足 |

**④ 评审材料与生成物**

| 文档 | 内容 |
| --- | --- |
| [docs/tech-review-package.md](docs/tech-review-package.md) | 技术评审材料：议程、证据分级、阻断项、逐项检查清单、待决策开放问题 |
| [docs/openapi.json](docs/openapi.json) | 自动导出的 OpenAPI 规范（62 接口 / 41 模型）。**由 `pnpm openapi:export` 生成，不要手工编辑** |

---

## 十二、许可

内部项目。演示数据均为虚构，请勿用于生产环境。
