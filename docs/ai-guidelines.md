# AI 应用开发规范与 Prompt 模板库

> JD 里明确要求「沉淀 AI 应用开发规范、Prompt 模板」，并「把 AI 能力嵌入实际业务流程，而不是停留在概念层面」。本文就是那份规范：它约束**我们怎么用 AI、怎么保证 AI 不乱来、怎么证明 AI 有用**。

---

## 一、核心立场：AI 是「有成本的外部依赖」，不是功能装饰

把 AI 接入内部业务系统时，最容易犯的三个错：

| 常见错误 | 后果 | CreatorOps 的做法 |
| --- | --- | --- |
| 直接在业务代码里 `await openai.chat(...)` | 换模型要改十几处；无法统计成本；无法离线测试 | **Provider 抽象层**，业务只依赖 `AiTaskService.execute()` |
| Prompt 硬编码在代码里 | 运营想改一句话要等研发排期上线 | **Prompt 模板入库**，版本化 + 灰度，运营自助迭代 |
| 「AI 生成的内容直接给人用」 | 幻觉/违规内容流出，业务方失去信任 | **结构化输出 + zod 校验 + 风险提示 + 人工采纳反馈闭环** |

**一条硬性判断标准**：一个 AI 能力只有在「有人真的在用（采纳率可查）」且「单位成本可接受（成本可查）」时才值得保留。所以每个 AI 任务都必须落库 token、成本、耗时与人工反馈。

---

## 二、架构约定

### 2.1 分层

```
业务模块（contents / creators / settlements / dashboard）
        │  只调用这一个入口
        ▼
AiTaskService.execute(user, { taskType, input, idempotencyKey })
        │
        ├── PromptTemplateService   取模板（版本 + 灰度）
        ├── prompt-renderer.ts      渲染变量（纯函数、无表达式求值、长度上限）
        ├── 预算与成本治理           月度预算熔断 + 成本落库
        ├── AiProviderRegistry      选择 Provider + 降级
        │        └── providers/{openai,anthropic,gemini,mock}.provider.ts
        └── zod OUTPUT_SCHEMAS      结构化输出校验
```

### 2.2 硬性规则

| 规则 | 说明 |
| --- | --- |
| **业务代码不得直接 import 任何厂商 SDK 或 provider** | 只能通过 `AiTaskService`，否则成本治理与降级逻辑会被绕过 |
| **每次调用必须落库** | 输入、渲染后的完整 Prompt、输出、token、成本、耗时、重试次数、finish_reason |
| **写入业务页面之前必须做结构化校验** | LLM 会「看起来正确」地返回缺字段 JSON，写库后前端才炸，排查成本极高 |
| **传给模型的数据必须最小化** | 只传完成任务必需的字段。传达人身份证号给模型是重大合规事故 |
| **必须支持 mock** | CI 与演示环境不得依赖真实 API；`AI_PROVIDER=mock` 返回确定性结果 |
| **必须有降级路径** | 主 Provider 失败切备用；降级要状态可见（`FALLBACK_USED`），不能静默 |
| **必须设置超时** | 用 `AbortController` 真正释放连接，而不是 `Promise.race`（后者只是不再等待） |
| **只对可重试错误重试** | 超时/限流/5xx 重试（指数退避 + 抖动）；鉴权/参数错误立即失败 |
| **不得把模型输出当作事实写回数据库的关键字段** | 例如不得用 AI 直接改写结算金额、达人状态、合同条款 |

### 2.3 幂等：前端必须传 `idempotencyKey`

```ts
// 前端正确做法
const { data } = await aiApi.runTask({
  taskType: 'SCRIPT_GENERATE',
  input: { brief, platform, duration },
  idempotencyKey: crypto.randomUUID(),  // 用户点击「生成」时生成一次
});
```

幂等键在数据库上有唯一约束：同一 key 只会真正调用一次模型。这条规则直接防住「用户狂点按钮导致重复扣费」——AI 成本治理里最容易被忽略、也最烧钱的一项。

