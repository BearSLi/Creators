# CreatorOps Web —— 页面编写规范（子代理必读）

工作目录：`D:\DSH\Creator\creatorops\apps\web`。**只允许新建/修改 `src/pages/` 下分配给你的文件**，
不要改 `src/api`、`src/components`、`src/hooks`、`src/utils`、`src/auth` 下的任何文件（那些已完成且被其他代理依赖）。

## 0. 硬性约束

- React 18 + TypeScript **strict**，`tsconfig.app.json` 开了 `noUnusedLocals` / `noUnusedParameters`
  → **不要留未使用的 import、变量、参数**（否则 `tsc` 直接失败）。
- `verbatimModuleSyntax: true` → 只作类型使用的导入必须写 `import type { ... } from '...'`。
- 页面必须 **default export**（`export default function XxxPage() {...}`），因为路由用 `lazy()` 加载。
- 路径别名 `@/` → `src/`。
- **禁止 TODO / 占位实现**，每个页面都要有真实可用的交互。
- 注释用中文，且解释**为什么**这么做（业务约束、踩过的坑、取舍），不要写"这里设置了 state"这种废话。
- 不要引入新依赖，不要写测试文件，不要用 Tailwind/AntD。
- 样式：优先用 `src/styles/global.css` 里的全局类，需要局部样式时新建同目录 `Xxx.module.css`
  并 `import styles from './Xxx.module.css'`，样式里只能用 `var(--token)` 令牌（见 `src/styles/tokens.css`）。

## 1. 可直接使用的全局 CSS 类（global.css）

布局/容器：`page`（页面外壳，必加）、`pageHeader`、`pageTitle`、`pageSubtitle`、`pageActions`、
`card`、`cardHeader`、`cardTitle`、`cardBody`、`grid gridCols2|gridCols3|gridCols4`、
`stack`、`row`、`rowBetween`、`wrap`、`grow`、`divider`、`sectionTitle`

文本：`muted`、`subtle`、`mono`、`textRight`、`textCenter`、`nowrap`、`ellipsis`、`clamp2`

按钮：`btn`（默认）、`btnPrimary`、`btnDanger`、`btnGhost`、`btnSm`、`btnLg`、`btnBlock`、
`btnLink`、`btnLinkDanger`、`spinner`（按钮内加载菊花）

表单：`formGrid`、`field`、`fieldFull`、`label`、`labelRequired`、`hint`、`errorText`、
`input`、`select`、`textarea`、`inputError`、`checkboxRow`、`chipGroup`、`chip`、`chipActive`

表格：`tableWrap`、`table`、`tableActions`

其他：`tabs`、`tab`、`tabActive`、`descriptions`、`descriptionsItem`（dt/dd 结构）、
`codeBlock`、`emptyInline`、`skeleton`

内联样式里写 CSS 变量要写成字符串：`style={{ marginTop: 'var(--space-4)' }}`。

## 2. 通用组件（已实现，直接 import）

```ts
import { PageHeader } from '@/components/PageHeader';               // { title, subtitle?, actions? }
import { DataTable, type Column } from '@/components/DataTable';
import { FilterBar, type FilterField } from '@/components/FilterBar';
import { StatCard } from '@/components/StatCard';
import { StatusTag, TierTag } from '@/components/StatusTag';
import { MoneyText, BpText } from '@/components/MoneyText';
import { Modal } from '@/components/Modal';
import { Drawer } from '@/components/Drawer';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState, ErrorState } from '@/components/EmptyState';
import { LoadingSkeleton, DetailSkeleton } from '@/components/LoadingSkeleton';
import { PermissionGate } from '@/components/PermissionGate';
import { useToast, AUDIT_WRITTEN_HINT } from '@/components/Toast';
import { useAuth } from '@/auth/AuthContext';
import { usePermission } from '@/hooks/usePermission';   // { has, hasAny, hasAll, permissions, role }
import { useTableQuery } from '@/hooks/useTableQuery';
import { useDebounce, useDebouncedCallback } from '@/hooks/useDebounce';
```

