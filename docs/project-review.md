# CreatorOps 项目拆解（AI 产品经理视角）

> 本文是一次**外部视角的项目复盘**，不是设计文档。已有文档说明「代码为什么长这样」，本文回答另一个问题：
> **这个项目在业务上解决了什么、技术栈与框架是怎么搭起来的、哪些地方真正值得称道、哪些地方还不能对外宣称完成。**
>
> 阅读对象：产品经理、技术评审人、面试官、新加入的同事。
> 写作方式：所有结论均来自对仓库源码与 `docs/` 的实际阅读，凡属推断均标注「推断」，凡属未验证均标注「未验证」。

---

## 0. 结论摘要（先看这一节）

| 维度 | 评分 | 依据 |
| --- | --- | --- |
| 产品建模 | A | 合同即分润参数、内容即结算最小单元、生命周期即状态机 |
| 资金正确性 | A+ | 纯函数结算引擎 + 守恒断言 + 三层幂等；`docs/architecture.md` §4.1/4.2 |
| 权限与审计 | A | 三级校验（功能权限 / 数据范围 / 资源归属）+ 声明式审计全覆盖 |
| AI 治理 | A | 成本熔断 + 采纳率闭环 + 结构化校验 + 降级可见 + 明确红线 |
| 可验证性 | B | 后端/前端类型检查、枚举一致性、枚举校验脚本自检**已实测通过**；单元测试与 e2e 在受限沙箱内无法执行（`esbuild` 需 spawn 子进程），需在正常环境复跑（README §11） |

**一句话结论**：这个项目的核心竞争力不在"用了多少技术"，而在于把**「钱算得准、权管得住、事追得到」**这三个内部工具的生死线，做成了可被断言、可被穷举测试、可被复算复现的工程机制；而它对 AI 的态度尤其成熟——**AI 是有成本、会出错、必须被度量的外部依赖，只做建议与加速，绝不碰钱的判断权和数据事实**。

**最需要提醒的一点**：下面 §8「风险与不足」里仍有若干条**未在正常环境验证**的项（`pnpm install` / `prisma generate` / `vitest` / `vite build` 在本审查环境无法执行）。在正常环境跑通 `pnpm verify && pnpm build && pnpm test:e2e` 之前，任何"已完成"的对外表述都应加上限定。

**本次复审新增的关键发现**：项目里存在两个**比业务 bug 更严重**的问题——①前端的 `typecheck` 脚本**实际检查 0 个文件**却一直报 0 error；②前端手写的 15 个枚举里 **9 个与后端 `schema.prisma` 不一致**。详见 §7.1 第 11 条。两者都已修复，并已把这一类问题固化成机械可检的 `pnpm enum:check`（自带 `--self-test`）。

---

## 1. 项目定位

**一句话定位**：把「找达人 → 谈合同 → 做内容 → 看数据 → 算钱 → 打款」这条链路，从散落的 Excel 与微信群，收进一个有权限、有留痕、有 AI 辅助的系统。（`README.md`）

**PM 视角的判断**：这个项目的真实定位不是"达人管理系统"，而是**内容分润的资金结算中台**。理由：

- 达人库、内容排期这类能力行业内供给充分，差异化低；
- 项目把最重的设计成本压在了结算引擎、合同分润规则、幂等与审计上（`settlement.calculator.ts` 240 行 + `settlement.service.ts` 753 行，共约 1000 行，是单模块中最重的，且配有全项目最严格的属性式穷举测试）；
- 说明产品要解决的核心矛盾是**"钱算得准不准、权管不管得住、事追不追得到"**，达人管理只是它的上游数据入口。

**业务主体**：聚猩智媒（达人孵化与内容商业化：签约达人 → 生产短剧/剧情/种草内容 → 抖音/小红书/B站/视频号（及 TikTok/YouTube 等海外平台）分发 → 与品牌方按效果或流水结算分成）。

---

## 2. 业务链路拆解：一条内容分润价值链

```
招募/线索 → 建联评估 → 签约(合同=分润参数) → 排期生产 → 发布 → 数据采集 → 按账期结算 → 审批 → 打款
  Creator    Creator      Contract          Project    Content   Metrics    Settlement  Approve  Pay
   状态机      状态机      区间唯一+审批       预算/毛利   结算最小单元  快照幂等     金额守恒+留痕  双人复核  凭证回填
```

### 2.1 痛点 → 对策映射（README §1 的浓缩）

| 业务痛点 | 现实后果 | CreatorOps 的做法 |
| --- | --- | --- |
| 达人信息散落 Excel/微信/平台后台 | 同一达人被两个商务重复触达、报价不一致 | 统一达人库 + 账号矩阵 + 负责人唯一归属 + 数据范围隔离 |
| 合同条款靠人记 | 结算时才发现"是 7:3 还是 6:4"，扯皮 | 合同内嵌分润规则，结算引擎直接读合同算钱 |
| 结算靠 Excel 手算，多级抽成 + 代扣税 | 尾差累积、口径不一、达人对账不信任 | 纯函数结算引擎，以「分」为整数计算，金额守恒可复算 |
| 内容数据靠人工截图登记 | 数据滞后、争议无证据 | 采集器统一入口 + 快照按天唯一幂等 + 数据来源标记可信度 |
| 达人状态靠口头同步 | 给已解约的达人排期、给线索出结算 | 状态机强制校验，非法流转返回 `allowedNext` |
| 敏感信息与资金操作无边界 | 信息外泄、资金操作无复核 | RBAC + 数据范围 + 资源归属三级校验，资金操作双人复核 |
| 出了问题不知道谁改的 | 无法追责与复盘 | 声明式审计，写操作全覆盖 |
| AI 用了但说不清价值 | 无法判断该不该继续投入 | AI 任务全量落库 + 预算熔断 + 降级可见 + 采纳率统计 |

### 2.2 三个决定系统形态的产品建模洞察

1. **合同不是文档，是结算引擎的参数源。** `Contract` 直接存 `platformFeeBp / agencyShareBp / talentShareBp / taxWithholdBp / tieredShares`；结算时读合同字段。且**生效中的合同禁止修改分润条款**——要变更必须终止后重签，保留完整历史。
2. **内容（Content）是结算与数据归因的最小单元。** 一条内容只在一个账期结算一次（按发布月归因），`revenueCents` 与 `conversions` 就是结算引擎的输入。
3. **合作生命周期是状态机，不是自由字段。** 达人 8 态，非法流转直接 409 并附可选下一步——于是"给已解约的达人排期""给线索出结算单"在系统里根本走不通。

