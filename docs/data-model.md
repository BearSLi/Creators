# 数据模型说明

> 完整定义见 `apps/api/prisma/schema.prisma`。本文说明**为什么这样建表**，而不是重复字段列表。

---

## 1. 全局设计原则

| 原则 | 具体做法 | 为什么 |
| --- | --- | --- |
| 金额用 `Decimal(18,2)` | 绝不用 `Float`/`Double` | 浮点无法精确表示 0.1，多级分成后尾差会累积到元级 |
| 比率用基点整数（`Int`） | `7000` 表示 70% | 避免 `0.7` 的浮点表示问题；整数比较与运算无歧义 |
| 全表软删除 | `deletedAt DateTime?` | 业务数据永不物理删除，历史报表/结算凭证/审计追溯始终有依据 |
| 审计字段 | `createdAt` / `updatedAt` / `createdById` | 每条数据可回答「谁在什么时候创建/修改」 |
| 枚举落库为字符串 | Prisma enum | DBA 可直接写 SQL 排查，报表不用 join 字典表 |
| 索引按真实查询路径 | 见第 5 节 | 内部工具也不该在数据量上来后才发现列表页要 3 秒 |
| 唯一的业务约束交给数据库 | `@@unique` | 应用层判重存在竞态；数据库唯一约束是幂等的最终保证 |

---

## 2. 实体关系总览

```
                    ┌──────────┐
                    │  Team    │ (自关联树: parentId / children)
                    └────┬─────┘
                         │ 1:N
                    ┌────▼─────┐          ┌──────────────┐
                    │  User    │◄─────────┤ RefreshToken │ (familyId 分组，重放检测)
                    └────┬─────┘          └──────────────┘
         owner / createdBy │
                         │ 1:N                       ┌───────┐
                    ┌────▼──────┐   N:M  ┌───────────┤  Tag  │
                    │  Creator  ├───────►│CreatorTag ├───────┘
                    └──┬──┬──┬──┘        └───────────┘
                       │  │  │
        1:N ┌──────────┘  │  └──────────┐ 1:N
            ▼             │ 1:N         ▼
   ┌─────────────────┐    │      ┌──────────────┐
   │ PlatformAccount │    │      │   Content    │◄────┐ 1:N
   └────────┬────────┘    │      └──────┬───────┘     │
            │ 1:N         │             │ N:1         │
            ▼             │             ▼             │
   ┌─────────────────┐    │      ┌──────────────┐     │
   │MetricsSnapshot  │    │      │   Project    │     │
   └─────────────────┘    │      └──────┬───────┘     │
                          │             │ N:1         │
                          │             ▼             │
                          │      ┌──────────────┐     │
                          └─────►│   Contract   │     │
                                 └──────┬───────┘     │
                                        │ 1:N         │
                                        ▼             │
                                 ┌──────────────────┐ │
                                 │ SettlementItem   │─┘ (contentId 可空: 一口价无内容)
                                 └────────┬─────────┘
                                          │ N:1
                                          ▼
                                 ┌──────────────────┐
                                 │   Settlement     │ (creatorId + 账期 唯一)
                                 └──────────────────┘

  独立/旁路：
  ┌──────────────┐   ┌──────────────────┐   ┌──────────────┐   ┌───────────────┐
  │   Brand      │   │ PromptTemplate   │──►│   AiTask     │   │   AuditLog    │
  └──────────────┘   └──────────────────┘   └──────────────┘   └───────────────┘
  ┌──────────────┐   ┌──────────────┐
  │ Notification │   │ code_sequences│ (手写 SQL 迁移，非 Prisma 模型)
  └──────────────┘   └──────────────┘
```

---

## 3. 核心表设计说明

### 3.1 Creator（达人主数据）

| 字段 | 设计意图 |
| --- | --- |
| `code` | 业务编号 `CR-2026-000123`，唯一。业务人员口头沟通、合同引用都用它，不是 UUID |
| `idCardEncrypted` | 证件号 AES-256-GCM 加密。业务上需要回显（签约、报税），所以必须可逆而非哈希 |
| `status` + `tier` | 状态（合作生命周期，状态机约束）+ 分级（资源倾斜），两者独立 |
| `verticals[]` / `styleTags[]` | PostgreSQL 数组。垂类用于筛选与 AI 匹配，风格标签用于人设检索；用数组而非关联表是因为它们的基数小、只需要 `hasSome` 查询 |
| `availability` (Json) | 档期与合作偏好是半结构化数据，各团队字段需求不一致，强行建表会频繁改结构 |
| `sourceChannel` | 招募渠道，用于分析渠道 ROI（哪个渠道来的达人质量高） |
| `score` | 综合评估分（四维度加权），供 AI 匹配与资源倾斜使用 |
| `riskLevel` | LOW/MEDIUM/HIGH，拉黑自动置 HIGH |
| `ownerId` / `teamId` | 数据范围的载体：商务只可见 `ownerId = 自己` 的达人 |