补充两条容易踩的坑：

- `useParams()` 取到的 `id` 是 `string | undefined`。查询时要写 `enabled: Boolean(id)` 并用
  `getCreator(id!)`（或先 `if (!id) return null`），不要直接传 `string | undefined`。
- 写操作成功后统一 `queryClient.invalidateQueries({ queryKey: ['<模块名>'] })`，
  queryKey 第一段固定用模块名（`creators` / `contracts` / `projects` / `contents` / `settlements` /
  `ai-tasks` / `users` / `audit-logs` / `tags` / `brands` / `dashboard`），便于跨页面失效。

关键 props（照抄，别猜）：

```ts
// DataTable<T>
<DataTable
  columns={columns} rows={items} rowKey={(row) => row.id}
  loading={isLoading} error={errorMessage} onRetry={() => refetch()} errorRequestId={requestId}
  emptyTitle="暂无达人" emptyDescription="试试调整筛选条件" emptyAction={<button className="btn btnPrimary">新建达人</button>}
  onSortChange={(p) => setSort(p)} sortBy={sortBy} sortOrder={sortOrder}
  onRowClick={(row) => navigate(`/creators/${row.id}`)}
  rowClassName={(row) => (isOverdue(row) ? 'rowDanger' : '')}
  selectable selectedKeys={selected} onSelectionChange={setSelected}
  page={page} pageSize={pageSize} total={data?.total} totalPages={data?.totalPages}
  onPageChange={setPage} onPageSizeChange={setPageSize} pageSizeOptions={pageSizeOptions}
  footer={<>已选 {selected.length} 条</>} stickyHeader
/>
// Column<T>：{ key, title, render?(row, index), dataIndex?, width?, align?, sortable?, sortKey?, ellipsis?, tooltip? }

// FilterBar：fields 是联合类型数组
<FilterBar
  fields={[
    { type: 'keyword', key: 'keyword', value: filters.keyword, onChange: (v) => setFilters({ keyword: v }), placeholder: '昵称 / 编号 / 手机号' },
    { type: 'select', key: 'platform', label: '平台', value: filters.platform, options: PLATFORM_OPTIONS, onChange: (v) => setFilters({ platform: v }) },
    { type: 'multi', key: 'status', label: '状态', value: filters.status, options: CREATOR_STATUS_OPTIONS, onChange: (v) => setFilters({ status: v }) },
    { type: 'date', key: 'from', label: '开始', value: filters.from, onChange: (v) => setFilters({ from: v }) },
    { type: 'number', key: 'minFollowers', label: '粉丝下限', value: filters.minFollowers, onChange: (v) => setFilters({ minFollowers: v }) },
    { type: 'custom', key: 'x', label: '自定义', render: () => <div /> },
  ]}
  actions={<button className="btn">导出</button>}
  onReset={reset} resultCount={data?.total}
/>

// Modal：{ open, title, description?, children, footer?, onClose, size?: 'sm'|'md'|'lg'|'xl', closeOnMaskClick? }
// Drawer：{ open, title, description?, children, footer?, onClose, size?: 'md'|'wide' }
// ConfirmDialog：{ open, title, message, confirmText?, danger?, loading?, requireReason?, reasonLabel?, onCancel, onConfirm(reason?) }
//   —— requireReason 为 true 时未填够 5 个字不能提交，提交时把原因回传给 onConfirm
// StatusTag：{ children, tone?, dot?, color?, size?: 'sm'|'md' }  tone: neutral|info|warning|success|danger|primary
// MoneyText：{ value, variant?: 'yuan'|'plain'|'compact', signed?, muted?, highlightThreshold?, placeholder? }
// BpText：{ bp }  // 基点整数 → 10.00%
// PermissionGate：{ permission?|anyPermission?|allPermissions?, children, fallback?: ReactNode|'lock', lockText? }
```

## 3. react-query 用法（v5）