---

## 3. 功能架构：六大业务域 + 支撑面

| 域 | 关键能力 | 产品设计要点 |
| --- | --- | --- |
| 经营看板 | KPI、达人合作漏斗、流水趋势、平台与垂类分布、头部达人、待办 | 只读聚合，不被任何模块依赖，可随时替换为缓存实现 |
| 达人管理 | 达人库（8 维筛选）、平台账号矩阵、四维评估打分、状态流转、分配负责人、批量导入 | 负责人唯一归属 + 数据范围隔离；`code` 业务编号（`CR-2026-000123`）便于口头沟通与合同引用 |
| 品牌与合同 | 品牌主数据、合同拟定→审核→生效→续约/终止、分润规则、**结算预估** | 区间冲突在提交与审批时双重校验；独家条款冲突校验；结算预估与正式结算共用同一引擎 |
| 项目与内容 | 项目排期、内容流水线（选题→脚本→拍摄→剪辑→审核→发布→下线）、数据采集 | 排期看板/表格双视图；`complianceScore` 留档以备平台抽检 |
| 结算管理 | 按账期生成→提交→审批（双人复核）→打款→争议/作废，CSV 导出 | 金额冻结规则、明细完整性闸门、`calculationTrace` 逐笔留痕 |
| AI 工作台 | 7 类任务、Prompt 模板版本化 + 灰度、成本用量与采纳率 | 见 §6 |
| 支撑面 | 员工与权限（角色/权限点/团队树/会话）、审计日志（字段级 diff）、通知 | 39 个权限点、三级校验、写操作审计全覆盖 |

**7 类 AI 任务全部嵌在业务流程节点上**，而非独立"AI 聊天页"：

| 任务类型 | 嵌入节点 | 输出结构 |
| --- | --- | --- |
| `SCRIPT_GENERATE` | 内容生产 | `{ title, hook, scenes[], hashtags[], risks[] }` |
| `TITLE_OPTIMIZE` | 发布前 | `{ candidates[] }` |
| `CREATOR_MATCH` | 建联 | `{ matches[], strategy }` |
| `COMMENT_INSIGHT` | 发布后 | `{ sentiment, topTopics[], replyTemplates[] }` |
| `COMPLIANCE_CHECK` | 审核前 | `{ score, level: PASS/WARN/REJECT, flags[] }` |
| `SETTLEMENT_ANOMALY` | 对账 | `{ conclusion, evidence[], suggestion }` |
| `DAILY_BRIEF` | 管理 | `{ headline, highlights[], risks[], tomorrowFocus[] }` |

---

## 4. 技术栈

| 层 | 技术 | 选型理由（源自 `README.md` §2 / `docs/architecture.md`） |
| --- | --- | --- |
| 前端框架 | **React 18 + TypeScript + Vite 5** | 内部工具迭代速度优先；Vite 冷启动秒级 |
| 前端状态 | **TanStack Query v5**（服务端状态）+ **React Context**（跨页少数全局态） | 明确拒绝"一个全局 store 装所有东西" |
| 前端图表 | **ECharts 5**（按需注册 + `manualChunks` 独立分包） | 中文生态好、运营看板图表类型齐全 |
| 前端 UI | **零第三方组件库**：18 个自研组件 + `tokens.css`(153 行) + `global.css`(717 行) + CSS Module | 设计令牌更贴合业务表格/表单密度，且无升级负担 |
| 路由 / 请求 | React Router 6（21 页全 `lazy()`）+ Axios | 路由层即权限边界 |
| 后端框架 | **NestJS 10** | 模块化 + 装饰器 + DI 天然适合按业务域切模块；守卫/拦截器正好承载鉴权与审计 |
| ORM | **Prisma 5** | 类型安全、迁移可审查；`withTransaction` 让资金类操作的事务边界清晰 |
| 数据库 | **PostgreSQL 16** | 事务与约束是资金系统的底线：唯一约束即幂等保证，`Decimal` 即金额正确性保证 |
| 缓存 / 队列 | **Redis 7**（ioredis，限流 / 任务） | 刻意不用 Redis 存业务真相，避免"缓存与库不一致" |
| 校验 | **class-validator**（DTO）+ **zod**（AI 输出 + 环境变量 + Prompt 变量） | DTO 挡格式，zod 挡"LLM 返回也会缺字段" |
| 认证 | Passport JWT：access 2h + refresh 14d（只存 sha256 哈希，轮换 + family 重放检测）+ bcrypt(12) | 不每次查库，靠短有效期 + 权限内嵌保证性能 |
| 日志 / 监控 | **pino**（结构化 JSON）+ 请求 ID 贯穿 + Terminus 双探针 | 存活/就绪分离，避免 DB 抖动导致容器反复重启放大故障 |
| 文档 | `@nestjs/swagger`（仅非生产环境开放） | |
| 测试 | **Vitest 2**（单测 + e2e） | |
| 工程 | pnpm 9 workspace、Docker Compose、**GitHub Actions 四道关 CI** | 见 §7.3 |

### 刻意不引入的技术（附触发条件，这是成熟度信号）

| 没引入 | 理由 | 什么情况下才该引入 |
| --- | --- | --- |
| 微服务 | 内部工具团队规模小，分布式事务与联调成本远大于收益 | 模块由不同团队独立发布、且需要独立扩缩容时 |
| 消息队列 | 当前唯一异步场景是定时任务与采集，`@nestjs/schedule` 足够 | 需要削峰（批量导入十万级）、事件驱动多消费者时 |
| GraphQL | 前端页面与接口基本一对一，REST 更易缓存、易排错 | 多端（Web/App/小程序）需要差异化字段裁剪时 |
| UI 组件库 | 设计令牌 + 手写组件更贴合业务表格/表单密度需求 | 需要大量复杂交互组件（富文本、虚拟表格）时 |
| ORM 二级缓存 | 缓存与库不一致是资金系统的灾难来源 | 只读报表类接口成为瓶颈时，用物化视图而非二级缓存 |

---

## 5. 整体框架

### 5.1 分层总览