**索引意图**：`(status, tier)` 支持达人库最常用的双维度筛选；`(deletedAt, createdAt)` 支持默认列表（未删除、最新在前）；`(name)` 支持模糊搜索前缀。

### 3.2 PlatformAccount + MetricsSnapshot（账号矩阵与数据）

**为什么要分两张表**：`PlatformAccount` 是「当前状态」（粉丝数、主页链接），`MetricsSnapshot` 是「历史轨迹」。趋势图与结算基准读快照，列表页读账号当前值——混在一张表会导致列表查询扫全量历史。

| 设计点 | 说明 |
| --- | --- |
| `@@unique([platform, platformUid])` | 平台内唯一 ID 是全系统的去重锚点，防止同一账号被录入两次 |
| `@@unique([accountId, statDate])` | **幂等的关键**：同一天重复采集只会 upsert 覆盖，不会产生重复快照 |
| `dataSource` | 数据可信度标记（`API_OFFICIAL` 官方接口 > `THIRD_PARTY` 第三方 > `SCREENSHOT` 截图 > `MANUAL` 人工填写 > `MOCK` 仿真）。结算争议时能证明数据来源；`MOCK` 单列是为了让看板与结算区分的出「真实采集」与「联调数据」 |
| `revenueCents` | 快照级收入（分），是结算引擎的输入之一 |
| `[creatorId, isPrimary]` | 一人多号时快速取主账号用于展示 |
| `[platform, followerCount]` | 支持「按平台 + 粉丝量级」筛选达人 |

### 3.3 Contract（合同）—— 分润规则的法律载体

合同不只是文档，它**承载结算引擎读取的参数**：

| 字段组 | 字段 | 约束与说明 |
| --- | --- | --- |
| 结算模式 | `settlementMode` | `REVENUE_SHARE` / `FIXED_FEE` / `HYBRID` / `CPA` |
| 金额 | `fixedFee` | 保底或一口价；HYBRID 时作为保底下限 |
| 分润（基点） | `platformFeeBp` / `agencyShareBp` / `talentShareBp` / `taxWithholdBp` | 约束：`agencyShareBp + talentShareBp ≤ 10000`（公司与达人分成不能超过可分配净额） |
| 阶梯 | `tieredShares` (Json) | `[{from, to, talentShareBp}]`，区间左闭右开，`to: null` 表示无上限 |
| 期限 | `effectiveFrom` / `effectiveTo` | **区间不得与同达人的其他生效合同重叠**（结算口径唯一性前提） |
| 商务条款 | `exclusivity` / `exclusivityScope` / `deliverableSpec` / `breachClause` | 独家冲突会在审批时校验 |
| 审批流 | `status` / `reviewNote` / `reviewedById` / `reviewedAt` | DRAFT→PENDING_REVIEW→ACTIVE→EXPIRED/TERMINATED |

**为什么生效中的合同禁止修改分润条款**：改了会让历史结算金额与合同条款对不上，财务无法解释。要变更必须先终止再签新合同，保留完整历史。

### 3.4 Project + Content（项目与内容）

- `Project` 是「一次交付」的容器（如「某品牌 3 月短剧投放」），关联品牌、合同、达人，带 `budget` / `actualCost` 用于毛利看板。
- `Content` 是结算与数据归因的**最小单元**：
  - `platformContentId` 回填平台侧 ID，用于关联采集数据；
  - `revenueCents` / `conversions` 是结算引擎的输入；
  - `complianceScore` / `complianceFlags` 存 AI 合规预检结果，留档以备平台抽检；
  - `aiTaskId` 关联生成脚本的 AI 任务，可追溯「这条内容是谁在什么 Prompt 下生成的」。

**索引意图**：`(creatorId, status)` 支持达人详情页内容列表；`(status, scheduledAt)` 支持排期看板（按状态分列）；`(platform, publishedAt)` 支持平台维度趋势。

#### 3.4.1 内容状态机（`ContentStatus`，9 个状态）

内容是一条**真实的生产流水线**，不是通用的「草稿→审核→发布」审批流。这个区别很重要：前端曾把它写成 `DRAFT/PENDING_REVIEW/APPROVED/SCHEDULED` 这套通用状态，结果与后端全部对不上（详见 [README §8.2](../README.md)）。

```
IDEA ──► SCRIPTING ──► SHOOTING ──► EDITING ──► INTERNAL_REVIEW ──► PLATFORM_REVIEW ──► PUBLISHED ──► OFFLINE
选题      脚本中        拍摄中       剪辑中       内部审核            平台审核            已发布        已下线
                                    ▲            │                   │                                │
                                    └────────────┴───────────────────┘  驳回 → REJECTED              │
                                                                        已下线可恢复 ────────────────┘
```