```ts
const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
  queryKey: ['creators', 'list', query],            // 把整个查询条件放进 key，条件变化自动重取
  queryFn: () => listCreators(query),
  placeholderData: keepPreviousData,                // 翻页时不闪骨架（from '@tanstack/react-query'）
});
```

> **重要**：`useTableQuery` 返回的 `query` 已经**把筛选条件拍平到顶层**，结构是
> `{ ...filters, page, pageSize, sortBy, sortOrder }`，因此可以直接当请求参数用：
> `listCreators(query)`。**不要**写 `query.filters`（另有一个 `filters` 字段供回填表单控件用）。
> 如果某个列表不是用 `useTableQuery` 管理（例如自己 setState），参数对象也要保持这种"扁平"结构。

```ts
const mutation = useMutation({
  mutationFn: (body: X) => updateXxx(id, body),
  onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['creators'] }); toast.success('...'); },
});  // 失败提示由全局 mutationCache 统一 toast（resolveErrorMessage），页面不用重复 onError
const queryClient = useQueryClient();
new Set([...queryClient.getQueryData<string[]>(['xxx']) ?? []])   // 类型写清楚，避免 never
```

错误态渲染：`import { resolveErrorMessage } from '@/api/client';` → `error ? resolveErrorMessage(error) : null`。

## 4. 业务铁律（面试评审重点，必须体现）

1. **权限驱动 UI**：按钮用 `<PermissionGate permission={P.CONTRACT_APPROVE}>`，敏感列（手机号/证件号）
   无 `creator:sensitive:read` 时用 `<PermissionGate permission={P.CREATOR_SENSITIVE_READ} fallback="lock" lockText="已脱敏">`。
2. **金额**：一律字符串元，用 `<MoneyText value={x.netPayable} />` 展示，`align: 'right'`；**绝不前端做资金加减回写**。
   比率是基点整数（1000=10%），用 `formatBp` 或 `<BpText bp={x.talentShareBp} />`。
3. **状态机**：达人状态流转按钮**只能**来自后端 `statusMachine.allowedNext`，禁止硬编码状态选项；
   `requiresReason: true` 时用 `ConfirmDialog requireReason` 弹窗收原因。
4. **防重复提交**：写操作按钮 `disabled={mutation.isPending}` 且 `{mutation.isPending && <span className="spinner" />}`；
   AI 调用与结算生成带 `idempotencyKey: createIdempotencyKey('script')`（`createIdempotencyKey` 来自 `@/utils/format`）。
5. **审计提示**：编辑/审批/打款/状态流转成功后 toast 里要出现 `AUDIT_WRITTEN_HINT`（即"已写入审计日志"）。
6. **三态**：列表/图表都要 loading 骨架 / 空状态 / 错误重试。
7. **表单校验**：手机号 `/^1[3-9]\d{9}$/`（`PHONE_PATTERN`），分润需校验
   `platformFeeBp + agencyShareBp <= 10000`、`talentShareBp + taxWithholdBp <= 10000`，
   并实时预览「平台费 10% / 公司 30% / 达人 70% / 代扣 6%」。

## 5. 枚举与格式化工具（`@/utils/constants` 与 `@/utils/format`）

constants 导出（全部是 `{value,label}` 数组或 `Record<枚举, string>`）：