```
① 表现层   React 18 SPA（21 页，全 lazy，逐页声明权限）
             api/ 13 个领域模块 · auth/ (AuthContext + ProtectedRoute) · components/ 18 个
             hooks/ (useTableQuery / usePermission / useDebounce) · styles/ (tokens + global) · utils/
② 网关层   Nginx（生产）：SPA history fallback · /api 反代 · TLS 终止 · 静态资源长缓存
③ 应用层   NestJS 10 —— 13 个业务域模块 + 三层横切（守卫 / 拦截器 / 过滤器）
④ 数据层   Prisma 5 → PostgreSQL 16（唯一业务真相） / Redis 7（限流 · 任务）
⑤ 外部依赖 AI Provider（openai / anthropic / gemini / deepseek / mock）
             平台数据源（抖音 / 小红书 / B站 / 视频号 / TikTok / YouTube …，可 mock）
```

规模基线（实测）：后端 `apps/api/src` 88 个源文件 / 约 13385 行；前端 `apps/web/src` 64 个 `.ts|.tsx` / 约 19603 行；`schema.prisma` 18 个模型 / 15 个枚举。

### 5.2 后端模块依赖方向（有明确约束）

```
common（CodeGenerator）
   ├─ auth · creators · brands · users · ai         ← 基础域；ai 不依赖任何业务模块
   │        └──── contracts                          ← 分润规则的法律载体
   │                └──── projects / contents ◄── ai（合规预检 / 脚本生成）
   │                          └──── settlements      ← 定时任务也从此进入（同一段代码）
   │                                    └──── dashboard（只读聚合，不反向依赖）
   └─ 横切：audit（@Global）· health
```

**四条被明确写下来的依赖铁律**（`docs/architecture.md` §2）——这是框架里最值钱的部分：

1. `settlements` 依赖 `contracts` / `contents` 的**数据模型**，但**不依赖它们的 Service**：结算只读已固化的金额字段，避免"结算时再触发采集"这类隐性耦合。
2. `scheduler` 依赖 `settlements` 而不是自己实现一套结算逻辑：**手动与自动必须走同一段代码**，否则两套实现的口径分歧是必然的。
3. `dashboard` 只读，不被任何模块依赖，可随时替换成缓存实现而不影响业务。
4. `ai` 不依赖任何业务模块（只接收业务传入的数据），业务模块按需依赖 `ai`，保持 AI 能力可插拔。

外加两条分层规则：**Service 是唯一可以访问 Prisma 的地方**；**跨模块调用走 Service，不直接读对方的表**（否则"达人软删除"这类规则会被绕过）。

### 5.3 横切关注点（全局注册，业务代码无感知）

```
请求 ID 中间件        —— 贯穿日志/错误/审计，排查第一抓手
Helmet + CORS         —— 安全响应头与来源白名单
ValidationPipe        —— whitelist + forbidNonWhitelisted（防客户端注入 ownerId/status）
ThrottlerGuard        —— 全局限流，登录接口单独收紧
JwtAuthGuard          —— 默认拒绝，@Public() 显式放开
PermissionsGuard      —— 权限点校验（能不能调这个接口）
AuditInterceptor      —— @Audit() 声明式审计，写操作全覆盖
ResponseEnvelope      —— 统一 { success, data, requestId }
AllExceptionsFilter   —— 异常 → 稳定错误码，不泄露堆栈与 SQL
```

装配集中在 `apps/api/src/bootstrap.ts` 而非 `main.ts`，**原因是 e2e 测试要复用完全相同的配置**，否则"测试环境能过、线上 500"无法避免。

### 5.4 数据模型（18 模型 / 15 枚举，约 16 张业务表）

全局设计原则：

- **金额 `Decimal(18,2)` 存储，计算全转「分」整数；比率用基点（bp）整数**（`1000` = 10%），绝不用浮点；
- **全表软删除**（`deletedAt`）+ 审计字段（`createdAt/updatedAt/createdById`）；
- **枚举落库为字符串**，便于 DBA 直读与报表 SQL；
- **唯一业务约束交给数据库**（应用层判重存在竞态）。

数据库层面的硬约束（应用层绕过也会被拦住）：

| 约束 | 作用 |
| --- | --- |
| `Settlement @@unique([creatorId, periodStart, periodEnd])` | 防重复出账（最严重的资金事故） |
| `SettlementItem.idempotencyKey @unique` | 防明细重复生成 |
| `MetricsSnapshot @@unique([accountId, statDate])` | 采集幂等（同日重复采集只 upsert） |
| `PlatformAccount @@unique([platform, platformUid])` | 账号不重复录入 |
| `AiTask.idempotencyKey @unique` | 防重复扣费 |
| `Notification @@unique([userId, dedupeKey])` | 同一业务事件不重复提醒 |
| `Contract.creatorId → onDelete: Restrict` | 有合同的达人不能被物理删除 |

**`code_sequences` 表刻意不走 Prisma 模型**，而是手写 SQL 迁移（`prisma/migrations/20260101000000_init_code_sequences/`）：

- **为什么不用 PG `SEQUENCE`**：业务编号需按"资源类型 + 年份"重置（`CR-2026-000123`），SEQUENCE 按对象全局递增，每年要新建一堆序列；
- **为什么不用 `count(*) + 1`**：存在并发读-改-写竞态，且软删除后计数不连续会撞唯一索引；
- **实现**：`INSERT ... ON CONFLICT (scope) DO UPDATE SET value = value + 1 RETURNING value`，原子自增，**必须与业务写入在同一事务内**（业务失败编号回滚，不留空洞）。

### 5.5 关键链路一：结算生成（资金链路）

```
定时任务(每月 3 日 02:00) / 运营手动点击
        │
        ▼
SettlementService.generate(period)
        ├─ ① resolvePeriod：账期固定为自然月
        ├─ ② 拉候选达人（SIGNED/ACTIVE/PAUSED/TERMINATED）
        └─ for each creator（逐个独立事务，单人失败不影响全局）
              ├─ assertCanBeSettled(状态)            ← 不满足记入 skippedReasons
              ├─ 查该账期是否已有结算单               ← 幂等第 1 层
              ├─ 查账期内生效的合同
              │     ├─ 0 份 → 跳过
              │     └─ ≥2 份 → 抛错并说明冲突合同     ← 口径歧义必须人工解决，不能猜
              ├─ 拉归因载体：账期内发布、有收入、尚未结算的内容
              │     └─ settlementItems: { none: {} }  ← 幂等第 2 层
              ├─ 逐笔 calculateSettlement()（纯函数）
              └─ 单事务写入：编号 → 单据 → 明细(skipDuplicates) → calculationTrace
```

