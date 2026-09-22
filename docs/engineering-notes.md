# 工程实践与踩坑记录

> 本文收纳不适合放在 [README](../README.md) 里的内容：跨边界一致性校验的设计与由来、真实缺陷复盘、验证状态与自查方式。
>
> README 是**介绍文档**（这个项目是什么、怎么跑起来）；本文是**工程记录**（做的时候踩了什么、现在验到什么程度）。
> 排查具体故障请看 [deployment.md §9 常见故障排查](deployment.md)。

---

## 1. 跨边界一致性校验

### 1.1 为什么需要：类型检查查不出「跨边界」的漂移

前端类型是手写的，与后端 DTO / `schema.prisma` 各自演进。这里有一个**类型系统原理上无法覆盖**的盲区：

```ts
// apps/web/src/api/types.ts —— 前端自己声明
export type AiTaskStatus = 'PENDING' | 'RUNNING' | ...;

// 某个页面 —— 前端自己使用
if (data.status === 'PENDING') { ... }
```

`===` 两边都取自**同一个手写联合类型**，所以永远自洽、永远编译通过。类型系统只能保证「前端和自己一致」，**不能保证「前端和后端一致」**。要发现跨边界不一致，必须引入另一侧的事实 —— `schema.prisma` 或导出的 OpenAPI 规范。

为此本项目有两条独立的校验链路：**字段级**（`openapi:check`）与**取值级**（`enum:check`）。

### 1.2 契约校验：`pnpm openapi:check`

拦的是「前端提交了后端 DTO 里没有的字段」。后端启用了 `forbidNonWhitelisted`（防止客户端注入 `status` / `ownerId` 等本不该由前端控制的字段），多传字段会被直接拒绝。

```bash
pnpm openapi:export    # 导出后端 OpenAPI 规范到 docs/openapi.json（62 接口 / 41 模型）
pnpm openapi:check     # 校验前端请求类型是否与规范一致
```

实现要点：

- **导出不需要启动服务器、不需要数据库**：进程内 `app.init()` 后调 `SwaggerModule.createDocument`，Swagger 只读控制器与 DTO 的装饰器元数据。
- **文档定义单点**：`src/config/swagger.config.ts` 同时服务 Swagger UI 与导出脚本，避免「UI 上有、导出的 spec 里没有」。
- **校验刻意做窄**：只比对请求体字段名。响应类型字段多、前端常只用一部分，全量比对会产生噪音 —— **一个总在报警的检查等于没有检查**。
- **`Partial<X>` 视为 PATCH 语义**：允许只传部分字段，不报「缺少字段」。

历史上拦下并处理的漂移：

| 漂移 | 性质 | 处理 |
| --- | --- | --- |
| `CreateProjectRequest` 多提交 `status` | **会导致 400**（用户可见故障） | 移除字段与表单状态下拉，状态流转改走状态机接口 |
| `CreateProjectRequest` 多提交 `description` | **会导致 400** | 改为后端字段名 `brief`，含 `ProjectDetail` 响应类型一并纠正 |
| `UpdateContentRequest` 继承 `status` | **会导致 400** | 改为 `Partial<Omit<CreateContentRequest, 'status'>>` |
| `CreateContractRequest` 缺 `cpaUnitPrice` / `exclusivityScope` | 功能缺口 | 已补类型 |
| `TerminateContractRequest` 缺 `force` | 功能缺口 | 已补类型（含后端的「未结清结算单」保护） |
| `GenerateSettlementRequest` 缺 `month` | 功能缺口 | 已补类型，并接入结算页：同月账期自动按 `month` 出账，避免前端自己算月末（闰年 2 月、跨年 12 月易错） |

**仍有 3 处功能缺口**（类型已补，但表单尚未暴露对应输入控件）：

| 前端类型 | 字段 | 说明 |
| --- | --- | --- |
| `CreateContractRequest` | `cpaUnitPrice`、`exclusivityScope` | 需在合同表单加 CPA 单价与独家范围输入 |
| `TerminateContractRequest` | `force` | 需在终止确认框加「强制终止」开关（未结清时后端会 409 提示） |
| `UpdateUserRequest` | `avatarUrl`、`status` | 需在员工表单加头像与启停用 |