| 流转 | 存在理由 |
| --- | --- |
| `IDEA → SCRIPTING / REJECTED` | 选题要么进入脚本，要么在选题阶段就被否掉 |
| `EDITING → INTERNAL_REVIEW → PLATFORM_REVIEW` | **内部审核通过后才提交平台审核**。跳过内审直接提交平台，等于把合规风险丢给平台（轻则退稿，重则封号） |
| `PLATFORM_REVIEW → PUBLISHED` | 只有平台审核通过才能发布；发布时间用于结算归因 |
| `PUBLISHED → OFFLINE` | 已发布内容只能下线，不能删除（要保留效果数据） |
| `OFFLINE → PUBLISHED` | 支持「误下线后恢复」，避免只能重建内容而丢掉全部数据 |

**新建内容的初始状态只允许 `IDEA` / `SCRIPTING`**：其余状态都隐含「已经过某道工序」的事实（`INTERNAL_REVIEW` 意味着已有成片），直接写入会让审核记录与状态自相矛盾。

#### 3.4.2 项目状态机（`ProjectStatus`，7 个状态）

```
DRAFT ──► SCHEDULED ──► IN_PRODUCTION ──► IN_REVIEW ──► PUBLISHED ──► COMPLETED
草稿       已排期         制作中             审核中         已发布        已结项
                                                                    CANCELED（已取消）
```

注意拼写是 **`CANCELED`（单 L）**——前端曾写成 `CANCELLED`（双 L）。数据库枚举落库为字符串，一个字母之差就是一个永远匹配不上的取值。

**已取消的项目不允许新增内容**：否则会出现「项目已取消，内容还在制作」的矛盾数据，成本归集会算到一个不该再花钱的项目上。

### 3.5 Settlement + SettlementItem（结算）

**为什么拆头部与明细**：

- `Settlement` 是「一张单」：账期、状态、汇总金额、审批人、账期截止、打款凭证。
- `SettlementItem` 是「一笔钱从哪来」：逐内容/逐合同的归因，含每一级的比率与金额。

拆开的价值：财务对账时能逐笔核对；达人质疑「为什么少了」时能定位到具体哪条内容；结算明细是「内容 → 金额」映射的唯一真相。

| 关键字段 | 说明 |
| --- | --- |
| `@@unique([creatorId, periodStart, periodEnd])` | **幂等第 1 层**：同达人同账期只有一张单，定时任务可重复执行 |
| `idempotencyKey` (Item, unique) | **幂等第 2 层**：`STI:{creatorId}:{contractId}:{contentId}` 或 `:FIXED:{账期}`，重复生成不会重复出账 |
| `calculationTrace` (Json) | 每条明细的计算过程快照：总流水→平台费→净额→达人分成→代扣税，含阶梯命中说明。**任何一笔都能复算复现** |
| `adjustmentAmount` / `netPayable` | 调整金额单独存，`netPayable` 保持明细汇总值不变。实际支付 = `netPayable + adjustmentAmount`。这样明细与合同口径始终可复算，调整原因单独留痕 |
| `dueDate` | 账期截止 = `periodEnd + SETTLEMENT_PAYMENT_TERM_DAYS`，超期未打款会触发提醒 |

**状态机**：`DRAFT → PENDING_APPROVAL → APPROVED → PAID`，任意态可 `DISPUTED`，`VOID` 后同账期可重新生成（旧单软删除释放唯一约束）。

### 3.6 AiTask + PromptTemplate（AI 治理）

| 表 | 关键字段 | 意图 |
| --- | --- | --- |
| `PromptTemplate` | `@@unique([key, version])` | 版本化。`rolloutPercent` 控制灰度；改 Prompt 必须新建版本 |
| `AiTask` | `idempotencyKey` (unique) | 防重复扣费 |
| | `renderedPrompt` | 保留渲染后的完整 Prompt，出问题时能精确复现 |
| | `promptTokens` / `completionTokens` / `costCents` | 成本治理的数据基础（成本以「分」存整数） |
| | `latencyMs` / `retryCount` / `fallbackReason` | 稳定性诊断 |
| | `humanFeedback` | 1 采纳 / 0 未评 / -1 拒绝 → 采纳率是判断该 AI 能力是否值得保留的唯一依据 |
| | `errorCode` / `errorMessage` | `INVALID_OUTPUT`（JSON 解析失败）/ `SCHEMA_MISMATCH`（结构不符）等 |

### 3.7 AuditLog（审计）

| 设计点 | 说明 |
| --- | --- |
| `userName` 冗余快照 | 用户被删除后仍能追溯操作人 |
| `before` / `after` (Json) | 变更前后快照，支持字段级 diff 展示 |
| `requestId` | 与日志、错误响应串联，可定位单次请求的完整链路 |
| `success` / `errorMessage` | 失败的敏感操作同样要留痕（例如越权尝试） |
| `@@index([resource, resourceId, createdAt])` | 详情页「操作记录」Tab 的主查询路径 |
| 保留期清理 | `AUDIT_LOG_RETENTION_DAYS`（默认 365 天），每月定时清理 |

