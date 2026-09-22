# API 接口说明

> 也可通过 Swagger 交互式查看：`http://localhost:3100/api/docs`（生产环境自动关闭）。
> 本文说明**约定与错误处理**，接口清单见第 5 节。

---

## 1. 基础约定

| 项 | 约定 |
| --- | --- |
| Base URL | `/api`（开发环境 Vite 代理到 `http://localhost:3100`；生产 Nginx 反向代理） |
| 数据格式 | JSON（`Content-Type: application/json`），导出接口返回 CSV |
| 鉴权 | `Authorization: Bearer <accessToken>` |
| 请求 ID | 可选传入 `X-Request-Id`；服务端始终在响应头返回该值，用于串联日志与审计 |
| 版本 | **不做版本控制**。本项目是内部工具，只有自家前端一个消费方，不存在版本协商需求。早期曾启用 header 版本控制（`X-API-Version`），因所有控制器都未标 `@Version()` 而导致未携带该头的请求全部 404，已移除（见 `bootstrap.ts` 注释） |
| 请求体上限 | JSON 2MB，表单 512KB（批量导入达人最多 200 条） |

**免鉴权接口**（仅这些）：`POST /api/auth/login`、`POST /api/auth/refresh`、`GET /api/health`、`GET /api/health/ready`、`/api/docs`。

---

## 2. 响应结构

### 2.1 成功

```json
{
  "success": true,
  "data": { "id": "...", "name": "林小满" },
  "requestId": "5f3d...",
  "timestamp": "2026-02-01T10:23:45.123Z"
}
```

> `data` 可以是对象、数组或分页对象。**导出类接口（返回 CSV 流）不套信封**，前端需用 `responseType: 'blob'` 并跳过解包。

### 2.2 失败

```json
{
  "success": false,
  "code": "STATE_CONFLICT",
  "message": "不允许从「线索」直接变更为「合作中」",
  "details": {
    "from": "LEAD",
    "to": "ACTIVE",
    "allowedNext": [
      { "value": "CONTACTING", "label": "建联中" },
      { "value": "EVALUATING", "label": "评估中" }
    ]
  },
  "path": "/api/creators/abc/status",
  "requestId": "5f3d...",
  "timestamp": "2026-02-01T10:23:45.123Z"
}
```

**设计要点**

- `code` 是**稳定的机器可读标识**，前端据此做文案映射与差异化处理；`message` 是给人看的中文，可随迭代调整而不破坏前端逻辑。
- `details` 承载可操作信息。例如状态冲突返回 `allowedNext`，前端直接据此渲染合法操作按钮，而不是自己硬编码状态图。
- 错误响应**绝不包含堆栈、SQL 语句或数据库错误原文**（信息泄露），这些只进服务端日志。

### 2.3 参数校验失败（`VALIDATION_FAILED`）

```json
{
  "success": false,
  "code": "VALIDATION_FAILED",
  "message": "brandId must be a UUID；vertical must be one of the following values: SHORT_DRAMA, …",
  "details": [
    "brandId must be a UUID",
    "vertical must be one of the following values: SHORT_DRAMA, LIFESTYLE, …"
  ],
  "fieldErrors": {
    "brandId": ["brandId must be a UUID"],
    "vertical": ["vertical must be one of the following values: SHORT_DRAMA, LIFESTYLE, …"]
  },
  "path": "/api/projects",
  "requestId": "5f3d…",
  "timestamp": "2026-02-01T10:23:45.123Z"
}
```

**为什么额外提供 `fieldErrors`**（`details` 保留不变，两者同源、不会不一致）：

`details` 是扁平消息数组，字段名只以**自然语言**混在句子里。调用方想据此标红输入框就得去解析英文句子 —— 既不可靠（自定义 message 里根本没有字段名，例如「结算模式非法」），也不该由前端承担。

`fieldErrors` 的键就是 **DTO 属性名**，可直接当作表单字段名使用：

| 键 | 来源 | 前端用途 |
| --- | --- | --- |
| `brandId` / `vertical` / `settlementMode` … | 对应字段的校验器 | 把该输入框标红并就近显示原因 |
| 嵌套 DTO | `accounts.0.platform`（点号 + 下标） | 定位到动态行 |
| （无） | `forbidNonWhitelisted` 拦下的「多传未声明字段」**不进入** `fieldErrors` | 没有输入框可标红，但 `details` 里仍有原文，前端需把它展示出来 |