这些**不会导致运行时报错**（少传字段是合法请求），补齐后功能才算真正可用。

### 1.3 枚举一致性校验：`pnpm enum:check`

契约校验只比对**请求体字段名**，覆盖不到另一类同样隐蔽的漂移：**枚举取值**。实测 15 个后端枚举里有 **9 个**对不上：

| 前端写的 | 后端实际的 | 后果 |
| --- | --- | --- |
| `ContractStatus` 多了 `APPROVED`/`REJECTED` | `DRAFT/PENDING_REVIEW/ACTIVE/EXPIRED/TERMINATED` | 合同列表筛选直接 400 |
| `ProjectStatus`: `PLANNING/IN_PROGRESS/DELIVERING/PAUSED/CANCELLED` | `DRAFT/SCHEDULED/IN_PRODUCTION/IN_REVIEW/PUBLISHED/COMPLETED/CANCELED` | 项目筛选 400；且 `CANCELED` 被拼成双 L 的 `CANCELLED` |
| `ContentStatus`: `DRAFT/PENDING_REVIEW/APPROVED/SCHEDULED` | `IDEA/SCRIPTING/SHOOTING/EDITING/INTERNAL_REVIEW/PLATFORM_REVIEW/PUBLISHED/REJECTED/OFFLINE` | 内容看板的**「审核」按钮永不出现**（判断条件是不存在的 `PENDING_REVIEW`） |
| `SettlementStatus` 用了 `CANCELLED` | 末态是 `VOID` | 已作废结算单被误报「逾期」 |
| `AiTaskStatus`: `PENDING`/`FALLBACK` | `QUEUED`/`RUNNING`/`SUCCEEDED`/`FAILED`/`FALLBACK_USED`/`REJECTED` | 任务轮询条件里 `PENDING` 永不命中；`REJECTED` 无展示分支 |
| `SettlementMode`: `FIXED`/`MIXED` | `FIXED_FEE`/`REVENUE_SHARE`/`HYBRID`/`CPA` | 合同表单提交 400 |
| `UserStatus` 多了 `LOCKED` | 只有 `ACTIVE`/`DISABLED` | 状态标签渲染 `undefined` |
| `DataSource` 少了 `MOCK` | `…/MANUAL/MOCK` | 仿真账号来源标签 `undefined` |
| `AgencyType`: `NONE/MCN/AGENCY/STUDIO` | `FULL_MCN/COMMERCIAL/INDEPENDENT` | 达人表单提交 400 |
| `PendingTodo.type` 声明成 `string`，徽标键写成 `CONTRACT_PENDING_REVIEW` 等 | `NotificationType`：`CONTRACT_EXPIRING`/`CONTENT_REVIEW`/`SETTLEMENT_DUE`/… | **侧边栏红点一个都不显示** |
| `Tag.category`: `STYLE/SCENE/PRICE/…` | DTO 与 seed 用 `capability`/`category`/`risk`/`custom` | 静默把没人认识的分类写库 |

一个放大因素：`apps/web/package.json` 的 `typecheck` 原先写的是 `tsc --noEmit`，而 `apps/web/tsconfig.json` 是 `{ "files": [], "references": [...] }` 形式的 solution 配置 —— **`tsc` 对它执行的结果是「检查 0 个文件」**。于是「前端 typecheck 0 error」这句话一直是假的，上面每一处漂移都被这一行悄悄吞掉。改成显式 `-p tsconfig.app.json` 后，同一个仓库立刻冒出 **24 个真实类型错误**。

#### 校验脚本做了什么

`scripts/check-enum-drift.mjs` 以 `schema.prisma` 为唯一事实来源，做四件事：