### 2.4 成本治理

- 每个任务的成本按 token 折算为**分**存库（`costCents`），避免浮点累计误差。
- 月度预算（`AI_MONTHLY_BUDGET_CNY`）用尽时，新任务返回 **HTTP 402** 并给出明确文案（不是笼统的 500），由管理者决定是否调高预算。
- `AI_PROVIDER=mock` 时不校验预算：mock 不产生真实费用，若也拦截会让「预算已满」场景无法演示。
- `GET /api/ai/usage?year&month` 回答三个问题：**花了多少 / 花在哪类任务 / 人工采纳率多少**。

### 2.5 降级与可观测

```
主 Provider 失败
   ├─ 可重试 → 退避重试（默认 2 次）
   └─ 仍失败 → 切备用 Provider
                 ├─ 成功 → status = FALLBACK_USED，fallbackReason 写明原因
                 │          前端必须提示「本次结果由降级模型生成」
                 └─ 失败 → status = FAILED，errorCode/errorMessage 落库
```

**降级不能隐藏**：如果降级后用户以为用的还是 GPT-4，会对质量产生误判。所以状态在接口里明确返回，前端在结果卡片上展示降级提示。

---

## 三、Prompt 编写规范

### 3.1 三段式结构（每个模板必须齐全）

```
① 角色设定     你是谁、服务什么业务、有什么经验
② 硬性约束     必须做什么、禁止做什么（合规红线写在这里）
③ 输出格式     严格的 JSON 结构，字段名与后端 zod schema 完全一致
```

### 3.2 六条编写原则

1. **角色要具体到业务场景**，不要写「你是一个有用的助手」。写「你是聚猩智媒的资深短视频编导，熟悉抖音完播率规律」。
2. **约束要可验证**。写「开场 3 秒必须给出强钩子」，而不是「内容要吸引人」。
3. **明确禁止编造**。写「不得编造产品功效、数据或资质；信息不足时在 risks 中说明需要补充什么」。这是内部工具最重要的质量约束——运营用错数据比没数据更糟。
4. **合规红线写进 Prompt**。广告法绝对化用语、医疗金融资质、未成年人保护、站外导流，全部显式禁止。
5. **要求结构化输出**。统一 JSON，且字段名与后端 schema 一致；明确写「只输出 JSON，不要输出解释文字或 Markdown 代码块标记」。
6. **变量用 `{{name}}` 且声明元数据**。在模板的 `variables` 里声明 `required` 与 `maxLength`：
   - `required: true` 的缺失会直接报错（不消耗 token）；
   - `maxLength` 防止把整张表塞进 Prompt 造成 token 爆炸与成本失控。

### 3.3 参数选择经验值

| 任务类型 | temperature | 理由 |
| --- | --- | --- |
| 脚本生成 / 标题优化 | 0.8 | 需要创意多样性 |
| 达人匹配 / 评论洞察 / 日报 | 0.5 | 需要稳定但允许表达多样 |
| 合规预检 / 结算解释 | 0.1 | 需要确定性；同一输入应得到一致结论 |

### 3.4 模型选择：推理模型与结构化输出任务天然错配（实战教训）

本项目在接入真实模型时踩到这个坑，值得单独写下来。

**现象**：`AI_PROVIDER=deepseek` + 推理模型（`deepseek-v4-pro`）时，脚本生成任务反复失败：

```
WARN AI 任务输出被截断（finish_reason=length，maxTokens=4096）
LOG  AI 任务完成 status=FAILED tokens=427+4096 成本=0.0300元 耗时=48878ms
```

**根因**：推理模型会把大量 token 花在**内部推理**上，而多数厂商的 `max_tokens` 是
「推理 + 回答」的总预算（且不单独暴露推理额度）。留给最终答案的空间被大幅挤占，
JSON 写一半就断 → 解析失败 → zod 校验失败 → 任务被判 FAILED。
同时单次耗时接近 50 秒，远超常规超时设置。