⚠️ **实现上的两条硬要求**（都踩过坑）：

1. **「用于标红的字段」和「用于展示的原因」必须是两个来源。** 前端若只用 `fieldErrors` 拼提示，「多传了 `status`」这种没有对应输入框的错误会让提示退化成「请检查标红字段后重试」—— 一句让用户去看并不存在的红字段的假提示。
2. **前端不得解析 `message` 文本做逻辑判断。** 判断依据只能是 `code` 与 `fieldErrors` 的键；文本随时可能改（含翻译）。

前端对应实现：`apps/web/src/api/client.ts` 的 `ApiError.fieldErrors` / `validationMessages`，以及 `apps/web/src/utils/formErrors.ts` 的 `applyServerFieldErrors`。

### 2.3 分页

所有列表接口统一：

```json
{
  "items": [],
  "total": 128,
  "page": 1,
  "pageSize": 20,
  "totalPages": 7,
  "hasNext": true
}
```

通用查询参数：`page`（默认 1）、`pageSize`（默认 20，最大 100）、`sortBy`、`sortOrder`（`asc`/`desc`，默认 `desc`）。

> **`sortBy` 是白名单机制**：只有各接口声明的字段可排序，其余自动回落到默认字段。这是防 SQL 注入的必要措施——Prisma 的 `orderBy` 能参数化值，但字段名无法参数化。

---

## 3. 数据格式约定（重要）

| 类型 | 传输格式 | 示例 | 原因 |
| --- | --- | --- | --- |
| 金额 | **字符串**（元，2 位小数） | `"18250.00"` | 避免 JSON 数字的浮点精度问题；前端只展示不参与计算 |
| 分润比率 | **整数**（基点 bp，1bp = 0.01%） | `7000` = 70% | 整数无歧义，与数据库存储一致 |
| 百分比展示值 | 数字（百分数） | `engagementRate: 12.5` | 用于图表与展示，由后端转换 |
| 大整数（播放量/点赞） | **字符串** | `"1860000"` | 超出 JS `Number.MAX_SAFE_INTEGER` 风险；且前端不参与运算 |
| 日期时间 | ISO 8601 字符串 | `"2026-02-01T10:23:45.123Z"` | 统一 UTC，前端按本地时区渲染 |
| 日期（账期等） | `YYYY-MM-DD` | `"2026-01-31"` | 账期是「日期」而非「时刻」，避免时区偏移 |
| 枚举 | 大写下划线字符串 + 中文标签字段 | `status: "ACTIVE"`, `statusLabel: "合作中"` | 前端不用维护一套枚举字典（但仍提供 `constants.ts` 用于筛选下拉） |
| 空值 | `null`，非 `undefined` | `"brandName": null` | JSON 中 `undefined` 会被丢弃，导致字段消失引发前端报错 |

**「金额不在前端计算」是硬性约定**：所有分成、税额、合计都由后端结算引擎计算并落库。前端只负责展示与格式化。前端做金额加减再回写是资金系统的重大隐患。

---

## 4. 错误码表