1. **枚举成员逐个比对**：前端的联合类型必须与后端 enum **完全相等**（多了、少了、拼错都报错）。
2. **标签映射完整性**：`Record<EnumType, string>` 的中文标签表必须覆盖全部成员，否则页面会渲染 `undefined`。
3. **自由文本字段的取值约定**：`SettlementItem.itemType` 是 `VarChar` 不是 enum，脚本会**从 schema 的行尾注释里解析**允许值再比对（保证跟着 schema 走，而不是另抄一份）。
4. **扫描页面里的裸字面量**：唯一能抓到「页面里直接写 `=== 'PENDING'`」的检查。它把源码里所有全大写字面量与「所有已知合法取值」对照，不在集合里就报错。

```bash
pnpm enum:check        # 校验枚举漂移
pnpm enum:selftest     # 只验证校验脚本自身有效（11 个用例）
pnpm verify            # enum:check + 全仓 typecheck + 全仓 test
```

脚本还把**权限点、业务错误码**直接从后端源码解析出来作为已知集合（而不是在前端脚本里再抄一份），所以后端新增错误码/权限点时它会自动跟上。

### 1.4 校验失败的提示链路：`fieldErrors`

后端校验失败原本只返回扁平的英文消息数组，字段名混在句子里：

```json
{ "code": "VALIDATION_FAILED", "details": ["brandId must be a UUID", "结算模式非法"] }
```

问题在于：自定义 message（如「结算模式非法」）里**根本没有字段名**，调用方想据此标红输入框就只能去解析英文句子 —— 既不可靠，也不该由前端承担。而前端全局错误提示又写着「请检查标红字段后重试」，两边一凑，用户看到的就是**一句让去看红字段、但一个红字段都没有的提示**。

现在后端在保留 `details` 的同时**追加**结构化的 `fieldErrors`（键就是 DTO 属性名）：

```json
{
  "code": "VALIDATION_FAILED",
  "details": ["creatorId must be a UUID", "结算模式非法"],
  "fieldErrors": {
    "creatorId": ["creatorId must be a UUID"],
    "settlementMode": ["结算模式非法"]
  }
}
```

**两条实现上的硬要求**（都踩过坑）：

1. **「用于标红的字段」和「用于展示的原因」必须是两个来源。** 有一类校验错误没有对应输入框（`forbidNonWhitelisted` 拦下的「多传未声明字段」），后端刻意不把它放进 `fieldErrors`。前端若只用 `fieldErrors` 拼提示，这类错误会让提示退化成泛化文案 —— 恰好盖住了用户最常遇到的情况。展示必须用完整的 `details`。
2. **前端不得解析 `message` 文本做逻辑判断。** 判断依据只能是 `code` 与 `fieldErrors` 的键。

完整契约见 [api.md §2.3](api.md)。

---

## 2. 真实缺陷复盘

### 2.1 「能跑起来」与「类型检查通过」之间的鸿沟

项目从「代码写完」到「端到端测试通过」，修掉了 **15 个真实缺陷**，而**没有一个是当时的类型检查或单元测试能发现的**：

