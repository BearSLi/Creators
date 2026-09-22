# CreatorOps 技术评审材料

> **用途**：一次可执行的技术评审（建议 60–90 分钟）的评审包。本文不是项目介绍，而是**给评审人用的作战地图**：先看证据分级，再按清单逐项验证，最后对需要决策的 6 个开放问题给结论。
> **评审人的默认立场**：假定文档可能一厢情愿。凡本文标注"未验证"的，都要当作**待证事项**而非结论。

---

## 0. 评审目标与产出

| 项 | 内容 |
| --- | --- |
| 评审对象 | CreatorOps（达人合作管理平台），后端 88 源文件/约 13,385 行，前端 64 个 `.ts\|.tsx`/约 19,603 行 |
| 评审目标 | ① 确认资金链路正确性；② 确认安全边界不可绕过；③ 确认可上线性（构建/迁移/部署）；④ 对 6 个开放设计问题给出结论 |
| 期望产出 | 一份「阻断项清单 + 决策记录 + 责任人与时限」，而不是一句"整体不错" |
| 不评审 | 业务需求合理性、UI 美观度、代码风格（风格由 CI 的 lint 承担） |

---

## 1. 议程（90 分钟版）

| 时段 | 内容 | 谁主导 | 产出 |
| --- | --- | --- | --- |
| 0–5 min | 定位与规模基线 | 作者 | 对齐上下文 |
| 5–25 min | **资金链路走查**（结算引擎 + 幂等 + 事务边界） | 作者 + 财务/后端评审人 | 阻断项 |
| 25–40 min | **安全边界走查**（三级权限 + 审计 + 敏感数据） | 作者 + 安全评审人 | 阻断项 |
| 40–55 min | **可上线性走查**（构建/迁移/部署/多实例） | 作者 + SRE 评审人 | **预计 3 个阻断项** |
| 55–75 min | **AI 治理走查**（成本/降级/校验/边界） | 作者 + AI/产品评审人 | 改进项 |
| 75–90 min | 6 个开放问题决策 | 全体 | 决策记录 |

**建议邀请**：后端负责人、财务/内控代表（资金链路必须有人）、安全或合规代表、SRE、AI 负责人（若面 AI 治理）。

---

## 2. 证据分级（先看这个，避免误信）

| 级别 | 定义 | 本次评审中的例子 |
| --- | --- | --- |
| **A · 已验证** | 有可复现的执行结果 | `check-prisma-usage.mjs` 通过（88 源文件模型/枚举一致）；`static-check.mjs` 通过（64 文件）；前端曾用独立临时工程跑 `tsc -b --force` 退出码 0 |
| **B · 静态可核** | 读代码即可确认，不需要运行 | 39 个权限点与 6 角色矩阵；`schema.prisma` 18 模型/15 枚举；6 个 `@Cron`；结算守恒的 `throw` 断言；三层幂等约束在 schema 中 |
| **C · 设计已声明、执行未验证** | 代码/文档已写，但从未跑过 | 结算引擎 300+ 组守恒穷举测试；权限矩阵 spec；e2e（`core-flow.e2e-spec.ts` 360 行，覆盖资金主链路与权限红线）；前端 0 测试；`migrate` + `seed` 幂等；CI 四道关 |
| **D · 推断** | 由 A/B 证据推导，未直接确认 | 18 张业务表目前只能靠 `prisma migrate dev` 在开发库创建（因无初始建表迁移） |

> **评审纪律**：任何结论若仅基于 C 级证据，评审记录里必须写"待执行验证"，不能写成"已通过"。

---

## 3. 十项核心结论（逐项附可核证据与状态）