**为什么这么设计**：

- **逐人独立事务**：500 个达人里若有 3 个数据异常，不应让 497 个也结不出来；
- **失败收集成 `skippedReasons`**：运营能看到"谁没结、为什么没结"，而不是一个笼统的 500；
- **合同冲突直接报错**：两份合同同时生效时任何自动选择都是猜，猜错就是真金白银的错；
- **`calculationTrace` 落库**：半年后达人质疑某笔金额时，能拿出当时的完整计算链路。

### 5.6 关键链路二：AI 任务执行

```
POST /api/ai/tasks
  ①  idempotencyKey 命中 → 直接返回既有结果（不重复扣费）
  ②  取该任务类型的可用 Prompt 模板（版本倒序 + 灰度筛选）
  ③  变量校验（缺失必填变量直接报错，不消耗 token）
  ④  渲染 Prompt（自研极简渲染器：不做表达式求值，单变量长度上限）
  ⑤  预算预检（估算成本 + 本月已用 > 预算 → 402 明确告知）
  ⑥  落库 RUNNING（保留渲染后的完整 Prompt，便于复现）
  ⑦  调主 Provider
        ├─ 可重试错误（超时/限流/5xx）→ 指数退避 + 抖动重试（默认 2 次）
        └─ 不可重试（鉴权/参数）→ 立即失败
  ⑧  主 Provider 最终失败 → 降级备用 Provider
        └─ 成功则状态记为 FALLBACK_USED 并写明降级原因（前端会提示用户）
  ⑨  解析输出：抽取 JSON（容忍 ```json 包裹）→ zod 结构校验
        ├─ 解析失败 → FAILED + 保留原文（INVALID_OUTPUT）
        └─ 结构不符 → FAILED + 列出不符字段（SCHEMA_MISMATCH）
  ⑩  回写结果、token、成本（分）、耗时、重试次数、finish_reason
        └─ finish_reason=length 说明被截断，会告警建议调高 maxTokens
```

### 5.7 关键链路三：认证与令牌刷新

```
登录 ──► access token (2h, 内嵌权限集合) + refresh token (14d, 只存 sha256 哈希)
业务请求 ──► JwtAuthGuard（不查库，靠短有效期 + 权限内嵌保证性能）
401 ──► 前端用 refresh token 换新令牌（并发去重，只刷新一次）
        ├─ 校验库中记录：存在/未撤销/未过期/family 一致
        ├─ 轮换：撤销旧 token，签发新 token，记录 replacedByTokenId
        └─ 若旧 token 被二次使用 → 判定泄露 → 撤销整个 family 并强制重登
```

**为什么不每次请求查库校验权限**：鉴权查询会成为最高频查询，QPS 高时拖垮数据库。代价是最长 2 小时的权限滞后，用两个手段弥补：① refresh 时查库校验账号状态；② 敏感操作（审批/打款/改权限）在 Service 层额外做一次实时权限复核。

### 5.8 权限模型：三级校验

```
第 1 级 功能权限（PermissionsGuard）  「这个角色能不能调用这个接口」
        实现：Controller 上 @RequirePermissions(PERMISSIONS.CREATOR_DELETE)
        失败：403 PERMISSION_DENIED
第 2 级 数据范围（buildScopeFilter）  「能看/能改哪些行的数据」
        规则：ALL / TEAM / OWN；商务只看自己负责的达人
第 3 级 资源归属（assertOwnership）    「这一条具体数据是不是你的」
        为什么不能省：列表接口过滤了 ≠ 详情接口安全；
        攻击/误操作路径是"猜一个别人的 UUID 直接访问详情"
```

**39 个权限点**、6 个角色（SUPER_ADMIN / OPERATIONS / BD / CONTENT / FINANCE / AUDITOR）、权限矩阵全表见 `docs/permissions.md`。几个刻意的设计取舍：

- **运营能生成结算但不能审批**：生成是操作动作，审批是资金动作，分离两者是内控基本要求；
- **财务不能改达人资料与内容**：财务只需核对金额，不该有篡改业务事实的能力；
- **审计没有任何写权限**：有单元测试强制守护（扫描 AUDITOR 权限集合中是否出现 `write/delete/approve/pay/generate/edit/manage/config/run` 类权限）；
- **用户级 `permissionOverrides`** 支持临时授予与撤销（`-settlement:pay`），**撤销优先于授予**。

### 5.9 定时任务一览

| Cron | 任务 | 名称 |
| --- | --- | --- |
| `0 30 6 * * *` | 每日平台账号 + 内容数据采集 | `daily-metrics-sync` |
| `0 2 3 * *` | **月度结算批量生成** | `monthly-settlement` |
| `0 30 9 * * *` | 合同到期提醒 | `contract-expiry-reminder` |
| `0 0 10 * * *` | 账期超期未打款提醒 | `settlement-due-reminder` |
| `0 0 11 * * *` | 内容审核超时提醒 | `content-review-reminder` |
| 每月 1 日 00:00 | 审计日志清理 | `audit-log-purge` |

---

## 6. AI 应用治理（AI PM 最该看的一节）

### 6.1 核心立场

> **AI 是「有成本的外部依赖」，不是功能装饰。**

`docs/ai-guidelines.md` 给出的硬性判断标准：

> 一个 AI 能力只有在「有人真的在用（采纳率可查）」且「单位成本可接受（成本可查）」时才值得保留。

因此每个 AI 任务都落库 token、成本、耗时与**人工反馈**，`GET /api/ai/usage` 直接回答三个问题：**花了多少 / 花在哪类任务 / 人工采纳率多少**。

### 6.2 四层架构

```
业务模块（contents / creators / settlements / dashboard）
        │  只调用这一个入口
        ▼