- `CREATOR_STATUS_LABELS / CREATOR_STATUS_OPTIONS / CREATOR_STATUS_TONES`
- `TIER_LABELS / TIER_OPTIONS`、`VERTICAL_LABELS / VERTICAL_OPTIONS / verticalLabel(v)`、`PLATFORM_LABELS / PLATFORM_OPTIONS / platformLabel(v)`
- `DATA_SOURCE_LABELS / DATA_SOURCE_OPTIONS / DATA_SOURCE_TRUST`、`RISK_LEVEL_LABELS / RISK_LEVEL_TONES`
- `AGENCY_TYPE_OPTIONS / AGENCY_TYPE_LABELS`、`SOURCE_CHANNEL_OPTIONS / SOURCE_CHANNEL_LABELS`、`AVAILABILITY_OPTIONS`
- `EVALUATION_DIMENSIONS`（合作评价四维，`[{key,label,hint}]`）
- `CONTRACT_STATUS_LABELS / _OPTIONS / _TONES`、`SETTLEMENT_MODE_LABELS / _OPTIONS`
- `PROJECT_STATUS_LABELS / _OPTIONS / _TONES`、`CONTENT_STATUS_LABELS / _OPTIONS / _TONES`、`CONTENT_BOARD_COLUMNS`
- `COMPLIANCE_LEVEL_LABELS / _TONES`
- `SETTLEMENT_STATUS_LABELS / _OPTIONS / _TONES`、`SETTLEMENT_ITEM_TYPE_LABELS`、`LARGE_AMOUNT_THRESHOLD_YUAN`
- `AI_TASK_TYPE_LABELS / _OPTIONS`、`AI_TASK_STATUS_LABELS / _TONES`、`HUMAN_FEEDBACK_LABELS`、`AI_TASK_INPUT_FIELDS`
- `ROLE_LABELS / ROLE_OPTIONS`、`USER_STATUS_LABELS / _OPTIONS / _TONES`
- `BRAND_LEVEL_LABELS / _OPTIONS`、`AUDIT_ACTION_LABELS / _OPTIONS`、`AUDIT_RESOURCE_LABELS`
- `TAG_CATEGORY_LABELS / TAG_CATEGORY_OPTIONS`、`PAGE_SIZE_OPTIONS`、`SHARE_BP_FIELDS`
- `PHONE_PATTERN`、`EMAIL_PATTERN`
- `type Option<T> = { value: T; label: string }`

format 导出：`formatMoney`、`formatYuan`、`formatMoneyCompact`、`isNegativeMoney`、`formatBp`、
`formatPercentValue`、`formatPercent`、`formatDelta`、`formatCount`、`formatInteger`、`formatFollowers`、
`formatMs`、`formatCents`、`formatDate`、`formatDateTime`、`formatRelative`、`shiftDays`、
`currentMonthRange()`（返回 `{start,end}`）、`previousMonthRange()`、`overdueDays`、`maskPhone`、`maskName`、
`formatScore`、`formatBytes`、`downloadBlob(blob, filename)`、`parseFilename(contentDisposition, fallback)`、
`createIdempotencyKey(prefix?)`。

权限码常量：`import { P } from '@/utils/permissions'`，如 `P.CREATOR_EXPORT`、`P.SETTLEMENT_PAY`。
另有 `permissionLabel(code)`、`splitPermissionOverrides(list)`、`joinPermissionOverrides({grant,revoke})`。

## 6. API 函数签名（`@/api/xxx`，返回值即业务数据，信封已在 client 解包）