**这不是「模型不好」，而是任务与模型错配**：脚本生成要的是**稳定的结构化输出**，
不是深度推理。换成非推理模型（`deepseek-flash`）后立刻 `status=SUCCEEDED`。

**选模型时的检查清单**：

| 检查项 | 说明 |
| --- | --- |
| 是否推理模型 | 推理模型适合复杂分析/多步推理；结构化生成、分类、抽取用非推理模型更稳更快 |
| `max_tokens` 语义 | 确认它是「仅输出」还是「推理+输出」。若是后者，要按推理开销放大额度 |
| 超时设置 | 推理模型常见 30-60 秒。`AI_REQUEST_TIMEOUT_MS` 要给够，否则会在返回前被掐断（表现为超时，而非截断） |
| 成本 | 推理 token 也计费。截断等于整笔 token 白花且任务仍失败 |

**系统层面的两道保险**（已实现，见 `AiTaskService.execute`）：

1. **截断自动放大重试**：检测到 `finish_reason=length` 时把额度翻倍重试一次，
   上限为 `AI_MAX_TOKENS_PER_CALL`（成本熔断线），过程写入 `fallbackReason`：
   > 首次输出在 maxTokens=6000 处被截断，已自动放大到 12000 重试后成功
2. **模型名与 Provider 匹配校验**：发请求前校验前缀（`deepseek-` / `gpt-` / `claude-` / `gemini-`），
   不匹配直接返回 422 并说明「模板里的模型名优先级高于 AI_DEFAULT_MODEL」。
   这个问题很隐蔽：换了 Provider 但数据库模板仍带旧厂商型号时，
   上游只回一个笼统的 `BAD_REQUEST`，看起来像「AI 不稳定」。

> **另一条容易忽略的**：模型名的实际来源是**数据库 `prompt_templates.model`**，
> 不是 `.env`。`AI_DEFAULT_MODEL` 只在「找不到模板」时兜底。
> 改模型后必须执行 `pnpm db:sync-models`，否则改了 `.env` 也无效。

### 3.5 版本化与灰度规则

- **已产生过任务执行的模板禁止就地修改 Prompt 内容**（接口会返回 409 `PROMPT_IMMUTABLE`）。必须新建版本（`version` 自动 +1）。原因：历史任务的 `templateId` 指向同一行，若允许就地改，事后无法确定当时到底用了什么 Prompt。
- 新版本先设 `rolloutPercent: 30` 小流量验证，对比采纳率与人工反馈，再调至 100。
- 停用（`isActive: false`）而非删除，保留历史引用；系统会阻止停用某 key 的最后一个启用版本。

---

## 四、可复用 Prompt 模板库

以下模板已内置到系统（`apps/api/src/modules/ai/prompt-template.service.ts` 的 `DEFAULT_TEMPLATES`），首次启动自动写入数据库，可在「AI 工作台 → Prompt 模板」中直接查看、复制、改版。

### 4.1 脚本生成 `script.generate`

**输入**：`brief`（必填）、`vertical`、`platform`、`duration`、`tone`、`creatorProfile`
**输出**：`{ title, hook, structure, scenes[{index,timeRange,shot,voiceover,note}], hashtags[], risks[] }`
**用于**：内容详情页「AI 生成脚本」、AI 工作台

核心 system prompt 片段：

```
你是聚猩智媒的资深短视频编导，服务过大量剧情类与达人带货类内容，熟悉抖音、小红书、视频号的完播率规律。
硬性要求：
1) 开场 3 秒必须给出强钩子，禁止无效铺垫；
2) 分镜需标注时间区间、景别/运镜、口播文案与拍摄提示；
3) 禁止使用「最」「第一」「绝对」「国家级」等广告法违禁的绝对化用语；
4) 不得编造产品功效、数据或资质；信息不足时在 risks 中说明需要补充什么；
5) 只输出 JSON，不要输出任何解释性文字或 Markdown 代码块标记。
```