AiTaskService.execute(user, { taskType, input, idempotencyKey })
        ├── PromptTemplateService   取模板（版本 + 灰度）
        ├── prompt-renderer.ts      渲染变量（纯函数、无表达式求值、长度上限）
        ├── 预算与成本治理           月度预算熔断 + 成本落库（分）
        ├── AiProviderRegistry      选择 Provider + 降级
        │        └── providers/{openai, anthropic, gemini, deepseek, mock}
        └── zod OUTPUT_SCHEMAS      结构化输出校验
```

`AiProvider` 接口只暴露 `name` / `isConfigured()` / `complete()` 三个成员，错误统一为 `AiProviderError`（带 `code` 与 **`retryable` 标志**：超时与限流可重试，鉴权失败重试无意义）。不用厂商 SDK 而直接用 fetch 的原因：内部工具不值得为每个厂商引入一个重依赖，且 HTTP 更易统一实现超时与重试。

### 6.3 硬性规则（`docs/ai-guidelines.md` §2.2）

| 规则 | 说明 |
| --- | --- |
| 业务代码不得直接 import 任何厂商 SDK 或 provider | 只能通过 `AiTaskService`，否则成本治理与降级逻辑会被绕过 |
| 每次调用必须落库 | 输入、渲染后完整 Prompt、输出、token、成本、耗时、重试次数、`finish_reason` |
| 写入业务页面前必须结构化校验 | LLM 会"看起来正确"地返回缺字段 JSON，写库后前端才炸 |
| 传给模型的数据必须最小化 | 传达人身份证号给模型是重大合规事故 |
| 必须支持 mock | CI 与演示环境不得依赖真实 API |
| 必须有降级路径 | 降级要状态可见（`FALLBACK_USED`），不能静默 |
| 必须设置超时 | 用 `AbortController` 真正释放连接，而非 `Promise.race`（后者只是不再等待） |
| 只对可重试错误重试 | 超时/限流/5xx 重试（指数退避 + 抖动）；鉴权/参数错误立即失败 |
| **不得把模型输出当作事实写回数据库的关键字段** | 例如不得用 AI 直接改写结算金额、达人状态、合同条款 |

### 6.4 成本治理的三个抓手

1. **幂等**：`idempotencyKey` 数据库唯一约束，前端重复点击不会重复扣费——这是 AI 成本治理里最容易被忽略、也最烧钱的一项。
2. **熔断**：月度预算（`AI_MONTHLY_BUDGET_CNY`）用尽时拒绝新任务（**HTTP 402 + 明确文案**，而非笼统 500），由管理者决定是否调高。`AI_PROVIDER=mock` 时不校验预算（mock 不产生费用，否则"预算已满"场景无法演示）。
3. **可观测**：每任务的 token / 成本（分）/ 耗时 / 重试次数 / 采纳率都落库；成本以"分"存整数，避免浮点累计误差。

### 6.5 为什么 Prompt 放在数据库而不是代码里（`docs/architecture.md` §4.3）

Prompt 是**运营资产**，迭代频率远高于代码。放库里可以：版本化（效果变差可回滚）、灰度（`rolloutPercent`）、无发布迭代（运营自己改）。

配套约束：**已被任务使用过的模板禁止就地修改 Prompt 内容，必须新建版本**——否则历史任务的 `templateId` 指向同一行却对应两套 Prompt，事后无法复盘。

**灰度用确定性哈希分流**而非随机，便于对比效果而不引入不可复现的问题。

### 6.6 自研 Prompt 渲染器：一个主动的安全决策

需求只有「占位符替换 + 长度约束」，却刻意不引入 handlebars / mustache，原因写在代码注释里：

> 引入模板引擎会让 Prompt 内容能被注入逻辑，而 Prompt 属于运营可编辑内容，存在被写入恶意模板表达式执行的风险面。

安全约定：**不做任何表达式求值**；未知变量保持原样输出（便于发现模板写错，而非静默变空）；单变量长度上限可控（防止把整张表塞进 Prompt 造成 token 爆炸与成本失控）；缺失必填变量直接报错并列出缺哪些。

### 6.7 Mock Provider 是产品级设计，不是占位符

`MockAiProvider` 按任务类型返回**结构合法且确定性**的结果（用输入哈希 FNV-1a 做种子），并模拟 30–120ms 网络延迟以让前端 loading 态与超时逻辑能被真实验证。因此它真正支撑了四件事：前端联调（结构必须能渲染）、集成测试（不依赖外部模型的不确定性）、客户演示（无网无 Key）、CI（不花钱）。

---

## 7. 亮点

### 7.1 工程亮点

1. **把"算钱"做成一个可被证明正确的纯函数。** `settlement.calculator.ts` 无任何 IO，关键不变量 `平台费 + 公司 + 达人 === 总流水` 在每次计算后断言。精妙处在于**公司分成用"净额 － 达人分成"反推，而不是独立相乘**——这样守恒恒等成立，从数学上消除了"三笔加起来比总流水少一分"的经典问题。尾差按"公司让利"归集给达人（达人分成向上取整、平台费向下取整），理由是"合作方对账时，少一分钱和被少一百块钱的信任伤害是一样的"。
2. **幂等是三层机制而非口号。** 数据库唯一约束 + 明细 `idempotencyKey` + 已审批跳过。所以定时任务可以放心补跑、重跑；AI 任务用 `idempotencyKey` 直接防住"用户狂点按钮重复扣费"。
3. **权限是三级校验，而不是"角色对不对"。** 第三级在 Service 层显式调用，代码注释直说"列表接口过滤了 ≠ 详情接口安全，攻击路径是猜 UUID 直接访问详情"。
4. **审计是横切能力，不靠人工埋点。** `@Audit()` 声明在 Controller，拦截器统一记录操作人/前后快照/IP/UA/requestId/耗时/成功与否，密码令牌证件号自动脱敏。并且**审计写失败只记应用日志、不回滚业务**——代价与收益写得很清楚（若合规要求 100% 不丢，应改为写本地文件/Kafka 后异步入库）。
5. **401 并发去重刷新（前端）。** 首屏并发 5 个请求同时 401 时，`refreshPromise` 单例保证只刷新一次并重放全部失败请求；刷新用裸 axios 防拦截器递归，`_retried` 标记防死循环。这解决的正是"第 2 次刷新把第 1 次刚签发的 token 作废、用户莫名掉线"的真实 bug。
6. **状态机集中定义且返回 `allowedNext`。** 前后端不会因"谁能从哪到哪"理解不一致而出现灰按钮或 500；高风险流转（如 `ACTIVE->TERMINATED`）强制填写原因。
7. **业务约束拦住"图省事但会留烂账"的操作。** 状态变更必须填原因、生效合同禁改分润、已发布内容禁改标题、删达人前检查业务链路、结算审批双人复核、提交/审批前校验"明细汇总 === 单据头部金额"。README 里这句总结很准：**这类约束恰恰是内部工具能否长期活下去的关键。**
8. **数据库层面的"修复型迁移"有据可查。** `20260201000000_fix_data_source_and_project_scope` 把 4 个真实缺陷（缺 `MOCK` 枚举导致仿真数据无法与人工填写区分、`projects` 缺 `teamId` 导致数据范围过滤把列表打成 500、`contents` 缺 `code`、缺 `syncError`）写成向后兼容的在线变更，并注明"全部由代码审查发现"。这说明项目有真实的 review → 修复闭环。
9. **工程自检工具链。** 自研 `check-prisma-usage.mjs` 在**没有 Prisma 客户端**的情况下静态校验 88 个源文件的模型名/委托方法/枚举成员一致性，且**自带自检**（避免校验器自身出错时给假绿）；`static-check.mjs` 检查前端 import 可解析、CSS Module 类名、页面默认导出、未使用导入；`check-enum-drift.mjs` 以 `schema.prisma` 为唯一事实来源校验**前后端枚举取值**、标签映射完整性与页面里的裸状态字面量，同样**自带 `--self-test`（11 个用例）**。
10. **CI 四道关按"反馈速度"排序**：静态校验（约 1 分钟）→ 单测（含覆盖率阈值，卡在资金与安全代码上）→ 集成（真 PG + Redis，`migrate deploy` + **连跑两次 seed 验证幂等**）→ 构建（显式验证产物可产出，因为 watch 模式会掩盖构建错误）。
11. **把"检查本身失效"当成一等缺陷来修。** 项目里出现过两个比业务 bug 更严重的问题：①`apps/web` 的 `typecheck` 脚本是 `tsc --noEmit`，而根 tsconfig 是 `{ "files": [], "references": [...] }` 的 solution 配置——**实际检查 0 个文件，却一直报 0 error**，前端 24 个真实类型错误全被吞掉；②前端手写的 15 个枚举里 **9 个与后端 `schema.prisma` 不一致**（`PENDING` vs `QUEUED`、`CANCELLED` vs `CANCELED`、`FIXED` vs `FIXED_FEE`…），导致筛选 400、内容审核入口永不显示、AI 任务轮询失效、侧边栏红点全不显示。
    **关键结论**：这类漂移 **TypeScript 原理上查不出来**——声明枚举的代码和使用枚举的页面都在前端一侧，`data.status === 'PENDING'` 两边取自同一个手写联合类型，永远自洽。要发现跨边界不一致，必须引入另一侧的事实。所以修复动作不只是改 bug，而是**把这类问题变成机械可检的**（`pnpm enum:check`）+ **验证检查脚本自身有效**（`pnpm enum:selftest`）。
    > 这个自检立刻抓到脚本自己的漏洞：第一版「可疑字面量」正则强制要求至少一个下划线，于是 `'PENDING'` / `'FALLBACK'` 这两个单词型取值全部漏检——正是最典型的事故值。**没有自检的校验脚本，只是把「没有检查」包装成了「检查通过」。**

### 7.2 AI PM 视角的亮点

1. **AI 有"产品准入门槛"，不是功能装饰。** 采纳率与单位成本是两个硬指标，`GET /api/ai/usage` 直接回答"花了多少、花在哪类任务、采纳率多少"。**没有度量就没有迭代依据，也没有砍掉的依据**——这是很多 AI 功能上线后最缺的一环。
2. **把 AI 当"有成本的外部依赖"治理。** 预算熔断（402 + 明确文案）、幂等防重复计费、`AbortController` 真正释放连接、只对可重试错误重试、降级必须**状态可见**而不是静默。
3. **Prompt 是运营资产，放数据库而非代码。** 版本化 + 灰度 + 无发布迭代，并用"已被使用的模板禁止就地修改"守住历史可复盘性。
4. **自研极简渲染器是主动的安全决策**（不做表达式求值、长度上限），同时防注入与防成本失控。
5. **结构化输出强校验 + 失败可复盘。** 用 zod 校验（`passthrough` 允许模型多返回字段，不因此判失败），失败分类为 `INVALID_OUTPUT`（JSON 解析失败，保留原文）与 `SCHEMA_MISMATCH`（列出不符字段）。
6. **Mock Provider 让"没有 API Key"不再阻塞整条产品链路。** 确定性 + 结构合法 + 模拟延迟，同时服务联调、CI、演示三种场景。
7. **数据可信度是显式建模的一等公民。** `DataSourceType` 把 `API_OFFICIAL > THIRD_PARTY > SCREENSHOT > MANUAL > MOCK` 落库；`MOCK` 单独取值的原因是"仿真数据与人工填写的可信度完全不同，共用会让看板与结算无法区分真实采集与联调数据"。结算争议时能证明数据来源——这已是**证据链**思维。
8. **给 AI 划了不可逾越的红线。** 不得把模型输出当作事实写回关键字段（结算金额、达人状态、合同条款）；传给模型的数据必须最小化。**AI 只做建议与加速，钱和权的判断权始终在人手里。**
9. **产品层面很克制。** 未接入真实支付通道（打款为"人工打款 + 凭证回填"，不越界做资金通道）；平台采集明说是适配器骨架（真实接入需企业资质与逐平台联调，不假装已支持）；`docs/ai-guidelines.md` 沉淀为规范 + 可复用 Prompt 模板库，是可交接的组织资产。

### 7.3 可观测性设计

- 请求 ID（`X-Request-Id`，可由网关传入）贯穿响应、错误与审计记录**三处一致**，可据此串起"用户报错 → 服务端日志 → 审计记录"；
- 结构化日志（pino），生产 JSON 便于采集；
- 健康检查分存活（不查依赖）/ 就绪（查数据库）两个探针；
- 开发环境打印 >300ms 的慢查询；
- 运维侧建议的告警指标（`docs/deployment.md` §6.3）包括接口 P95、5xx 比例、连接池占用、**AI 月度成本 > 80% 预算**、**AI 降级率 > 10%**、结算生成失败数、超期未打款单据数。

---

## 8. 风险与不足（不能只报喜）

### 8.1 验证状态类（最要紧）

1. **本审查环境（受限沙箱）内 `pnpm install` / `prisma generate` / `vitest` 均无法执行**（`esbuild` 加载 TS 配置需 spawn 子进程，被沙箱拒绝为 `EPERM`）。因此**单元测试与 e2e 的通过结论必须由正常环境复跑确认**：
   ```bash
   pnpm --filter @creatorops/api test        # 2 个 spec：settlement.calculator（含 300+ 组守恒穷举）、auth/permissions
   pnpm test:e2e                             # 29 个用例，需要数据库
   ```
   **已实测通过**的是：后端 `tsc -p tsconfig.json --noEmit` = 0 错误；前端 `tsc -p tsconfig.app.json --noEmit` = 0 错误；`node scripts/check-enum-drift.mjs` 通过；`node scripts/check-enum-drift.mjs --self-test` 11/11 通过。
2. **前端 0 个测试文件**。不过 `tsconfig.app.json` 的 `strict / noUnusedLocals / noUnusedParameters / verbatimModuleSyntax` 约束**现已真实生效**（原先的 `tsc --noEmit` 因指向 solution 配置而检查 0 个文件，这个坑已修）。`static-check.mjs` 的"语法检查"步骤经审查仍为空壳，只能靠正则兜底（会漏掉真实类型错误）——这也是必须补上 `tsc -p tsconfig.app.json` 作为独立关卡的原因。
3. ~~**迁移目录只有 2 个文件夹、没有初始建表迁移**~~ → **已解决**。`apps/api/prisma/migrations/0_init/migration.sql` 已补（由 `scripts/gen-migration-baseline.mjs` 生成，含 BOM 剥离逻辑），`prisma migrate deploy` 可在干净库建出 18 张业务表 + `code_sequences`；另有 `20260102000000_add_code_sequences`。
4. **结论**：静态层面的结论现已可复现（且通过）；"服务真的能跑"仍需正常环境跑一次 `pnpm verify && pnpm build && pnpm test:e2e`。
5. **CI 第一道关存在两处硬缺口（已核实，仍未修）**：
   - `apps/api/package.json` 声明了 `"lint": "eslint \"src/**/*.ts\" --max-warnings 0"`，但 **`apps/api` 的 devDependencies 里没有 eslint**，且全仓唯一的 eslint 配置是 `apps/web/.eslintrc.cjs`——**api 侧既无 eslint 依赖也无配置文件**，`pnpm -r lint`（CI 第一道关）会在 api 这一步失败；
   - `docker-compose.yml` 的 `api` 服务指向 `apps/api/Dockerfile`，但**该文件不存在**（仓库里只有 `apps/web/Dockerfile` 与 `apps/web/nginx.conf`）——`docker compose --profile full up` 全栈容器化路径当前无法构建。`docs/deployment.md` §3.2 描述的 api 多阶段镜像设计与实际文件不一致。
   - 注：这不影响 `pnpm infra:up`（只起 postgres + redis 两个服务），本地开发路径是完好的。
   - **本次新增**：CI 里已加入 `pnpm enum:selftest` / `pnpm enum:check`（两者均已本地实测通过）。但因为 `pnpm -r lint` 在 api 这一步必然失败，**CI 目前整体仍是红的**——加新关卡不会让它更红，但也不该把「CI 已配好」说成「CI 是绿的」。

### 8.2 架构与技术债类

| # | 问题 | 影响 | 依据 |
| --- | --- | --- | --- |
| 5 | **定时任务单实例假设** | 多实例部署时每个实例都会触发，产生重复日志与无谓 DB 压力（不会出错数据，业务幂等兜着） | `docs/deployment.md` §4；方案已有三选一但**代码未内置** |
| 6 | **限流基于内存** | 多实例实际阈值 = 配置值 × 实例数 | `README.md` §11.8 |
| 7 | **api 侧无 eslint 依赖与配置** | `pnpm -r lint`（CI 第一道关）在 api 步骤必然失败；`--max-warnings 0` 的严格标准实际从未生效 | `apps/api/package.json` vs 实际文件 |
| 8 | **`apps/api/Dockerfile` 缺失** | `docker compose --profile full`（全栈容器化）无法构建；`docs/deployment.md` §3.2 描述的 api 镜像与事实不符 | `docker-compose.yml` 指向的文件不存在 |
| 9 | **密钥轮换未落地** | 证件号密文带 `v1` 前缀预留了空间，双读迁移未实现 | `docs/architecture.md` §8.4 |
| 10 | **白标多租户未实现** | `Team` 有组织维度但无数据租户隔离 | `docs/architecture.md` §8.2 |
| 11 | **关键词搜索走不了索引** | `contains + mode: insensitive`，万级达人可接受，百万级需 `pg_trgm` GIN 或独立搜索服务 | `docs/data-model.md` §5 |
| 12 | **前端巨型页面** | `ContentDetailPage` 1014 行、`CreatorDetailPage` 915 行、`AiWorkbenchPage` 912 行，表单/弹窗/表格/轮询混在一起，难以测试与复用 | 实测行数 |
| 13 | **AI 任务轮询逻辑重复未抽象** | 2s 轮询在多个页面各写一遍，且轮询期间切页不会停止 | 前端审查 |
| 14 | **Zustand 是无效依赖** | `package.json` 声明了 `zustand ^4.5.5`，但全仓 0 处使用 | 前端审查 |
| 15 | **无 focus trap / 无 i18n / 时间判断依赖客户端时钟** | Modal、Drawer 无焦点管理；中文文案硬编码；`new Date()` 直接用于逾期判断，跨时区或客户端时钟偏移会误判"已逾期" | 前端审查 |

### 8.3 产品与运营类

| # | 问题 | 影响 |
| --- | --- | --- |
| 14 | **真实平台采集仍是骨架** | `HttpCollectorDriver` 具备鉴权/超时/重试/错误转换的完整结构，但真实接入需企业资质与逐平台联调；只有 `COLLECTOR_MODE=mock` 才有数据。**看板与结算的真实性依赖尚未落地的外部条件**，商业演示与生产上线之间还有硬性外部工作 |
| 15 | **账号级手动采集端点缺失** | 只有每日 06:30 定时批量 + 内容级手动；前端相应按钮只能如实提示"接口未开放" |
| 16 | **下拉候选接口缺失** | 达人/品牌筛选需输入 UUID，万级达人下不能拉全量拼下拉——真实可用性缺口 |
| 17 | **文件存储默认落本地磁盘** | 已抽象 `STORAGE_DRIVER`（local/s3），生产建议切对象存储 |
| 18 | **export 走 CSV** | 财务实际用 Excel；CSV 兼容性最好，未做 xlsx 服务端生成（避免引入重依赖） |
| 19 | **AI 采纳率闭环缺"下游真实效果"** | 目前只统计人工采纳/拒绝，**没有回到业务结果**（采纳的脚本其内容完播率/转化是否更好）。这是 AI PM 应该补的最后一段：把 AI 采纳与内容效果指标（`completionRate` / `conversions` / `revenueCents`）关联，才能从"AI 有用吗"升级为"AI 在哪个环节 ROI 最高" |
| 20 | **实时通知仅站内** | 未接企微/钉钉机器人（已预留 `ALERT_WEBHOOK_URL`） |

---

## 9. 下一步排期建议

| 优先级 | 事项 | 验收标准 |
| --- | --- | --- |
| **P0** | 在正常环境跑通 `install → prisma generate → migrate → seed → build → test → e2e` | 四道 CI 关卡全绿；2 个 spec 首次真实执行通过 |
| **P0** | 补齐初始建表迁移，验证干净库迁移路径 | `migrate deploy` 成功 + 连跑两次 `seed` 结果幂等 |
| P1 | 定时任务选主 / 独立 worker + Redis 限流存储 | 双实例并发跑月度结算只出一次账，日志无重复 |
| P1 | 拆解三个千行页面为 feature 组件，抽公共轮询 hook | 单文件 < 400 行，全仓无重复 `refetchInterval` 逻辑 |
| P1 | 补 P0 级前端测试（PermissionGate、金额格式化、401 重放） | web 侧 vitest 真实产出覆盖率 |
| P1 | 补齐 `static-check.mjs` 的语法检查（当前为空壳） | 能捕获真实语法/类型错误，或明确改为只做正则级检查并在文档中说明 |
| P2 | AI 采纳率 → 内容效果指标关联分析 | `GET /api/ai/usage` 增加"采纳任务 vs 未采纳任务的内容效果对比" |
| P2 | 关键词搜索上 `pg_trgm` GIN + 候选下拉接口 | 万级达人搜索 P95 < 300ms，筛选不再需要输入 UUID |
| P2 | 移除 `zustand` 无效依赖，或明确落地场景 | `pnpm why zustand` 不再出现在生产依赖 |

---

## 10. 复现本文结论的方式

```bash
# 1) 核对规模基线
find apps/api/src -name '*.ts' | wc -l          # 88
find apps/web/src -name '*.ts*' | wc -l         # 64
wc -l apps/api/prisma/schema.prisma             # 815 行 / 18 模型 / 15 枚举