### 3.8 code_sequences（业务编号）

不走 Prisma 模型，而是手写 SQL 迁移（`prisma/migrations/20260101000000_init_code_sequences/`）。

**为什么不用 PostgreSQL SEQUENCE**：业务编号需要按「资源类型 + 年份」重置（`CR-2026-000123`），SEQUENCE 是按对象全局递增的，每年要新建一堆序列。

**为什么不用 `count(*) + 1`**：存在并发读-改-写竞态，且软删除后计数不连续会撞唯一索引。

**实现**：`INSERT ... ON CONFLICT (scope) DO UPDATE SET value = value + 1 RETURNING value`，原子自增，且**必须与业务写入在同一事务内**调用（`CodeGeneratorService.next(prefix, tx)`）——业务失败时编号回滚，不留空洞。

---

## 4. 数据一致性约束汇总

数据库层面的硬约束（应用层绕过也会被拦住）：

| 约束 | 作用 |
| --- | --- |
| `Settlement @@unique([creatorId, periodStart, periodEnd])` | 防重复出账（最严重的资金事故） |
| `SettlementItem.idempotencyKey @unique` | 防明细重复生成 |
| `MetricsSnapshot @@unique([accountId, statDate])` | 采集幂等 |
| `PlatformAccount @@unique([platform, platformUid])` | 账号不重复 |
| `Creator.code` / `Contract.code` / `Settlement.code` 唯一 | 业务编号唯一 |
| `PromptTemplate @@unique([key, version])` | 版本不冲突 |
| `AiTask.idempotencyKey @unique` | 防重复扣费 |
| `Notification @@unique([userId, dedupeKey])` | 同一业务事件不重复提醒 |
| `RefreshToken.tokenHash @unique` | 令牌记录唯一 |
| `Contract.creatorId → onDelete: Restrict` | 有合同的达人不能被物理删除 |
| `SettlementItem.creatorId → onDelete: Restrict` | 有结算记录的达人不能被物理删除 |
| `User.teamId → onDelete: SetNull` | 团队被删时用户保留（不级联删人） |

---

## 5. 常用查询与对应索引

| 业务查询 | 走哪个索引 |
| --- | --- |
| 达人库默认列表（未删除、最新在前） | `[deletedAt, createdAt]` |
| 达人库按状态 + 分级筛选 | `[status, tier]` |
| 我的达人（商务数据范围） | `[ownerId]` |
| 平台账号列表（按粉丝量排序） | `[platform, followerCount]` |
| 达人详情页内容列表 | `[creatorId, status]` |
| 内容排期看板（按状态分组） | `[status, scheduledAt]` |
| 账号近 30 天趋势 | `[accountId, statDate]` 唯一索引 + `[statDate]` |
| 合同即将到期提醒 | `[status, effectiveTo]` |
| 结算单列表（按账期） | `[periodEnd]`（+ 状态复合索引 `[status, dueDate]`） |
| 结算明细按内容查询 | `[settlementId]` / `[contractId]` |
| AI 任务列表（按类型/状态） | `[taskType, status]` + `[createdAt]` |
| 审计：某资源的操作记录 | `[resource, resourceId, createdAt]` |
| 审计：某人的操作记录 | `[userId, createdAt]` |

**未加索引但需要注意的查询**：达人库关键词搜索用了 `contains ... mode: 'insensitive'`，在数据量很大时无法走索引。当前规模（万级达人）可接受；若增长到百万级，应改用 PostgreSQL `pg_trgm` GIN 索引或引入专门的搜索服务。这一点在 `docs/architecture.md` 的演进路线中有记录。

---

## 6. 迁移与种子数据

```bash
pnpm --filter @creatorops/api prisma:generate   # 生成客户端
pnpm db:migrate                                  # 开发环境：创建并应用迁移
pnpm --filter @creatorops/api prisma:deploy      # 生产环境：仅应用已有迁移
pnpm db:seed                                     # 写入演示数据（幂等，可反复执行）
pnpm db:reset                                    # 重置并重新初始化（危险，仅本地）
```

**种子数据的设计要求**（`apps/api/prisma/seed.ts`）：数据必须**业务自洽**，这是演示数据最容易做错的地方——

1. 达人状态与是否有合同一致（有生效合同的达人不会是「线索」）；
2. 内容有收入才会产生结算明细；
3. **结算单头部金额 = 明细汇总**（用与生产完全相同的结算引擎计算，而不是手写数字）；
4. 编号序列会被对齐到种子数据的最大值，避免后续新建时撞唯一索引。