| # | 结论 | 状态 | 可核证据 |
| --- | --- | --- | --- |
| 1 | 结算金额守恒由恒等式保证，而非近似 | **B** | `settlement.calculator.ts`：`agencyShareCents = netCents - talentGrossCents`（反推而非独立相乘）+ `reconstructed !== grossCents` 时 `throw` |
| 2 | 重复出账有三层防护 | **B** | `schema.prisma`：`Settlement @@unique([creatorId, periodStart, periodEnd])`、`SettlementItem.idempotencyKey @unique`；`settlement.service.ts`：已存在非 VOID 单据直接跳过 |
| 3 | 单人失败不阻断批量结算 | **B** | `settlement.service.ts#generate` 内 `for` + `try/catch` + `generateForCreator` 独立 `withTransaction`，失败进 `skippedReasons` |
| 4 | 合同口径歧义会中断而非猜测 | **B** | `settlement.service.ts`：`contracts.length > 1` 抛 `UnprocessableException` 并列出冲突合同编号 |
| 5 | 权限为三级校验，详情接口有归属复核 | **B** | `permissions.ts`（39 权限点）+ `scope.ts#buildScopeFilter` + `scope.ts#assertOwnership`；`settlement.service.ts#findOne` 显式查 `creator` 可见性 |
| 6 | 审计为声明式横切，敏感字段自动脱敏 | **B** | `audit.interceptor.ts`：`@Audit()` 元数据 + `SENSITIVE_BODY_KEYS` 掩码 + 审计失败不回滚业务 |
| 7 | AI 成本治理链路完整 | **B** | `ai-task.service.ts`：`idempotencyKey` 唯一约束查询 → `assertBudgetAvailable` → `callWithRetry`（仅 `retryable`）→ `resolveFallback` → `OUTPUT_SCHEMAS.safeParse` → 回写 `costCents`/token/`retryCount`/`fallbackReason` |
| 8 | Prompt 注入面被主动收敛 | **B** | `prompt-renderer.ts`：只用 `\{\{name\}\}` 正则替换，**无表达式求值**；`parseVariableSpecs` 把 `maxLength` 钳制在 1–20000 |
| 9 | 无 API Key 也能跑通全链路 | **A/B** | `mock.provider.ts`（FNV-1a 种子 → 确定性输出 + 30–120ms 模拟延迟，覆盖 7 类任务）；`metrics-collector.service.ts#MockCollectorDriver` |
| 10 | 业务编号原子自增、失败回滚 | **B** | `migrations/20260101000000_init_code_sequences/migration.sql`：`code_sequences` 表；`CodeGeneratorService.next(prefix, tx)` 要求在业务事务内调用 |

---

## 4. 阻断项（P0）——上线前必须闭合

> 以下 3 项**已核实**为当前事实，不是推测。建议评审会第一件事就是把它们登记为阻断项。

### B-1 迁移文件不足以建库（最高风险）

- **事实**：`apps/api/prisma/migrations/` 只有 2 个文件夹——`20260101000000_init_code_sequences`（仅建 `code_sequences` 表）与 `20260201000000_fix_data_source_and_project_scope`（对 `projects`/`contents` 做兼容性补列）。**没有 Prisma 生成的初始建表迁移。**
- **推断（D 级）**：18 张业务表目前只能靠 `prisma migrate dev` 在开发库即时创建。
- **后果**：`docs/deployment.md` §3.3 明确规定"生产只用 `migrate deploy`"（因为 `migrate dev` 会检测 schema 漂移并可能触发重置）。若此推断成立，**生产发布流水线无法在干净库建出表结构**。
- **验证方式**：`createdb creatorops_review && DATABASE_URL=...creatorops_review pnpm --filter @creatorops/api prisma:deploy`，然后 `\dt` 看表数量。
- **闭合标准**：`migrate deploy` 在空库后 `\dt` 列出 18 张表 + `_prisma_migrations`；随后连跑两次 `pnpm db:seed` 结果幂等。

### B-2 api 侧无 eslint 依赖与配置（CI 第一道关必然失败）