| HTTP | code | 含义 | 前端建议处理 |
| --- | --- | --- | --- |
| 400 | `VALIDATION_FAILED` | 参数校验失败（`details` 逐条信息 + `fieldErrors` 字段名映射，见 §2.3） | 用 `fieldErrors` 标红字段；无字段可标红时把 `details` 原文展示出来 |
| 400 | `REASON_REQUIRED` | 该操作必须填写原因 | 弹出原因输入框（`details.field` 指明字段名） |
| 400 | `INVALID_ADJUSTMENT` | 结算调整金额非法 | 提示具体问题（如调整后为负） |
| 400 | `WEAK_PASSWORD` | 密码强度不足 | 展示具体不满足的规则 |
| 400 | `PASSWORD_UNCHANGED` | 新密码与原密码相同 | 提示重新输入 |
| 400 | `DB_*` / `DB_VALIDATION_ERROR` | 数据不符合模型约束 | 提示检查输入（通常已在 DTO 层拦住） |
| 401 | `UNAUTHORIZED`（NestJS 默认） | 未登录或令牌失效 | 用 refresh token 刷新并重放请求；失败则跳登录 |
| 402 | `AI_BUDGET_EXCEEDED` | 本月 AI 预算已用尽 | 提示联系管理员调整预算 |
| 402 | `AI_BUDGET_INSUFFICIENT` | 本次任务将超出剩余预算 | 提示剩余额度 |
| 403 | `PERMISSION_DENIED` | 缺少权限点 | 提示无权限；隐藏或禁用对应入口（`details.required` 列出所需权限） |
| 403 | `SCOPE_DENIED` | 数据不在你的范围内 | 提示「该数据不在你的负责范围内」 |
| 403 | `APPROVAL_SEGREGATION` | 创建人不能审批自己生成的单据 | 提示需他人审批（双人复核） |
| 404 | `RESOURCE_NOT_FOUND` | 资源不存在或已删除 | 跳 404 页或返回列表 |
| 409 | `DUPLICATE_RESOURCE` | 唯一字段冲突（`details.fields`） | 提示具体哪个字段重复 |
| 409 | `DUPLICATE_OPERATION` | 操作已执行/被业务规则阻止 | 直接展示 `message`（已写明原因与数量） |
| 409 | `STATE_CONFLICT` | 状态机不允许该流转 | 展示 `details.allowedNext` 作为可选操作 |
| 409 | `RELATION_CONSTRAINT` | 存在关联数据无法操作 | 提示先处理关联数据 |
| 409 | `TRANSACTION_CONFLICT` | 并发写冲突 | 提示重试（后端已自动重试 2 次） |
| 409 | `PROMPT_IMMUTABLE` | Prompt 模板已被使用，不可就地修改 | 引导「新建版本」 |
| 422 | `UNPROCESSABLE_ENTITY` | 格式合法但业务不可行 | 展示 `message` |
| 423 | `ACCOUNT_LOCKED` | 账号被临时锁定 | 展示剩余秒数（`details.retryAfterSeconds`） |
| 429 | `RATE_LIMITED` | 触发限流 | 展示 `details.retryAfterSeconds` 后自动重试或提示等待 |
| 500 | `INTERNAL_ERROR` | 服务内部错误 | 提示重试；展示 `requestId` 便于反馈排查 |
| 503 | `UPSTREAM_UNAVAILABLE` | 外部依赖（AI/平台接口）不可用 | 提示稍后重试 |
| 503 | `AI_PROVIDER_UNAVAILABLE` | AI 凭证不可用 | 提示联系管理员检查配置 |
| 503 | `PROMPT_TEMPLATE_MISSING` | 该任务类型无可用 Prompt 模板 | 提示管理员初始化模板 |

---

## 5. 接口清单

### 5.1 认证 `/api/auth`

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/login` | 公开（限流 10/分钟） | 登录，返回 access/refresh 令牌与权限集合 |
| POST | `/refresh` | 公开 | 刷新令牌（轮换 + 重放检测） |
| POST | `/logout` | 登录态 | 退出（撤销当前设备会话族） |
| GET | `/profile` | 登录态 | 当前用户信息与权限 |
| PATCH | `/password` | 登录态 | 修改密码（成功后撤销全部会话） |

### 5.2 达人 `/api/creators`

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/` | `creator:read` | 列表。筛选：`keyword`（昵称/真名/手机号/编号/平台昵称）、`status[]`、`tier[]`、`vertical[]`、`platform`、`ownerId`、`tagId`、`minFollowers`、`maxFollowers`、`minScore`、`sourceChannel` |
| GET | `/:id` | `creator:read` | 详情（含账号矩阵、业务统计、状态机可选动作） |
| POST | `/` | `creator:write` | 新建（可同时录入平台账号） |
| POST | `/batch-import` | `creator:write` | 批量导入（部分成功语义，返回逐条失败原因） |
| PATCH | `/:id` | `creator:write` | 编辑资料（不含 `status`） |
| PATCH | `/:id/status` | `creator:write` | 状态流转（状态机校验；高风险流转必须填 `reason`） |
| POST | `/:id/evaluate` | `creator:write` | 四维度评估打分 |
| POST | `/:id/assign` | `creator:assign` | 分配/交接负责人 |
| DELETE | `/:id` | `creator:delete` | 软删除（有关联业务数据时拒绝） |
| GET | `/tags` | `creator:read` | 标签列表（见 `/api/tags`） |