| 缺陷 | 后果 | 只有什么能发现 |
| --- | --- | --- |
| 启用了 header 版本控制但无控制器标 `@Version()` | **整个 API 对不带 `X-API-Version` 的请求返回 404**，包括前端自己 | 发真实 HTTP 请求 |
| refresh token 载荷完全确定性（无 `jti`，`iat` 秒级） | 同秒内签发两次得到**字节相同**的 token → 撞 `tokenHash` 唯一约束 → **前端首屏自动刷新必然失败** | 端到端测试 |
| `generate` 漏传 `dto.month` | 传月份参数直接 500（`resolvePeriod` 抛普通 Error） | 端到端测试 |
| `ScopedAccessError` 继承 `Error` 而非 `HttpException` | 越权访问报 **500 而非 403**，监控会把正常拦截当服务故障告警 | 端到端测试 |
| `calculationTrace` 记录未生效的比例 | 阶梯命中 80% 却被封顶压回 70%，trace 却写「调整为 80%」——**财务复算依据里存了假信息** | 单元测试（新加用例） |
| 6 个权限「已定义、已写进文档，但未分配给任何角色」 | `contract:approve` 只挂管理员 → 每份合同都得找管理员批 | 单元测试（权限矩阵完整性） |
| 26 个文件的相对导入层级写错一级 | 100+ 条 TS2307，真实错误被淹没 | `tsc` |
| `Settlement.creator` 关系字段缺失 | 结算单按达人做数据范围过滤无法编译 | `tsc`（生成客户端后） |
| `AuthService.assertFreshPermission` 变量遮蔽 | 实际是「用自己的 id 查自己」，**资金操作的实时权限复核形同失效** | `tsc` + 代码审查 |
| 数组类查询参数传单个值时把字符串塞给 Prisma 的 `in` | `?status=ACTIVE` 直接报参数错误（传两个值反而正常，典型漏测形态） | 真实请求（且必须是单值形式） |
| 原始 SQL 用 snake_case 列名（`c.published_at`） | 看板趋势图整个接口 400；Prisma 的查询构建器会做列名映射，原始 SQL 不会 | 真实请求 |
| Prompt 模板的模型名写死为 `gpt-4o-mini` | 换 Provider 后数据库模板仍带旧厂商型号 → 上游 BAD_REQUEST → 静默降级到 mock | 真实模型调用 |
| **前端 `typecheck` 脚本实际检查 0 个文件** | 指向 solution 配置 → **所有前端类型错误被静默吞掉**，却一直报 0 error | 换用真实 tsconfig 后立刻暴露 24 个错误 |
| **9 个前端枚举与后端 enum 不一致** | 筛选 400、内容审核入口永不显示、AI 任务轮询失效、侧边栏红点全不显示…… 见 [§1.3](#13-枚举一致性校验pnpm-enumcheck) | 拿 `schema.prisma` 当事实来源逐一比对（TypeScript 原理上查不出） |
| **校验失败的提示在骗人** | 文案让用户去看「标红字段」，而前端从不消费字段错误去标红 —— 一个 5 秒能解决的问题变成无法自助排查的故障 | 构造一次真实 400，看提示是否说清了**具体哪个字段、为什么错** |

**结论**：类型检查证明「类型自洽」，单元测试证明「纯逻辑正确」，但**都证明不了服务可用**。端到端测试与真实启动是不可替代的一层。

**而最后两行是更狠的一课**：前 13 个缺陷至少还有「某个检查能发现」；最后两行是**检查本身是坏的** —— 一个永远输出「0 error」的类型检查，比没有类型检查更危险，因为它提供了虚假的安全感。所以修完之后，除了修 bug，还必须做两件事：

1. **把这类问题变成机械可检的**：`scripts/check-enum-drift.mjs`；
2. **验证检查本身有效**：脚本自带 `--self-test`（11 个用例，用构造数据证明它**确实会报错**）。

> 第 2 点立刻有回报：脚本第一版把「可疑字面量」的正则写成强制要求至少一个下划线，于是 `'PENDING'` / `'FALLBACK'` 这两个单词型取值全被漏掉 —— 而它们正是最典型的事故值。是 `--self-test` 把这个漏洞暴露出来的。**没有自检的校验脚本，只是把「没有检查」包装成了「检查通过」。**

### 2.2 首次 `typecheck` 暴露并已修复的缺陷

生成 Prisma 客户端之后，一批「只有类型系统能发现」的问题才浮出水面：

| 缺陷 | 性质 | 影响 |
| --- | --- | --- |
| `Settlement.creator` 关系字段缺失 | 数据模型缺口 | 结算单的「按达人数据范围过滤」与「查达人姓名」全部无法编译 |
| `Content.code` / `Content.syncError` 未落库 | 数据模型缺口 | 已按这些字段写的代码在类型层直接不匹配 |
| `PlatformAccount.totalLikes` 等字段读取报错 | 返回类型过窄 | `collectAccount` 的内联返回类型漏了 4 个字段，改为复用 `AccountStats` |
| `AuthService.assertFreshPermission` 变量遮蔽 | **逻辑错误** | 内层 `user` 遮蔽了入参，实际是「用自己的 id 查自己」，实时权限复核形同失效 |
| `DashboardService` 的 `groupBy` 缺 `orderBy`、`_count: true` 类型不安全 | Prisma API 误用 | `_count: true` 的类型是 `number \| undefined`，下游算术运算全部报 possibly undefined |
| 结算/看板用 `creator` 过滤（不存在的字段） | Prisma API 误用 | 按数据范围过滤结算单时会直接运行时报错 |
| 合同详情与预估的归属校验用了 `createdById` | **业务规则错误** | 「商务 A 拟的合同交接给 B 后 B 看不到」「运营代拟的合同所有商务都能看到」，已改为按达人归属判定 |
| `passport-jwt` / `@types/passport-jwt` 未声明 | 依赖缺失 | `jwt.strategy.ts` 无法编译 |
| 7 个声明但零引用的依赖 | 依赖冗余 | `@nestjs/terminus`、`nestjs-pino`、`pino`、`pino-http`、`pino-pretty`、`ioredis`、`cache-manager`、`nanoid` 全部无引用，已移除 |
| 26 个文件的相对导入层级写错一级 | 机械性但影响面大 | 修正后 TS2307 从 100+ 归零 |
| 4 处 `groupBy` 缺 `orderBy` | Prisma API 误用 | 缺少 `orderBy` 时 Prisma 会解析到「返回数组」的重载，报 `is missing properties: length, pop, push` —— 报错完全看不出真实原因 |

### 2.3 单元测试暴露并已修复的缺陷

类型检查全绿之后，**测试又抓出两类问题**，都是类型系统看不见的：

| 缺陷 | 性质 | 影响 |
| --- | --- | --- |
| `calculationTrace` 记录了未生效的比例 | **数据可信度问题** | 阶梯命中 80% 时先写入 trace，随后封顶逻辑把比例压回 70%，trace 里留下一个**从未生效**的比例。这份 trace 是财务与达人复算金额的依据，记录假信息比不记录更糟。已改为先算最终生效值再写 trace，并加测试锁定 |
| 测试用例自相矛盾 | 测试缺陷 | 「阶梯生效」的用例同时设了会触发封顶的公司分成（30% + 80% = 110%），一个用例期望两件冲突的事 |
| `contract:approve` 等 6 个权限定义了但没分配给任何角色 | **权限漏配** | `contract:approve` 只挂在管理员身上，等于「每份合同都得找管理员批」。根因是测试自己维护了一份 `ADMIN_ONLY_PERMISSIONS` 副本、只列了一项，与文档形成两套事实。已抽出唯一来源常量，测试直接引用它 |

---

## 3. 验证状态

### 3.1 已验证

| 项目 | 方式 | 结果 |
| --- | --- | --- |
| 后端类型检查 | `pnpm -r typecheck`（真实 Prisma 客户端） | ✅ 0 错误 |
| 前端类型检查 | `tsc -p apps/web/tsconfig.app.json --noEmit` | ✅ 0 错误（修正 `typecheck` 脚本后先暴露出 24 个真实错误，已全部修复） |
| 后端单元测试 | `pnpm --filter @creatorops/api test`（vitest） | ✅ 61/61 通过（结算引擎 36 + 权限矩阵 26） |
| 端到端测试 | `pnpm test:e2e`（真实数据库 + 真实 HTTP） | ✅ 29/29 通过 |
| 金额守恒不变量 | 穷举 300+ 组参数，断言 `平台费 + 公司 + 达人 === 总流水` 且各部分非负 | ✅ 通过 |
| 数据库迁移与种子数据 | `db:deploy` 在干净库上建表（18 张业务表 + `code_sequences`）、`db:seed` 写入自洽演示数据 | ✅ 通过 |
| 服务可启动、接口可达 | `pnpm dev` 后逐一探测路由与健康检查 | ✅ 通过 |
| 真实模型调用 | `AI_PROVIDER=deepseek` + `deepseek-flash`，实际生成脚本 | ✅ `status=SUCCEEDED`，JSON 输出通过 zod 结构校验 |
| 后端 Prisma 使用一致性 | `pnpm check:prisma-usage`（自研脚本，无需生成客户端） | ✅ 88 个源文件与 `schema.prisma` 的 18 模型 / 15 枚举一致 |
| 前后端枚举一致性 | `pnpm enum:check` | ✅ 15 个枚举 + 标签映射 + 裸字面量扫描全部通过 |
| enum:check 脚本自检 | `pnpm enum:selftest` | ✅ 11/11 通过 |
| 校验错误提示链路 | 用真实 HTTP 构造 4 类 400，把响应喂给前端展示逻辑 | ✅ 每条都能说出**具体字段与原因**，中文可读 |
| 前端静态一致性 | `node apps/web/scripts/static-check.mjs` | ✅ 模块路径、CSS Module 类名、未使用导入、页面默认导出均通过 |

> **90 个自动化测试全部通过**（61 单测 + 29 e2e）。最关键的三个断言：
> 1）金额守恒穷举 —— 证明多级分成在任意参数下不漏分不多分；
> 2）refresh token 重放检测 —— 撤销整个会话族；
> 3）数据范围 —— 商务访问非自己负责达人的合同返回 403 `SCOPE_DENIED`。
>
> ⚠️ 但这 90 个测试全绿的同时，前端曾有 24 个真实类型错误和 9 个枚举漂移。原因见 [§1.3](#13-枚举一致性校验pnpm-enumcheck)。
> 这条教训比任何测试数量都重要：**「检查通过」必须先确认它真的检查了东西。**

### 3.2 尚未验证

| 项目 | 说明 |
| --- | --- |
| 生产构建 `pnpm build` | 前端 `vite build` 与后端 `nest build` 尚未执行 |
| 界面人工走查 | 接口层已通过真实请求验证，浏览器内的交互流程未逐页走查 |
| 生产部署 | Nginx / PM2 / k8s 配置已写好但未在真实环境验证 |
| CI 流水线 | `.github/workflows/ci.yml` 已编写，未在 GitHub 上实跑 |
| `pnpm -r lint` | 在 api 侧**必然失败**：`apps/api` 声明了 lint 脚本但缺 eslint 依赖与配置 |
| `apps/api/Dockerfile` | 缺失，`docker compose --profile full` 无法构建（`pnpm infra:up` 不受影响） |
| 前端测试覆盖 | `apps/web` 只有 1 个测试文件（`src/utils/validationMessages.test.ts`），组件与交互无自动化测试 |

### 3.3 复跑方式

```bash
# 静态层：无需数据库，秒级出结果
pnpm enum:check            # 前后端枚举一致性
pnpm enum:selftest         # 校验脚本自身的 11 个用例
pnpm -r typecheck
pnpm verify                # = enum:check + typecheck + test

# 数据与集成层
pnpm infra:up              # 或 pnpm db:setup（本机 PostgreSQL）
pnpm --filter @creatorops/api prisma:deploy
pnpm db:seed
pnpm test:e2e
pnpm build
pnpm dev
```

### 3.4 校验脚本自身的注意事项

- `check-prisma-usage.mjs` 自带自检：解析出的模型名必须匹配 `^[A-Z]\w+$`、枚举必须有成员，否则以退出码 2 报「校验器内部错误」—— 避免校验器自身出错时给出假绿。
- 该脚本还发现过自身缺陷：早期版本用 `^model\s+(\w+)` 匹配，把 schema 文档注释里的示例文本也当成模型声明，报出的模型数与实际不符。修正为要求「关键字 + 名称 + 左花括号在同一行」后才与真实模型数一致。
- `check-enum-drift.mjs` 同样自带 `--self-test`，并**刻意跳过注释** —— 因为注释里经常故意写出历史错误取值做说明，若不跳过就会把有价值的文档逼成「删掉或加进白名单」。
- **新增任何一致性校验脚本，都必须自带 `--self-test`。** 一个因为正则写坏、路径失效或逻辑短路而永远输出「通过」的脚本，比不写脚本更糟 —— 它把「没有检查」包装成了「检查通过」。