- **事实**：`apps/api/package.json` 声明 `"lint": "eslint \"src/**/*.ts\" --max-warnings 0"`，但 **`apps/api` 的 devDependencies 里没有 eslint**；全仓唯一的 eslint 配置是 `apps/web/.eslintrc.cjs`，**api 侧无任何 eslint 配置**（`.eslintrc*` / `eslint.config.*` 均不存在）。
- **后果**：CI 第一道关的 `pnpm -r lint` 在 api 步骤失败 → 后续三道关不会执行。`--max-warnings 0` 的严格标准实际上从未生效。
- **次要发现**：`apps/api/package.json` 的 scripts 里 `"verify"` 与 `"lint"` **写在同一行**（缺少换行），JSON 仍然合法但可读性受损，属同一次修复的顺手项。
- **闭合标准**：补 `eslint` + `@typescript-eslint/*` 依赖与 `apps/api/.eslintrc.cjs`，`pnpm -r lint` 本地退出码 0。

### B-3 `apps/api/Dockerfile` 缺失（全栈容器化不可构建）

- **事实**：`docker-compose.yml` 的 `api` 服务 `build.dockerfile: apps/api/Dockerfile`，但该文件**不存在**；仓库中只有 `apps/web/Dockerfile` 与 `apps/web/nginx.conf`。
- **后果**：`docker compose --profile full up -d --build`（`docs/deployment.md` §3.2 描述的路径）失败；该节描述的"api 多阶段构建（deps → build → runner）、非 root 用户运行"与实际文件不一致。
- **不受影响**：`pnpm infra:up`（只起 `postgres` + `redis`，两者都有 `image`，不需要 build）——**本地开发路径完好**。
- **闭合标准**：补 `apps/api/Dockerfile` 并实际 `docker compose --profile full build` 通过，或明确把 compose 的 api/web 服务标记为未实现并从文档移除。

### 附：CI 与部署相关的其他核实发现

| 发现 | 事实 | 性质 |
| --- | --- | --- |
| 覆盖率阈值 | `vitest.config.ts` 设 `lines/functions/statements: 60`、`branches: 55`，覆盖范围 `src/modules/**` 排除 module/dto/controller | 设计合理，但**当前只有 2 个 spec**，阈值必然不达标（C 级未验证） |
| e2e 范围 | `test/core-flow.e2e-spec.ts` 360 行，含健康检查、认证与 refresh 轮换重放、**权限红线（审计不可写/运营可生成不可审批/商务不可自审合同）**、达人状态机、数据范围与脱敏、**资金主链路幂等断言**、审计脱敏 | 覆盖面设计到位，但从未执行 |
| 测试运行器 | 单测/e2e 用 `vitest` + `unplugin-swc`（因 NestJS 依赖 `emitDecoratorMetadata`，esbuild 不支持） | 选型正确 |

---

## 5. 评审检查清单（按序勾选，每项标注需要什么证据）

### 5.1 资金正确性（必须 100% 通过）

- [ ] `calculateSettlement` 是否真的无 IO？（检查 import：只允许 `common/utils/money`）——**B 级**
- [ ] 守恒断言覆盖所有模式？（`REVENUE_SHARE` / `FIXED_FEE` / `HYBRID` / `CPA` 四条分支各走一遍）——**B 级**
- [ ] 一口价模式不扣平台费是否符合合同条款？（代码 `mode === 'FIXED_FEE' ? 0 : applyBp(...)`）——**需业务确认**
- [ ] 阶梯分成命中后与公司分成之和 > 10000 时的封顶告警是否足够？（当前：封顶并 `warnings.push`，不阻断）——**需财务确认容忍度**
- [ ] 负数流水为何拒绝而非支持退款？（当前抛错，要求走 `adjustmentAmount`）——**设计确认**
- [ ] `sumBreakdowns` 汇总是否与明细逐笔之和一致？（头部金额与明细完整性闸门 `assertItemIntegrity`）——**B 级**
- [ ] 金额只在 `DRAFT`/`DISPUTED` 可改？（`SETTLEMENT_TRANSITIONS` + 金额冻结规则）——**B 级**
- [ ] 双人复核是否强制？（创建人不能审批自己生成/提交的单据）——**B 级，需确认"系统内存在其他财务时"的降级逻辑**
- [ ] 逐人独立事务是否真的独立？（确认 `withTransaction` 未被外层事务包裹）——**B 级**
- [ ] 执行 `pnpm --filter @creatorops/api test`，300+ 组守恒穷举是否通过——**C 级，必须现场或会后执行**