### 5.3 标签 `/api/tags`

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET | `/` | `creator:read` |
| POST | `/` | `creator:write` |
| PATCH | `/:id` | `creator:write` |
| DELETE | `/:id` | `creator:write`（被引用时拒绝） |

### 5.4 品牌 `/api/brands`

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET | `/` | `brand:read` |
| GET | `/:id` | `brand:read` |
| POST | `/` | `brand:write` |
| PATCH | `/:id` | `brand:write` |
| DELETE | `/:id` | `brand:write`（被引用时拒绝） |

### 5.5 合同 `/api/contracts`

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/` | `contract:read` | 列表 |
| GET | `/:id` | `contract:read` | 详情（含分润换算预览、关联项目、历史结算汇总） |
| GET | `/:id/settlement-preview` | `contract:read` | **结算预估**（与正式结算使用同一引擎） |
| POST | `/` | `contract:write` | 新建（草稿） |
| PATCH | `/:id` | `contract:write` | 编辑（生效中禁止改金额与分润条款） |
| POST | `/:id/submit` | `contract:submit` | 提交审核（校验区间冲突） |
| POST | `/:id/approve` | `contract:approve` | 审批（双人复核；通过后达人自动推进为已签约） |
| POST | `/:id/terminate` | `contract:terminate` | 终止（有未结清结算单需 `force: true`） |
| DELETE | `/:id` | `contract:write` | 删除草稿（软删除） |

### 5.6 项目 `/api/projects`

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET | `/` | `project:read` |
| GET | `/:id` | `project:read` |
| POST | `/` | `project:write` |
| PATCH | `/:id` | `project:write` |
| POST | `/:id/status` | `project:write` |
| DELETE | `/:id` | `project:write` |

### 5.7 内容 `/api/contents`

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/` | `content:read` | 筛选：`creatorId`、`projectId`、`platform`、`status[]`、`keyword`、`from`、`to` |
| GET | `/:id` | `content:read` | 详情（含脚本、AI 任务、结算明细、状态机） |
| POST | `/` | `content:write` | 新建（校验达人可排期） |
| PATCH | `/:id` | `content:write` | 编辑（已发布内容禁止改标题/平台） |
| POST | `/:id/submit-review` | `content:write` | 提交审核 |
| POST | `/:id/review` | `content:review` | 审核通过/驳回 |
| POST | `/:id/publish` | `content:publish` | 发布 |
| POST | `/:id/sync-metrics` | `metrics:sync` | 同步数据 |
| DELETE | `/:id` | `content:write` | 软删除（已发布拒绝） |

### 5.8 结算 `/api/settlements`

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/` | `settlement:read` | 列表（金额为字符串元） |
| GET | `/export` | `settlement:export` | 导出 CSV（带 BOM，Excel 中文不乱码）；**不套信封** |
| GET | `/:id` | `settlement:read` | 详情（含明细、`calculationTrace`、可执行动作） |
| POST | `/generate` | `settlement:generate` | 按账期批量生成（幂等，可重复调用） |
| POST | `/:id/submit` | `settlement:edit` | 提交审批（校验明细汇总一致性） |
| POST | `/:id/adjust` | `settlement:edit` | 调整金额（必须填原因） |
| POST | `/:id/approve` | `settlement:approve` | 审批（双人复核） |
| POST | `/:id/pay` | `settlement:pay` | 标记打款（可附凭证） |
| POST | `/:id/dispute` | `settlement:edit` | 标记争议 |
| POST | `/:id/void` | `settlement:approve` | 作废（作废后同账期可重新生成） |

### 5.9 AI `/api/ai`

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/tasks` | `ai:run` | 任务列表（含 token/成本/耗时/降级原因） |
| GET | `/tasks/:id` | `ai:run` | 任务详情 |
| POST | `/tasks` | `ai:run` | **发起任务**（建议传 `idempotencyKey`） |
| POST | `/tasks/:id/feedback` | `ai:feedback` | 采纳/拒绝反馈 |
| GET | `/usage` | `ai:run` | 月度用量与成本（含采纳率） |
| GET | `/prompts` | `ai:prompt:read` | 模板列表（多版本） |
| GET | `/prompts/:id` | `ai:prompt:read` | 模板详情 |
| POST | `/prompts` | `ai:prompt:write` | 新建模板版本 |
| PATCH | `/prompts/:id` | `ai:prompt:write` | 编辑（已被使用的模板不可改内容） |
| POST | `/prompts/:id/toggle` | `ai:prompt:write` | 启用/停用 |
| POST | `/prompts/seed-defaults` | `ai:prompt:write` | 补齐内置模板（幂等） |