### 4.2 标题与封面文案优化 `title.optimize`

**输入**：`originalTitle`（必填）、`brief`、`platform`
**输出**：`{ candidates[{title,reason,score}], keywordSuggestions[] }`
**要点**：要求覆盖不同策略（悬念/数字/反差/利益点/人群定向），每个标题 ≤30 字，不得使用夸张承诺。

### 4.3 达人与品牌需求匹配 `creator.match`

**输入**：`requirement`（必填）、`candidates`（必填，候选达人 JSON）、`budget`、`platform`、`audience`
**输出**：`{ matches[{creatorId,creatorName,score,reasons[],risks[]}], strategy }`
**要点**：明确「只从提供的候选达人中挑选，不得虚构达人」；候选池整体匹配度低时必须在 `strategy` 中直说，不许强行推荐——这是防止 AI 为了「给答案」而误导投放决策的关键约束。

### 4.4 评论区洞察 `comment.insight`

**输入**：`comments`（必填）、`title`、`platform`
**输出**：`{ sentiment{positive,neutral,negative}, topTopics[{topic,count,suggestion}], replyTemplates[] }`
**要点**：情感分布百分比之和必须为 100；话术模板要能直接复制使用。

### 4.5 内容合规预检 `content.compliance`

**输入**：`content`（必填）、`contentType`、`platform`
**输出**：`{ score(0-100), level(PASS|WARN|REJECT), flags[{level,category,snippet,reason,suggestion}], summary }`
**用于**：内容详情页发布前预检，结果回写 `complianceScore` / `complianceFlags`
**要点**：
- 每条风险必须给出**原文片段 + 依据原因 + 具体改写建议**（只报「有风险」没有价值）；
- 必须在 `summary` 中声明「不代替法务出具正式意见」——**AI 不能承担合规责任**，这一条既是免责也是提醒。
- `level` 三档与前端渲染绑定：PASS 绿色可直接发布 / WARN 黄色需修改 / REJECT 红色不可发布。

### 4.6 结算异常解释 `settlement.anomaly`

**输入**：`settlementSummary`（必填）、`settlementItems`、`creatorName`、`period`、`previousSummary`、`question`
**输出**：`{ conclusion, evidence[], suggestion, needManualReview }`
**用于**：运营向达人解释「为什么这个月少了 3000」——这是运营侧最高频、也最费口舌的沟通场景
**要点**：
- 结论先行，直接回答「为什么金额变了」；
- **只用提供的数据作为证据，逐条列出，不得推测未提供的信息**；
- 若数据显示计算可能有误（明细与总额不符、比率异常），必须明确指出并建议人工复核（`needManualReview: true`）——AI 在这里的角色是「帮你读懂数字」，不是「替财务下结论」。

### 4.7 运营日报摘要 `ops.daily_brief`

**输入**：`metrics`（必填）、`date`
**输出**：`{ headline, highlights[], risks[], tomorrowFocus[] }`
**要点**：highlights 必须带具体数字、不写套话；risks 指出需立刻关注的问题（合同到期、结算异常、内容驳回）；`tomorrowFocus` ≤3 条且可执行。

---

## 五、新增一个 AI 能力的标准流程