### 5.2 安全边界

- [ ] 默认拒绝是否成立？（`JwtAuthGuard` 全局注册 + `@Public()` 白名单仅 4 个端点：login / refresh / health / health/ready + docs）——**B 级**
- [ ] 39 个权限点是否都有 `PERMISSION_META`？（spec 有此项断言，但未执行）——**C 级**
- [ ] AUDITOR 是否真的没有任何写权限？（spec 有扫描式断言）——**C 级，建议现场用 e2e 验一次**
- [ ] 详情接口是否都做了归属复核？（抽查 `settlement.service.ts#findOne`、`creator`、`contract`、`content` 的按 ID 入口）——**B 级，建议全量 grep 一遍 `findFirst({ where: { id` 的调用点**
- [ ] `ValidationPipe` 的 `forbidNonWhitelisted` 是否阻止前端注入 `ownerId`/`status`？——**B 级**
- [ ] 排序字段是否白名单？（`resolveOrderBy` 的第三参数）——**B 级**
- [ ] 证件号 AES-256-GCM 加密 + 权限脱敏 + 导出独立权限——**B 级**
- [ ] 生产启动是否拒绝弱密钥/相同密钥？（`config/env.ts` 的 zod 强校验）——**B 级**
- [ ] 审计入参脱敏键是否覆盖全？（当前 `SENSITIVE_BODY_KEYS`：password/newPassword/oldPassword/refreshToken/accessToken/idCard/idCardEncrypted）——**评审点：`bankAccount` 等未来字段是否遗漏**
- [ ] `trust proxy = 1` 与实际代理层数是否匹配？（多一层 CDN 会导致审计 IP 可伪造）——**需 SRE 确认部署拓扑**

### 5.3 可上线性

- [ ] **B-1 迁移不足**（见 §4）——**阻断**
- [ ] **B-2 eslint 缺失**（见 §4）——**阻断 CI**
- [ ] **B-3 Dockerfile 缺失**（见 §4）——**阻断容器化**
- [ ] `pnpm build` 前后端是否都能产出？（watch 模式会掩盖构建错误）——**C 级**
- [ ] `pnpm -r typecheck` 后端是否 0 错误？（api 的 `tsconfig.json` 开了 `strict` + `noUnusedLocals` + `noUnusedParameters`）——**C 级**
- [ ] 多实例定时任务：`docs/deployment.md` §4 给了三方案但**代码未内置开关**，是否本次就要落地？——**决策项 D-1**
- [ ] 限流基于内存 → 多实例实际阈值 = 配置值 × 实例数，是否本次切 Redis？——**决策项 D-2**
- [ ] 健康检查双探针（存活不查依赖 / 就绪查数据库）是否被 k8s 正确使用？——**B 级 + SRE 确认**

### 5.4 AI 治理

- [ ] 业务代码是否绕过 `AiTaskService` 直连 provider？（规范禁止；建议 grep `providers/` 的 import 方）——**B 级**
- [ ] `idempotencyKey` 是否由前端生成且一次点击只生成一次？——**B 级 + 前端确认**
- [ ] mock 模式下跳过预算校验（否则"预算已满"无法演示）是否会掩盖真实超支？——**设计确认**
- [ ] 降级是否可能"降级到同一个 Provider"？（代码已防：`fallback.name === primary.name` 直接失败）——**B 级**
- [ ] 超时是否用 `AbortController` 真正释放连接（而非 `Promise.race`）？——**B 级，建议看 `http.util.ts`**
- [ ] **AI 不得改写关键字段**这条红线是否有代码级保障，还是仅靠规范约定？——**评审重点，见 D-4**
- [ ] 传给模型的 `input` 是否做了最小化过滤？（是否存在把敏感字段整体透传的路径）——**评审重点**