```ts
// @/api/creators
listCreators(query: CreatorListQuery): Promise<Paginated<CreatorListItem>>
getCreator(id): Promise<CreatorDetail>
createCreator(body: CreateCreatorRequest): Promise<CreatorDetail>
updateCreator(id, body: UpdateCreatorRequest): Promise<CreatorDetail>
updateCreatorStatus(id, { status, reason? }): Promise<CreatorDetail>
evaluateCreator(id, { contentScore, commercialScore, cooperationScore, dataScore, remark? }): Promise<CreatorDetail>
assignCreator(id, { ownerId, note? }): Promise<CreatorDetail>
deleteCreator(id): Promise<{ id: string; deleted: true }>
batchImportCreators({ items, ownerId? }): Promise<{ created: number; failed: { index, name, reason }[] }>

// @/api/tags  listTags(category?) / createTag({name,category,color?}) / updateTag(id, body) / deleteTag(id)
// @/api/brands  listBrands(query) / createBrand(body) / updateBrand(id, body) / deleteBrand(id)
// @/api/contracts
listContracts(query) / getContract(id) / createContract(body) / updateContract(id, body)
submitContract(id) / approveContract(id, { approved, note? }) / terminateContract(id, { reason })
previewContractSettlement(id, { periodStart, periodEnd }): Promise<SettlementPreview>
// @/api/projects  listProjects(query) / getProject(id) / createProject(body) / updateProject(id, body) / deleteProject(id)
// @/api/contents
listContents(query) / getContent(id) / createContent(body) / updateContent(id, body)
submitContentReview(id) / reviewContent(id, { approved, note?, rejectReason? }) / publishContent(id, { platformContentId?, publishedUrl?, publishedAt? }) / syncContentMetrics(id)
// @/api/settlements
listSettlements(query) / getSettlement(id)
generateSettlements({ periodStart, periodEnd, creatorIds? }) / adjustSettlement(id, { amount, reason })
approveSettlement(id) / paySettlement(id, { paymentVoucherUrl? }) / disputeSettlement(id, { reason })
exportSettlements({ periodStart?, periodEnd?, creatorId? })   // 返回 AxiosResponse<Blob>，要绕过解包
// @/api/ai
listAiTasks(query) / getAiTask(id) / createAiTask({ taskType, input, creatorId?, idempotencyKey? })
submitAiFeedback(id, { feedback: 1 | -1, note? }) / listAiPrompts() / createAiPrompt(body) / updateAiPrompt(id, body) / getAiUsage({ year?, month? })
// @/api/dashboard  getDashboardOverview({ from?, to? }): Promise<DashboardOverview>
// @/api/users
listUsers(query) / createUser(body) / updateUser(id, body) / resetUserPassword(id) / updateUserStatus(id, status)
updateUserPermissions(id, permissionOverrides: string[]) / getPermissionCatalog() / getRoles()
// @/api/audit  listAuditLogs(query) / getAuditTimeline(resource, id, limit?)
```

`exportSettlements` 用法（必须这样写才算"绕过信封"）：

```ts
const response = await exportSettlements({ periodStart, periodEnd });
const filename = parseFilename(response.headers['content-disposition'] as string | undefined, `结算单_${periodStart}_${periodEnd}.csv`);
downloadBlob(response.data, filename);
```

## 7. 数据模型提醒

- `CreatorDetail.statusMachine = { current: {value,label}, allowedNext: [{value,label,requiresReason?}] }`
  → 状态流转按钮渲染 `allowedNext`，`requiresReason` 为真时弹 `ConfirmDialog requireReason`。
- `CreatorDetail.accounts[]`：`{ platform, nickname, platformUid, followerCount, totalLikes(字符串), totalWorks, avgPlayCount, engagementRate(百分数), dataSource, lastSyncedAt, isPrimary, syncError }`。
- `CreatorListItem.masked` 为 true 表示后端已脱敏。
- 合同金额 `fixedFee` 是字符串元；四个比率 `platformFeeBp/agencyShareBp/talentShareBp/taxWithholdBp` 是基点；
  `tieredShares` 是 `{fromYuan,toYuan,talentShareBp}[]`。
- 内容互动字段全是字符串（`viewCount/likeCount/commentCount/shareCount`），`revenueYuan` 字符串，`completionRate` 百分数 number。
- 结算 `items[]` 每条含四档比率与 `calculatedAt`；`calculationTrace` 是 `Record<string, unknown> | null`（用 `JSON.stringify(trace, null, 2)` 渲染）。
- AI `SCRIPT_GENERATE` 输出：`{ title, hook, scenes: [{ index, timeRange, shot, voiceover, note? }], hashtags: string[], risks: string[] }`（时间轴卡片渲染）。
- AI `COMPLIANCE_CHECK` 输出：`{ score, level: 'PASS'|'WARN'|'REJECT', flags: [{ level, category, snippet, reason, suggestion }] }`。
- AI `CREATOR_MATCH` 输出：`{ matches: [{ creatorId, creatorName, score, reasons: string[], risks: string[] }] }`。
- `AiTaskOutput` 是联合类型，渲染前用类型断言收窄，例如：
  `const script = task.output as ScriptOutput | null;` 再判断 `script?.scenes`。
- 审计 `before/after` 是 `Record<string, unknown> | null`，做字段级 diff（相同字段不展示，值用 `JSON.stringify` 包一层兜底）。