1. **确认 AI 是必要的**：能用规则/SQL 解决的不要用模型（例如「结算金额合计」永远用 SQL）。AI 只用于**语言理解与生成、非结构化判断、多因素权衡**这三类场景。
2. **定义任务类型**：在 `AiTaskType` 枚举与 `AI_TASK_PRESETS` 中新增，声明 `temperature` / `maxTokens` / `expectsJson` / `expectedFields`。
3. **写 zod schema**：在 `ai-task.service.ts` 的 `OUTPUT_SCHEMAS` 中定义输出结构。用 `.passthrough()` 允许模型多返回字段（不因多余字段判失败），但必填字段必须严格。
4. **写 Prompt 模板**：按第 3 节三段式规范，在 `DEFAULT_TEMPLATES` 中加入默认模板；变量必须声明 `required` 与 `maxLength`。
5. **注册模板 key**：在 `templateKeyOf()` 中加映射。
6. **数据最小化检查**：确认传给模型的字段里没有身份证号、手机号、银行卡号等敏感信息。
7. **接业务入口**：在对应页面加调用入口，**必须传 `idempotencyKey`**、必须有 loading 与失败提示、必须展示 token/成本/耗时。
8. **加人工反馈**：结果卡片提供「采纳 / 拒绝 + 备注」，这是后续评估该功能是否值得保留的唯一依据。
9. **跑通与回归**：`AI_PROVIDER=mock` 下跑通全流程（含前端渲染），确认输出结构被 zod 校验通过。
10. **文档**：把新模板加入本文第 4 节。

---

## 六、AI 使用红线（不可逾越）

| 红线 | 原因 |
| --- | --- |
| AI 不得直接决定打款金额 | 资金决策必须由结算引擎（可复算的确定性逻辑）+ 人工审批完成 |
| AI 不得直接变更达人合作状态、合同条款 | 状态与条款有法律与商务含义，必须由人决策并留痕 |
| AI 不得接收身份证号、银行卡号、密码、令牌 | 合规要求；此类数据一旦出境/入第三方服务即为违规 |
| AI 输出不得直接作为对外发布内容 | 必须经内容审核角色确认（系统强制 `content:review` 权限） |
| AI 不得作为合规审核的唯一依据 | 合规预检只是辅助，正式判断由人负责（Prompt 中已显式声明） |
| 不得在无超时、无预算上限的情况下放开调用 | 会造成成本失控与服务雪崩 |

---

## 七、用 AI 写代码：本项目的真实复盘

> JD 要求「熟练使用 AI 编码工具」，并「能审查和优化 AI 生成的代码」。这一节是这条要求的实证材料——记录 AI 生成代码在本项目里**真实产生过的缺陷类型**，以及应对方式。比罗列工具名有用得多。

### 7.1 AI 生成代码最容易出的三类问题（本项目实测）

| 问题类型 | 具体表现 | 为什么难发现 |
| --- | --- | --- |
| **跨边界不一致** | 前端枚举与后端 `schema.prisma` 各写一份，15 个枚举里 9 个对不上（`PENDING` vs `QUEUED`、`CANCELLED` vs `CANCELED`、`FIXED` vs `FIXED_FEE`） | TypeScript 只能保证「前端和自己一致」：声明和使用都在前端一侧，`status === 'PENDING'` 永远自洽，**原理上查不出** |
| **"看起来对"的通用实现** | 内容状态被写成 `DRAFT/PENDING_REVIEW/APPROVED` 这套通用审批流，而业务实际是「选题→脚本→拍摄→剪辑→内审→平台审→发布」的生产流水线 | 代码能跑、类型也对，只是**和业务无关**。需要人拿业务事实去对照 |
| **检查本身是坏的** | 前端 `typecheck` 写成 `tsc --noEmit` 却指向 solution 配置，实际检查 0 个文件却一直报 0 error | 「检查通过」本身就是虚假信号，比没有检查更危险 |

### 7.2 三条应对规则

**规则 1：跨边界的一致性，必须由「另一侧的事实」来验证，不能靠类型系统。**

前端枚举是手写的，那么验证它的事实来源只能是 `schema.prisma`。为此建立了 `pnpm enum:check`（见 [README §8.2](../README.md)），四层检查：枚举成员逐个比对、标签映射完整性、自由文本字段的取值约定、页面里的裸字面量扫描。

**规则 2：任何新写的校验脚本，必须自带 `--self-test`。**

用构造数据证明「它确实会报错」。理由：一个因为正则写坏、路径失效或逻辑短路而永远输出「通过」的脚本，**把「没有检查」包装成了「检查通过」**——这比不写脚本更糟。