### 5.5 可维护性

- [ ] 三个千行页面（`ContentDetailPage` 1014 / `CreatorDetailPage` 915 / `AiWorkbenchPage` 912）是否本次重构？——**决策项 D-5**
- [ ] `settlements` 是否真的不依赖 `contracts`/`contents` 的 Service？（架构文档的关键约束，值得 grep 验证）——**B 级**
- [ ] 定时任务与手动生成是否走同一段代码？（`scheduler` 依赖 `settlements` 而非自己实现）——**B 级**
- [ ] `dashboard` 是否真的只读、无被依赖？——**B 级**
- [ ] `zustand` 无效依赖是否移除？——**低风险顺手项**

---

## 6. 需要决策的 6 个开放问题

> 建议逐项给出「本次做 / 下次做 / 不做」+ 责任人 + 时限。

### D-1 多实例定时任务：本次落地选主，还是靠业务幂等兜底？

| 方案 | 成本 | 代价 |
| --- | --- | --- |
| 独立 worker 进程（文档推荐，`SCHEDULER_ENABLED=false`） | 中：需加环境开关 + 部署拓扑调整 | 需多一个进程 |
| Redis `SETNX` 选主锁 | 低：每个 `@Cron` 方法开头加锁判断 | 引入 Redis 依赖到调度路径 |
| 单实例部署 | 零 | 无法水平扩展，无高可用 |

**需要确认**：目标部署形态是单实例还是多实例？若近期单实例，可明确记为"已知限制"并写入文档，不必本次实现。

### D-2 限流存储：内存还是 Redis？

- 当前：`ThrottlerGuard` 全局注册，存储为内存 → 多实例下实际阈值放大 N 倍。
- **需要确认**：登录接口的"5 次失败锁定 15 分钟"用的是什么存储（若是内存，多实例下可被绕过限流尝试密码）。

### D-3 阶梯分成与公司分成之和超过 100% 时的处理策略

- 当前行为：**封顶到净额的 100% 并 `warnings.push`，不阻断出账**。
- 争议：这是"合同条款写错了"还是"可以接受的边界"？
- **建议**：改为在合同审批时就拒绝（`agencyShareBp + talentShareBp > 10000` 已有校验，但阶梯命中后可能超出），把问题挡在出账之前。

### D-4 「AI 不得改写关键字段」目前是规范约定还是代码保障？

- 现状：`docs/ai-guidelines.md` §2.2 列为硬性规则；`AI_TASK_PRESETS` 的 7 类任务输出都是建议性结构（脚本、匹配结果、合规 flags、异常解释），**没有一条直接写回结算金额或达人状态**。
- **但**：这是"当前没有这么做"，还是"系统不允许这么做"？
- **建议决策**：若要变成强制保障，可在 `AiTaskService` 增加"输出只允许写入白名单字段"的机制，或在 Service 层禁止 AI 输出直接进入 `Settlement`/`Contract`/`Creator.status` 的写入路径。**这是本次评审最值得投入的一项加固。**

### D-5 三个千行页面是否本次重构？

- 成本：中高（涉及路由、交互回归）；收益：可测性与可维护性。
- **建议**：本次只做"抽公共轮询 hook"（消除重复的 `refetchInterval` 逻辑 + 切页不停轮询的问题），页面拆分放到有前端测试之后再做——**没有测试的重构是危险的**。

### D-6 平台数据采集的投入节奏

- 现状：`HttpCollectorDriver` 具备鉴权/超时/重试/错误转换的完整骨架，但真实接入需要**企业资质 + 逐平台联调**，属外部依赖。
- **需要业务方回答**：优先接哪个平台？资质与接口权限是否已在申请？在没有真实数据源的期间，看板与结算的对外演示如何标注（当前靠 `DataSourceType.MOCK` 区分）？

---

## 7. 评审记录模板（会中直接填）