**任务输入示例**

```jsonc
// 脚本生成
{
  "taskType": "SCRIPT_GENERATE",
  "creatorId": "uuid",              // 可选，关联达人
  "idempotencyKey": "uuid-v4",      // 强烈建议
  "input": {
    "brief": "某美妆品牌新品粉底液种草，主打持妆 12 小时、不卡粉",
    "vertical": "BEAUTY",
    "platform": "DOUYIN",
    "duration": 45,
    "tone": "轻松口语化"
  }
}
```

**输出结构**（`SCRIPT_GENERATE`，前端按此渲染分镜时间轴）

```jsonc
{
  "title": "…",
  "hook": "开场钩子的设计说明",
  "structure": "钩子(3s)→冲突(10s)→转折(15s)→高潮(20s)→引导互动(5s)",
  "scenes": [
    { "index": 1, "timeRange": "0-3s", "shot": "特写+手持推近", "voiceover": "口播文案", "note": "拍摄提示" }
  ],
  "hashtags": ["#内容运营"],
  "risks": ["需确认背景音乐商用授权"]
}
```

> `AI_PROVIDER=mock` 时输出结构完全一致（仅内容为示例），因此前端联调、CI 与离线演示都无需真实 API Key。

### 5.10 看板 `/api/dashboard`

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/overview?from&to` | `dashboard:read` | KPI、漏斗（累计口径）、流水趋势、平台/垂类分布、头部达人、待办 |
| GET | `/creator-ranking?from&to&limit&metric` | `dashboard:read` | 达人贡献榜（`metric`: `revenue`/`content`/`view`） |

### 5.11 员工与权限 `/api/users`

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/` | `user:read` | 员工列表 |
| POST | `/` | `user:write` | 新建（未传密码时返回一次性 `initialPassword`） |
| PATCH | `/:id` | `user:write` | 编辑（不允许改自己的角色） |
| POST | `/:id/status` | `user:write` | 启用/禁用（禁用会撤销全部会话） |
| POST | `/:id/reset-password` | `user:write` | 重置密码（返回一次性初始密码） |
| PATCH | `/:id/permissions` | `role:manage` | 设置权限覆盖项（变更后强制重新登录） |
| GET | `/permissions/catalog` | `user:read` | 权限点字典 |
| GET | `/roles` | `user:read` | 角色与权限矩阵、数据范围 |
| GET | `/teams` | `user:read` | 团队树 |

### 5.12 审计 `/api/audit-logs`

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/` | `audit:read` | 查询（`userId`/`resource`/`resourceId`/`action`/`success`/`from`/`to`） |
| GET | `/:resource/:id/timeline` | `audit:read` | 某条业务资源的操作记录（详情页 Tab） |

### 5.13 健康检查 `/api/health`

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/` | 公开 | 存活探针（不查依赖） |
| GET | `/ready` | 公开 | 就绪探针（查数据库） |

---

## 6. 前端请求层要求

1. **统一解包**：`client.ts` 自动取出 `data`，业务代码直接拿 `T`；导出接口需显式跳过解包。
2. **401 自动刷新**：用 refresh token 换新令牌后重放原请求；**必须做并发去重**（多个请求同时 401 时只刷新一次，其余等待同一个 Promise）。
3. **错误码映射**：把 `code` 映射为中文提示；`PERMISSION_DENIED` 提示联系管理员；`STATE_CONFLICT` 时若 `details.allowedNext` 存在则展示可选操作。
4. **禁止前端计算金额**：只做展示格式化（千分位、货币符号、等宽字体右对齐）。
5. **写操作必须处理 loading 与防重复提交**：按钮点击后禁用；AI 任务、结算生成、审批等必须带 `idempotencyKey` 或依赖后端幂等。
6. **列表/图表必须处理三态**：loading 骨架、空状态、错误重试。