> 这条规则在本项目立刻见效：`check-enum-drift.mjs` 第一版把「可疑字面量」的正则写成**强制要求至少一个下划线**，于是 `'PENDING'` / `'FALLBACK'` 这两个单词型取值全部漏检——而它们恰恰是最典型的事故值。是 `--self-test` 里的用例把这个漏洞暴露出来的，而不是等到线上出事。

**规则 3：AI 生成的「业务枚举/状态机」，必须由人拿业务事实逐项确认。**

`ProjectStatus` 被生成成 `PLANNING/IN_PROGRESS/DELIVERING/PAUSED/CANCELLED` 时，代码是完全自洽的——问题不在代码质量，而在**它与后端和业务定义不一致**。这类问题只能靠人问一句「这个状态在后端叫什么？业务上真的存在吗？」来拦住。

### 7.3 有效的 Prompt 约束（写代码场景）

真正减少返工的约束，是**把事实来源明确写进上下文**，而不是笼统地要求「写好一点」：

| 差的写法 | 好的写法 | 效果差异 |
| --- | --- | --- |
| 「加一个项目状态筛选」 | 「加一个项目状态筛选。**状态取值必须从 `prisma/schema.prisma` 的 `enum ProjectStatus` 原样复制**，不得自行发明或改写拼写」 | 前者产出 5 个不存在的状态；后者可以直接用 |
| 「写个表单校验」 | 「校验规则必须与 `CreateProjectDto` 的装饰器一致；**后端启用了 `forbidNonWhitelisted`**，所以请求体字段名必须与 DTO 完全一致，不得多传」 | 前者会多传 `status`/`description` 导致 400 |
| 「补充类型定义」 | 「前端类型必须与后端 DTO/OpenAPI 逐字段对齐。**如果发现后端缺少你需要的字段，先告诉我，不要在前端自行补充**」 | 前者会造出后端不存在的字段 |
| 「优化这段代码」 | 「改写时保持对外行为不变，并说明改了什么、为什么；**不要顺手修改未提及的文件**」 | 前者会扩大改动面，让 review 成本失控 |

**一句话总结**：对 AI 生成代码，「编译通过 / 测试通过」只是起点；真正的审查动作是**追问每个跨边界取值的事实来源**，并把结论固化成机器可检的脚本。

---

## 八、评测与迭代

**上线新 Prompt 版本的对比方法**（数据来自 `GET /api/ai/usage` 与任务列表）：

| 指标 | 含义 | 判断标准 |
| --- | --- | --- |
| 采纳率 | `humanFeedback=1` / (1 + -1) | 新版本应不低于旧版本；< 50% 说明能力不成立，应下掉 |
| 结构失效率 | `errorCode=SCHEMA_MISMATCH` / `INVALID_OUTPUT` 占比 | 应 < 3%；升高说明 Prompt 约束变弱 |
| 降级率 | `status=FALLBACK_USED` 占比 | 持续偏高说明主 Provider 不稳定或超时设置过紧 |
| 平均延迟 | `avgLatencyMs` | 脚本生成 > 20s 会明显影响使用体验，应考虑流式输出 |
| 单位成本 | `costCents` 均值 | 剧本类任务单次成本应可控在可接受区间 |

**当前欠缺、下一步要做**：

1. **流式输出**：脚本生成类任务等待 10-20 秒体验不佳，应改为 SSE 流式返回。
2. **Prompt A/B 的自动统计**：当前 `rolloutPercent` 只做流量切分，尚未自动对比两版本指标。
3. **语义缓存**：相似 brief 可复用结果（按 embedding 相似度），能显著降低重复成本；需先验证业务上是否接受「相似而非精确」的复用。
4. **离线评测集**：为脚本生成/合规预检建立人工标注的小样本评测集，让 Prompt 改动有回归依据，而不是只看线上采纳率。