```markdown
## 评审记录 · CreatorOps · YYYY-MM-DD

参与人：
评审范围：资金链路 / 安全边界 / 可上线性 / AI 治理

### 阻断项
| ID | 问题 | 责任人 | 时限 | 状态 |
|----|------|--------|------|------|
| B-1 | 初始建表迁移缺失，migrate deploy 无法建库 | | | 待修 |
| B-2 | api 无 eslint 依赖与配置，CI 第一关失败 | | | 待修 |
| B-3 | apps/api/Dockerfile 缺失，容器化不可构建 | | | 待修 |

### 决策记录
| ID | 问题 | 结论 | 理由 | 责任人 |
|----|------|------|------|--------|
| D-1 | 多实例定时任务 | | | |
| D-2 | 限流存储 | | | |
| D-3 | 阶梯分成超 100% 处理 | | | |
| D-4 | AI 输出写入白名单加固 | | | |
| D-5 | 千行页面重构范围 | | | |
| D-6 | 平台采集投入节奏 | | | |

### 待执行验证（C 级证据转 A 级）
- [ ] pnpm install && prisma generate
- [ ] pnpm -r typecheck
- [ ] pnpm --filter @creatorops/api test（含 300+ 组守恒穷举）
- [ ] pnpm test:e2e（core-flow，含权限红线与幂等断言）
- [ ] migrate deploy 到空库 + db:seed 连跑两次
- [ ] pnpm build

### 结论
[ ] 通过  [ ] 有条件通过（闭合阻断项后）  [ ] 需重新评审
```

---

## 8. 可复现命令清单（评审现场可直接跑）

```bash
# --- 不需要安装依赖即可运行（A 级证据）---
node apps/api/scripts/check-prisma-usage.mjs      # 88 源文件模型/枚举一致性
node apps/web/scripts/static-check.mjs            # 64 文件 import/CSS Module/默认导出

# --- 规模基线核对 ---
find apps/api/src -name '*.ts' | wc -l            # 88
find apps/web/src -name '*.ts*' | wc -l           # 64
grep -c '^model ' apps/api/prisma/schema.prisma   # 18
grep -c '^enum '  apps/api/prisma/schema.prisma   # 15
# 权限点数量（期望 39）。
# 注意：正则必须锚定"行首两空格 + 大写键名 + 冒号 + 引号值 + 逗号"，并允许行尾注释。
# 更宽松的写法（如 ^\s+[A-Z_]+: '[a-z:]+',）会因 \s 可跨行而把 3 行注释也算进去，得到 42 —— 这是错的。
rg -c "^  [A-Z_0-9]+: '[a-z:]+'," apps/api/src/modules/auth/permissions.ts          # 期望 39
rg -c "^\s+\[PERMISSIONS\.[A-Z_0-9]+\]" apps/api/src/modules/auth/permissions.ts      # PERMISSION_META 条目，期望同为 39
ls apps/api/prisma/migrations/                    # 只有 2 个文件夹 ← B-1 证据

# --- 需要正常环境（把 C 级证据转成 A 级）---
pnpm install
pnpm --filter @creatorops/api prisma:generate
pnpm -r typecheck
pnpm --filter @creatorops/api check:prisma-usage
pnpm -r lint                                       # ← 预计在 api 步骤失败（B-2）
pnpm --filter @creatorops/api test:cov             # 300+ 组守恒穷举 + 覆盖率阈值
pnpm db:migrate && pnpm db:seed && pnpm db:seed    # 第二次验证种子幂等
pnpm test:e2e                                      # core-flow 权限红线与幂等断言
pnpm build
docker compose --profile full build                # ← 预计失败（B-3）
```

---

> 关联文档：完整复盘 [`project-review.md`](./project-review.md) · 设计理由 [`architecture.md`](./architecture.md) / [`data-model.md`](./data-model.md) · 权限矩阵 [`permissions.md`](./permissions.md) · AI 规范 [`ai-guidelines.md`](./ai-guidelines.md) · 部署运维 [`deployment.md`](./deployment.md) · 代码审查清单 [`code-review-checklist.md`](./code-review-checklist.md)