# 2) 核对自检脚本（无需安装依赖即可运行）
node apps/api/scripts/check-prisma-usage.mjs
node apps/web/scripts/static-check.mjs
node scripts/check-enum-drift.mjs            # 前后端枚举一致性
node scripts/check-enum-drift.mjs --self-test  # 校验脚本自身的 11 个用例

# 2b) 亲手验证「检查确实会报错」——这是本文最关键结论的证据
#     把 apps/web/src/api/types.ts 的 SettlementStatus 里 'VOID' 改成 'CANCELLED'，
#     然后重跑上面两条命令：应当分别报出枚举漂移与 4 处类型错误。改回即可。

# 3) 核对"未验证"结论（README §11 声明的清单）
pnpm install && pnpm --filter @creatorops/api prisma:generate && pnpm -r typecheck && pnpm test && pnpm build
```

**本文引用的核心文件**：

| 主题 | 文件 |
| --- | --- |
| 结算引擎（纯函数 + 守恒断言） | `apps/api/src/modules/settlements/settlement.calculator.ts` |
| 结算生成（幂等三层 + 逐人事务） | `apps/api/src/modules/settlements/settlement.service.ts` |
| 结算引擎穷举测试 | `apps/api/src/modules/settlements/settlement.calculator.spec.ts` |
| AI 编排（幂等/预算/降级/校验） | `apps/api/src/modules/ai/ai-task.service.ts` |
| AI Provider 抽象与任务预设 | `apps/api/src/modules/ai/providers/ai-provider.interface.ts` |
| 确定性 Mock Provider | `apps/api/src/modules/ai/providers/mock.provider.ts` |
| Prompt 渲染器（防注入） | `apps/api/src/modules/ai/prompt-renderer.ts` |
| 权限矩阵与数据范围 | `apps/api/src/modules/auth/permissions.ts` |
| 数据范围与归属校验 | `apps/api/src/common/utils/scope.ts` |
| 达人状态机 | `apps/api/src/modules/creators/creator-status.machine.ts` |
| 声明式审计 | `apps/api/src/common/interceptors/audit.interceptor.ts` |
| 全局装配（测试复用） | `apps/api/src/bootstrap.ts` |
| 采集器驱动抽象 | `apps/api/src/modules/contents/metrics-collector.service.ts` |
| 定时任务 | `apps/api/src/modules/scheduler/scheduled-jobs.service.ts` |
| 数据模型 | `apps/api/prisma/schema.prisma` |
| 业务编号原子自增迁移 | `apps/api/prisma/migrations/20260101000000_init_code_sequences/migration.sql` |
| 修复型迁移 | `apps/api/prisma/migrations/20260201000000_fix_data_source_and_project_scope/migration.sql` |
| 前端路由与权限边界 | `apps/web/src/App.tsx` |
| 前端请求层（401 去重刷新） | `apps/web/src/api/client.ts` |
| CI 四道关 | `.github/workflows/ci.yml` |

---

> 本文为独立复盘，与项目内既有文档互补：设计理由见 `docs/architecture.md`、`docs/data-model.md`、`docs/permissions.md`、`docs/ai-guidelines.md`、`docs/deployment.md`、`docs/api.md`。
> 凡本文与代码不一致处，**以代码为准**；凡涉及"未验证"的结论，请在正常开发环境补做后再更新本文。
