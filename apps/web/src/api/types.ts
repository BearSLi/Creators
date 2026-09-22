/**
 * 接口契约类型：与后端 DTO / 响应结构一一对应。
 *
 * 三条贯穿全项目的约定，读代码时务必注意：
 *   1) 金额字段一律是「字符串元」（如 '12800.00'）——后端用 decimal 防止浮点误差，
 *      前端只做展示，**不做加减后回写**；
 *   2) 比率字段一律是「基点整数」（1000 = 10%）——比小数更不容易出现 0.09999999；
 *   3) 所有 id 都是 UUID 字符串，前端不解析其内容。
 */

/* ============================================================
   通用信封与分页
   ============================================================ */

/** 成功响应的信封；client.ts 会自动解包出 data，业务层见不到这一层 */
export interface ApiEnvelope<T> {
  success: true;
  data: T;
  requestId: string;
  timestamp: string;
}

/** 失败响应的信封（HTTP 非 2xx） */
export interface ApiErrorBody {
  success: false;
  code: string;
  message: string;
  details?: unknown;
  /**
   * 字段级校验错误（仅 `VALIDATION_FAILED` 会带）：`{ DTO 字段名: [消息] }`。
   *
   * 键名就是后端 DTO 的属性名，因此可以直接当作表单字段名用于标红
   * （本项目各表单 `errors` 状态的键名与 DTO 一致）。
   *
   * 为什么不能靠解析 `details` 里的英文句子：自定义 message 里根本没有字段名
   * （例如「结算模式非法」），解析必然漏掉这类错误。
   */
  fieldErrors?: Record<string, string[]>;
  path?: string;
  requestId?: string;
  timestamp?: string;
}

/** 列表响应的统一形状 */
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasNext: boolean;
}

/** 所有列表查询的公共参数 */
export interface BaseListQuery {
  page?: number;
  pageSize?: number;
  keyword?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

/** DataTable 的排序事件载荷 */
export interface SortPayload {
  sortBy: string;
  sortOrder: 'asc' | 'desc';
}

/* ============================================================
   认证与员工
   ============================================================ */

export type UserRole = 'SUPER_ADMIN' | 'OPERATIONS' | 'BD' | 'CONTENT' | 'FINANCE' | 'AUDITOR';
/**
 * 员工账号状态。
 *
 * 后端 `enum UserStatus` 只有 ACTIVE / DISABLED 两个值。
 * 早期这里多写了一个 `LOCKED` —— 那是我把「登录失败锁定」当成了账号状态：
 * 连续登录失败锁的是**会话/尝试次数**（auth 模块里的登录节流），不是 User.status，
 * 所以后端永远不会下发 LOCKED，而前端 `USER_STATUS_LABELS[status]` 会因为没有
 * 对应 key 而渲染出 `undefined`。类型里删掉它是为了让它不可能再被写出来。
 */
export type UserStatus = 'ACTIVE' | 'DISABLED';

export interface LoginRequest {
  email: string;
  password: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  status: UserStatus;
  teamId: string | null;
  permissions: string[];
  avatarUrl: string | null;
}

export interface LoginResponse extends AuthTokens {
  user: AuthUser;
}

export interface RefreshRequest {
  refreshToken: string;
}

export interface TeamBrief {
  id: string;
  name: string;
  code?: string;
}

export interface ProfileResponse {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  status: UserStatus;
  avatarUrl: string | null;
  team: TeamBrief | null;
  permissions: string[];
  lastLoginAt: string | null;
}

export interface ChangePasswordRequest {
  oldPassword: string;
  newPassword: string;
}

export interface ChangePasswordResponse {
  revokedSessions: number;
}

export interface LogoutResponse {
  revoked: number;
}

export interface UserListItem {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  role: UserRole;
  roleLabel: string;
  status: UserStatus;
  avatarUrl: string | null;
  team: TeamBrief | null;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface UserListQuery extends BaseListQuery {
  role?: UserRole;
  status?: UserStatus;
}

export interface CreateUserRequest {
  email: string;
  name: string;
  password?: string;
  role: UserRole;
  teamId?: string;
  phone?: string;
}

/** 新建员工时后端只返回一次初始密码，前端必须让用户当场记录 */
export interface CreateUserResponse extends UserListItem {
  initialPassword: string;
}

export interface ResetPasswordResponse {
  initialPassword: string;
}

export interface UpdateUserRequest {
  name?: string;
  phone?: string;
  role?: UserRole;
  teamId?: string;
  avatarUrl?: string;
  /**
   * 账号启停用。
   * 禁用时后端会同时撤销该用户的全部会话 —— 否则被禁用的人拿旧 refresh token
   * 还能换到新的 access token，禁用最长 2 小时不生效。
   */
  status?: UserStatus;
}

export interface UserPermissionCatalogItem {
  code: string;
  label: string;
  group: string;
  risk: 'low' | 'medium' | 'high';
}

/**
 * 数据范围（RBAC 的第二层：权限点决定"能不能做"，数据范围决定"能对谁做"）。
 *
 * 与后端 `modules/auth/permissions.ts` 的 `DataScope` 一致：
 * ALL=全部数据 / TEAM=本团队及下级 / OWN=仅自己负责的。
 *
 * 提取成具名类型而不是内联在接口里（原先是 `dataScope: 'ALL' | 'TEAM' | 'OWN'`）：
 * 具名后它才能被 scripts/check-enum-drift.mjs 扫到并参与字面量校验，
 * 也才能被多个接口复用而不必各写一遍。
 */
export type DataScope = 'ALL' | 'TEAM' | 'OWN';

export interface UserRoleDefinition {
  role: UserRole;
  label: string;
  permissions: string[];
  dataScope: DataScope;
}

/* ============================================================
   达人主数据
   ============================================================ */

export type CreatorStatus =
  | 'LEAD'
  | 'CONTACTING'
  | 'EVALUATING'
  | 'SIGNED'
  | 'ACTIVE'
  | 'PAUSED'
  | 'TERMINATED'
  | 'BLACKLIST';

export type CreatorTier = 'S' | 'A' | 'B' | 'C' | 'D';

export type Vertical =
  | 'SHORT_DRAMA'
  | 'LIFESTYLE'
  | 'BEAUTY'
  | 'GAMING'
  | 'FOOD'
  | 'TECH'
  | 'KNOWLEDGE'
  | 'FASHION'
  | 'FITNESS'
  | 'OTHER';

export type Platform =
  | 'DOUYIN'
  | 'XIAOHONGSHU'
  | 'BILIBILI'
  | 'WECHAT_CHANNEL'
  | 'KUAISHOU'
  | 'WEIBO'
  | 'TIKTOK'
  | 'YOUTUBE'
  | 'INSTAGRAM';

/**
 * 账号数据采集方式，与后端 `enum DataSourceType` 一致。
 *
 * `MOCK` 是后端专门为「未接入真实平台时的仿真数据」单独加的值 ——
 * 它和 MANUAL（人工填写）在结算争议里的证据效力完全不同，所以不能合并。
 * 前端早期漏了 MOCK，导致仿真账号在列表里 `DATA_SOURCE_LABELS[dataSource]` 渲染成 undefined。
 */
export type DataSource = 'API_OFFICIAL' | 'THIRD_PARTY' | 'SCREENSHOT' | 'MANUAL' | 'MOCK';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

/**
 * 机构合作类型。后端 DTO 用 `@IsIn(['FULL_MCN', 'COMMERCIAL', 'INDEPENDENT'])` 校验，
 * 注意是「与机构的合约形态」而不是「机构本身的类型」：
 * 早期前端写的 NONE / MCN / AGENCY / STUDIO 描述的是机构主体，
 * 四个值全部对不上，提交必然 400。
 */
export type AgencyType = 'FULL_MCN' | 'COMMERCIAL' | 'INDEPENDENT';

/**
 * 招募来源渠道。后端是 `@IsString() @MaxLength(64)` 的自由文本，
 * 没有 `@IsIn` 白名单 —— 渠道会随投放策略变，写死枚举反而要改代码才能加新渠道。
 * 所以这里保持 string，`SOURCE_CHANNEL_OPTIONS` 只作为下拉建议值，允许录入其它渠道。
 */
export type SourceChannel = string;

/**
 * 档期与合作偏好：后端列是 `availability Json?`，存的是**结构化对象**而不是字符串。
 * 早期前端把它当成 `'FULL_TIME' | 'PART_TIME' | 'ON_BREAK'` 字符串提交，
 * 结果写进 JSON 列的是 `"FULL_TIME"` 这样一个裸字符串，读回来再按对象用就会错。
 * 现在只固定 `commitment` 这一个必要字段，其余键允许扩展。
 */
export type AvailabilityCommitment = 'FULL_TIME' | 'PART_TIME' | 'ON_BREAK';

export interface Availability {
  commitment?: AvailabilityCommitment;
  /** 每周可接内容条数 */
  videosPerWeek?: number;
  /** 自由备注，如「寒暑假档期紧张」 */
  note?: string;
  /** 允许后续加字段而不必改类型 */
  [key: string]: unknown;
}

export interface TagItem {
  id: string;
  name: string;
  category: string;
  color: string;
  creatorCount: number;
  createdAt: string;
}

export interface TagBrief {
  id: string;
  name: string;
  color: string;
}

export interface UserBrief {
  id: string;
  name: string;
}

export interface CreatorAccount {
  id: string;
  platform: Platform;
  nickname: string;
  platformUid: string;
  profileUrl: string | null;
  followerCount: number;
  /** string：大 V 粉丝点赞数会超过 Number.MAX_SAFE_INTEGER 的展示习惯，后端统一给字符串 */
  totalLikes: string;
  totalWorks: number;
  avgPlayCount: number;
  /** number，直接是百分数，如 12.5 表示 12.5% */
  engagementRate: number;
  dataSource: DataSource;
  lastSyncedAt: string | null;
  isPrimary: boolean;
  syncError: string | null;
}

export interface CreatorListItem {
  id: string;
  code: string;
  name: string;
  realName: string | null;
  /** 无 creator:sensitive:read 权限时后端已脱敏，前端只负责展示 */
  phone: string | null;
  wechat: string | null;
  city: string | null;
  status: CreatorStatus;
  statusLabel: string;
  tier: CreatorTier;
  verticals: string[];
  styleTags: string[];
  score: number;
  riskLevel: RiskLevel;
  sourceChannel: SourceChannel | null;
  agencyName: string | null;
  owner: UserBrief | null;
  team: TeamBrief | null;
  tags: TagBrief[];
  accountCount: number;
  maxFollowers: number;
  platforms: string[];
  signedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** 后端标记当前用户是否看到的是脱敏数据，用于表格加锁图标 */
  masked: boolean;
}

export interface CreatorStats {
  activeContracts: number;
  totalContents: number;
  publishedContents: number;
  /** string 元 */
  totalRevenueYuan: string;
  /** string 元 */
  pendingSettlementYuan: string;
}

export interface StatusOption {
  value: CreatorStatus;
  label: string;
  requiresReason: boolean;
}

/** 状态机完全由后端下发，前端不允许硬编码流转选项 */
export interface StatusMachine {
  current: { value: CreatorStatus; label: string };
  /** 后端返回的 requiresReason 可能为 false，做兜底联合更贴近真实返回 */
  allowedNext: Array<{ value: CreatorStatus; label: string; requiresReason?: boolean }>;
}

export interface CreatorDetail extends CreatorListItem {
  email: string | null;
  agencyType: AgencyType | null;
  idCardMasked: string | null;
  remark: string | null;
  availability: Availability | null;
  accounts: CreatorAccount[];
  stats: CreatorStats;
  statusMachine: StatusMachine;
}

export interface CreatorListQuery extends BaseListQuery {
  status?: CreatorStatus[];
  tier?: CreatorTier[];
  vertical?: Vertical[];
  platform?: Platform;
  ownerId?: string;
  tagId?: string;
  minFollowers?: number;
  maxFollowers?: number;
  minScore?: number;
  sourceChannel?: SourceChannel;
}

export interface CreatorAccountInput {
  platform: Platform;
  nickname: string;
  platformUid: string;
  profileUrl?: string;
  homeUrl?: string;
  followerCount?: number;
  isPrimary?: boolean;
  dataSource?: DataSource;
}

export interface CreateCreatorRequest {
  name: string;
  realName?: string;
  idCard?: string;
  phone?: string;
  wechat?: string;
  email?: string;
  city?: string;
  status?: CreatorStatus;
  tier?: CreatorTier;
  verticals?: string[];
  styleTags?: string[];
  agencyType?: AgencyType;
  agencyName?: string;
  sourceChannel?: SourceChannel;
  score?: number;
  ownerId?: string;
  teamId?: string;
  tagIds?: string[];
  remark?: string;
  availability?: Availability;
  accounts?: CreatorAccountInput[];
}

/** PATCH 与 POST 同构但全部可选，且不含 status（状态只能走状态机接口） */
export type UpdateCreatorRequest = Partial<CreateCreatorRequest> & { status?: never };

export interface UpdateCreatorStatusRequest {
  status: CreatorStatus;
  /** allowedNext 中 requiresReason=true 时必填 */
  reason?: string;
}

export interface EvaluateCreatorRequest {
  contentScore: number;
  commercialScore: number;
  cooperationScore: number;
  dataScore: number;
  remark?: string;
}

export interface AssignCreatorRequest {
  ownerId: string;
  note?: string;
}

export interface DeleteResponse {
  id: string;
  deleted: true;
}

export interface BatchImportRequest {
  items: CreateCreatorRequest[];
  ownerId?: string;
}

export interface BatchImportFailure {
  index: number;
  name: string;
  reason: string;
}

export interface BatchImportResult {
  created: number;
  failed: BatchImportFailure[];
}

/* ============================================================
   品牌
   ============================================================ */

export type BrandLevel = 'S' | 'A' | 'B' | 'C';

export interface BrandListItem {
  id: string;
  name: string;
  industry: string | null;
  contactName: string | null;
  contactPhone: string | null;
  level: BrandLevel;
  paymentTermDays: number;
  invoiceTitle: string | null;
  taxNo: string | null;
  remark: string | null;
  contractCount: number;
  createdAt: string;
}

export interface BrandListQuery extends BaseListQuery {
  level?: BrandLevel;
}

export interface UpsertBrandRequest {
  name: string;
  industry?: string;
  contactName?: string;
  contactPhone?: string;
  level?: BrandLevel;
  paymentTermDays?: number;
  invoiceTitle?: string;
  taxNo?: string;
  remark?: string;
}

/* ============================================================
   合同
   ============================================================ */

/**
 * 合同状态。
 *
 * 与后端 Prisma `enum ContractStatus` 严格一致：DRAFT / PENDING_REVIEW / ACTIVE / EXPIRED / TERMINATED。
 * 早期这里多了 `APPROVED` 和 `REJECTED` —— 那是把「审批结论」误当成了「状态」：
 * 审批通过的结果是 ACTIVE，驳回则退回 DRAFT（见 ContractService.approve）。
 * 因为类型与常量表一起写错，类型检查发现不了，直到用户点筛选才报
 * 「status must be one of the following values」。
 *
 * 教训：这类枚举必须与后端单一来源对齐（见 `pnpm openapi:check`）。
 */
export type ContractStatus =
  | 'DRAFT'
  | 'PENDING_REVIEW'
  | 'ACTIVE'
  | 'EXPIRED'
  | 'TERMINATED';

/** 结算模式，与后端 enum SettlementMode 一致：FIXED_FEE / REVENUE_SHARE / HYBRID / CPA */
export type SettlementMode = 'FIXED_FEE' | 'REVENUE_SHARE' | 'HYBRID' | 'CPA';

export interface ContractListItem {
  id: string;
  code: string;
  title: string;
  creatorId: string;
  creatorName: string;
  brandId: string | null;
  brandName: string | null;
  status: ContractStatus;
  settlementMode: SettlementMode;
  currency: string;
  /** string 元 */
  fixedFee: string;
  /** 基点整数，1000 = 10% */
  platformFeeBp: number;
  agencyShareBp: number;
  talentShareBp: number;
  taxWithholdBp: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  signedAt: string | null;
  exclusivity: boolean;
  createdAt: string;
}

export interface TieredShare {
  /** 区间下限（元，字符串） */
  fromYuan: string;
  toYuan: string | null;
  talentShareBp: number;
}

export interface ProjectBrief {
  id: string;
  code: string;
  name: string;
  status: ProjectStatus;
}

/**
 * 合同交付要求。
 *
 * 后端是 Prisma 的 `Json` 字段，是**对象**而不是字符串：
 * 形如 `{ videosPerMonth: 4, platforms: ['DOUYIN', 'XIAOHONGSHU'] }`。
 * 早期这里声明成 `string | null` —— 类型与实现不符，于是把对象直接渲染到
 * JSX 里，React 抛「Objects are not valid as a React child」打崩整个详情页。
 * 声明成 `Record<string, unknown>` 后，任何直接渲染它的写法都会在编译期被拒。
 */
export type DeliverableSpec = Record<string, unknown>;

export interface ContractDetail extends ContractListItem {
  tieredShares: TieredShare[] | null;
  deliverableSpec: DeliverableSpec | null;
  breachClause: string | null;
  attachmentUrls: string[];
  reviewNote: string | null;
  reviewedBy: UserBrief | null;
  reviewedAt: string | null;
  projects: ProjectBrief[];
}

export interface ContractListQuery extends BaseListQuery {
  creatorId?: string;
  brandId?: string;
  status?: ContractStatus[];
}

export interface CreateContractRequest {
  creatorId: string;
  brandId?: string;
  title: string;
  settlementMode: SettlementMode;
  currency?: string;
  fixedFee: string;
  platformFeeBp: number;
  agencyShareBp: number;
  talentShareBp: number;
  taxWithholdBp: number;
  /** CPA 模式下的单价（元/次转化）。后端 CPA 模式要求该值 > 0 */
  cpaUnitPrice?: string;
  effectiveFrom: string;
  effectiveTo?: string;
  exclusivity?: boolean;
  /** 独家范围说明，如「美妆类目」。exclusivity 为 true 时审批会校验冲突 */
  exclusivityScope?: string;
  deliverableSpec?: DeliverableSpec;
  breachClause?: string;
  attachmentUrls?: string[];
  tieredShares?: TieredShare[];
}

export type UpdateContractRequest = Partial<CreateContractRequest>;

export interface ApproveContractRequest {
  approved: boolean;
  note?: string;
}

export interface TerminateContractRequest {
  reason: string;
  /**
   * 存在未结清结算单时是否强制终止。
   * 不传时后端会返回 409 并告知未结清数量 —— 这是有意的保护：
   * 直接终止会让财务链路断裂（有内容已发布、有分成未结清）。
   */
  force?: boolean;
}

export interface SettlementPreviewItem {
  contentId: string;
  title: string;
  publishedAt: string | null;
  grossYuan: string;
  platformFeeYuan: string;
  talentGrossYuan: string;
  taxYuan: string;
  netYuan: string;
}

export interface SettlementPreviewSummary {
  grossYuan: string;
  platformFeeYuan: string;
  agencyShareYuan: string;
  talentGrossYuan: string;
  taxYuan: string;
  netYuan: string;
}

export interface SettlementPreview {
  items: SettlementPreviewItem[];
  summary: SettlementPreviewSummary;
}

/* ============================================================
   项目与内容
   ============================================================ */

/**
 * 项目状态。
 *
 * 与后端 Prisma `enum ProjectStatus` 严格一致：
 * DRAFT / SCHEDULED / IN_PRODUCTION / IN_REVIEW / PUBLISHED / COMPLETED / CANCELED。
 *
 * 早期这里写的是 PLANNING / IN_PROGRESS / DELIVERING / PAUSED / CANCELLED —— 五个全是错的，
 * 而且拼写也不一致（后端是 `CANCELED` 单 L，前端写成 `CANCELLED`）。
 * 因为类型与常量表一起写错，类型检查发现不了，直到用户点筛选才报 400。
 */
export type ProjectStatus =
  | 'DRAFT'
  | 'SCHEDULED'
  | 'IN_PRODUCTION'
  | 'IN_REVIEW'
  | 'PUBLISHED'
  | 'COMPLETED'
  | 'CANCELED';

export interface ProjectListItem {
  id: string;
  code: string;
  name: string;
  status: ProjectStatus;
  vertical: Vertical | null;
  brandId: string | null;
  brandName: string | null;
  creatorId: string | null;
  creatorName: string | null;
  /** string 元 */
  budget: string;
  /** string 元 */
  actualCost: string;
  startDate: string | null;
  dueDate: string | null;
  ownerId: string | null;
  ownerName: string | null;
  contentCount: number;
  publishedCount: number;
}

export interface ProjectDetail extends ProjectListItem {
  /** 项目 brief（后端字段名是 brief，不是 description） */
  brief: string | null;
  completedAt: string | null;
  /** 品牌与达人用内嵌对象返回（列表行里是扁平的 brandName/creatorName） */
  brand: { id: string; name: string } | null;
  creator: { id: string; name: string; code: string; status: string } | null;
  contract: {
    id: string;
    code: string;
    title: string;
    status: string;
    effectiveFrom: string;
    effectiveTo: string;
  } | null;
  contents: Array<{
    id: string;
    title: string;
    platform: string;
    status: string;
    statusLabel: string;
    publishedAt: string | null;
    /** BigInt 序列化为字符串 */
    viewCount: string;
  }>;
  stats: {
    contentCount: number;
    publishedCount: number;
    totalRevenueYuan: string;
    totalViewCount: string;
    budget: string;
    actualCost: string;
    costRatePercent: number;
  };
  /** 状态机可选动作：前端只渲染这里给出的流转，不硬编码状态图 */
  statusMachine: { allowedNext: Array<{ value: ProjectStatus; label: string }> };
  createdAt: string;
  updatedAt: string;
}

export interface ProjectListQuery extends BaseListQuery {
  status?: ProjectStatus[];
  brandId?: string;
  creatorId?: string;
}

/**
 * 新建项目请求体。
 *
 * 字段名与后端 CreateProjectDto **严格对齐**，两处曾经存在的偏差都已被后端
 * 的 `forbidNonWhitelisted` 拦下并修正（就是「新建项目提示校验失败」的根因）：
 *   1) `status` —— 后端 DTO 里没有这个字段。项目创建后固定是 DRAFT，
 *      状态流转必须走 `POST /api/projects/:id/status`（受状态机约束并写审计日志）。
 *      允许创建时直接指定状态会绕过状态机。
 *   2) `description` —— 后端字段名是 `brief`（项目交付说明）。
 */
export interface CreateProjectRequest {
  name: string;
  brandId?: string;
  creatorId?: string;
  contractId?: string;
  vertical?: Vertical;
  budget?: string;
  ownerId?: string;
  startDate?: string;
  dueDate?: string;
  /** 项目 brief：内容方向、交付要求、注意事项 */
  brief?: string;
}

export type UpdateProjectRequest = Partial<CreateProjectRequest>;

/**
 * 内容状态。
 *
 * 与后端 Prisma `enum ContentStatus` 严格一致：
 * IDEA / SCRIPTING / SHOOTING / EDITING / INTERNAL_REVIEW / PLATFORM_REVIEW / PUBLISHED / REJECTED / OFFLINE。
 *
 * 早期这里写的是 DRAFT / PENDING_REVIEW / APPROVED / SCHEDULED —— 那是一套通用的
 * 「草稿→审核→发布」流程，与后端实际的内容生产流水线（选题→脚本→拍摄→剪辑→
 * 内部审核→平台审核→发布）完全不同，四个值里没有一个对得上。
 */
export type ContentStatus =
  | 'IDEA'
  | 'SCRIPTING'
  | 'SHOOTING'
  | 'EDITING'
  | 'INTERNAL_REVIEW'
  | 'PLATFORM_REVIEW'
  | 'PUBLISHED'
  | 'REJECTED'
  | 'OFFLINE';

export type ComplianceLevel = 'PASS' | 'WARN' | 'REJECT';

export interface ContentListItem {
  id: string;
  title: string;
  creatorId: string;
  creatorName: string;
  projectId: string | null;
  projectName: string | null;
  platform: Platform;
  status: ContentStatus;
  scheduledAt: string | null;
  publishedAt: string | null;
  viewCount: string;
  likeCount: string;
  commentCount: string;
  shareCount: string;
  revenueYuan: string;
  /** number，百分数如 42.5 */
  completionRate: number;
  conversions: number;
  complianceScore: number | null;
  complianceFlags: ComplianceFlag[] | null;
  publishedUrl: string | null;
}

export interface ComplianceFlag {
  level: ComplianceLevel;
  category: string;
  snippet: string;
  reason: string;
  suggestion: string;
}

export interface ContentDetail extends ContentListItem {
  script: ScriptOutput | null;
  reviewNote: string | null;
  reviewedBy: UserBrief | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContentListQuery extends BaseListQuery {
  creatorId?: string;
  projectId?: string;
  platform?: Platform;
  status?: ContentStatus[];
  from?: string;
  to?: string;
}

export interface CreateContentRequest {
  title: string;
  creatorId: string;
  projectId?: string;
  /** 关联的平台账号（可空：内容可能还没确定发在哪个号上） */
  accountId?: string;
  platform: Platform;
  /**
   * 初始状态。仅允许 IDEA / SCRIPTING，其余状态必须走状态机接口
   * （submit-review → review → publish），否则会出现「从未真正发布却已 PUBLISHED」的内容，
   * 而结算与数据采集会认到它。
   */
  status?: ContentStatus;
  /** 预置时长（秒），用于排期与分镜对齐 */
  durationSec?: number;
  scheduledAt?: string;
  script?: ScriptOutput;
  /** 关联的 AI 任务 ID（脚本由 AI 生成时回填，便于追溯用的哪个 Prompt） */
  aiTaskId?: string;
}

/**
 * 更新内容请求。
 *
 * 用 Omit 排除 status：后端 `UpdateContentDto` 是
 * `PartialType(OmitType(CreateContentDto, ['status']))`，
 * 状态变更只能走 `submit-review` / `review` / `publish` 三个接口。
 * 早期这里直接用 `Partial<CreateContentRequest>` 导致前端提交 status，
 * 被后端的 forbidNonWhitelisted 拒绝（400 property status should not exist）——
 * 与项目表单是同一类契约漂移，已由 `pnpm openapi:check` 固化拦截。
 */
export type UpdateContentRequest = Partial<Omit<CreateContentRequest, 'status'>>;

export interface ReviewContentRequest {
  approved: boolean;
  note?: string;
  rejectReason?: string;
}

export interface PublishContentRequest {
  platformContentId?: string;
  publishedUrl?: string;
  publishedAt?: string;
}

/* ============================================================
   AI（同时被「AI 工作台」「内容详情」「结算详情」使用）
   ============================================================ */

export type AiTaskType =
  | 'SCRIPT_GENERATE'
  | 'TITLE_OPTIMIZE'
  | 'CREATOR_MATCH'
  | 'COMMENT_INSIGHT'
  | 'COMPLIANCE_CHECK'
  | 'SETTLEMENT_ANOMALY'
  | 'DAILY_BRIEF';

/**
 * AI 任务状态，与后端 `enum AiTaskStatus` 一致。
 *
 * 这是最隐蔽的一处漂移：前端写的是 `PENDING` / `FALLBACK`，后端实际下发的是
 * `QUEUED` / `FALLBACK_USED`。字面量对不上时 TypeScript 帮不上忙 ——
 * 因为它只检查「前端自己声明的前端自己用」，`data.status === 'PENDING'` 两侧
 * 都取自这个联合类型，永远自洽。
 *
 * 影响：轮询条件 `status === 'PENDING' || status === 'RUNNING'` 里
 * PENDING 这一支永远不会命中；`REJECTED`（成本/安全预检未通过、根本没调模型）
 * 也没有对应的展示分支，任务会显示成空白状态。
 */
export type AiTaskStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'FALLBACK_USED'
  | 'REJECTED';

/** 仍在进行中的状态：轮询与「生成中」骨架屏共用同一个判断，避免两处各写一遍再漂移 */
export const AI_TASK_IN_FLIGHT_STATUSES: readonly AiTaskStatus[] = ['QUEUED', 'RUNNING'];

/** 判断任务是否还在进行中 */
export function isAiTaskInFlight(status: AiTaskStatus | undefined): boolean {
  return status !== undefined && AI_TASK_IN_FLIGHT_STATUSES.includes(status);
}

export type HumanFeedback = 1 | -1;

export interface ScriptScene {
  index: number;
  timeRange: string;
  shot: string;
  voiceover: string;
  note?: string;
}

export interface ScriptOutput {
  title: string;
  hook: string;
  scenes: ScriptScene[];
  hashtags: string[];
  risks: string[];
}

export interface ComplianceCheckOutput {
  score: number;
  level: ComplianceLevel;
  flags: ComplianceFlag[];
}

export interface CreatorMatchItem {
  creatorId: string;
  creatorName: string;
  score: number;
  reasons: string[];
  risks: string[];
}

export interface CreatorMatchOutput {
  matches: CreatorMatchItem[];
}

/** 其他任务类型的输出结构后端仍在定型，用宽松映射兜底展示 JSON */
export type AiTaskOutput =
  | ScriptOutput
  | ComplianceCheckOutput
  | CreatorMatchOutput
  | Record<string, unknown>
  | null;

export interface AiTaskListItem {
  id: string;
  taskType: AiTaskType;
  status: AiTaskStatus;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costCents: number;
  latencyMs: number;
  retryCount: number;
  fallbackReason: string | null;
  humanFeedback: HumanFeedback | null;
  output: AiTaskOutput;
  createdAt: string;
  requestedByName: string;
}

export interface AiTaskListQuery extends BaseListQuery {
  taskType?: AiTaskType;
  status?: AiTaskStatus;
  creatorId?: string;
}

export interface CreateAiTaskRequest {
  taskType: AiTaskType;
  input: Record<string, unknown>;
  creatorId?: string;
  /** 幂等键：同一逻辑操作重试（网络抖动/用户连点）不会重复计费 */
  idempotencyKey?: string;
}

export interface AiTaskFeedbackRequest {
  feedback: HumanFeedback;
  note?: string;
}

export interface AiPromptTemplate {
  id: string;
  key: string;
  version: number;
  name: string;
  description: string | null;
  systemPrompt: string;
  userPromptTemplate: string;
  variables: string[];
  model: string;
  temperature: number;
  maxTokens: number;
  isActive: boolean;
  rolloutPercent: number;
}

export interface UpsertAiPromptRequest {
  key: string;
  name: string;
  description?: string;
  systemPrompt: string;
  userPromptTemplate: string;
  variables?: string[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  isActive?: boolean;
  rolloutPercent?: number;
}

export interface AiUsageByType {
  taskType: AiTaskType;
  count: number;
  costCents: number;
}

export interface AiUsage {
  monthCny: number;
  budgetCny: number;
  usedPercent: number;
  totalTasks: number;
  succeeded: number;
  failed: number;
  fallback: number;
  avgLatencyMs: number;
  byType: AiUsageByType[];
  adoptionRate: number;
}

/* ============================================================
   结算
   ============================================================ */

/**
 * 结算单状态。
 *
 * 与后端 Prisma `enum SettlementStatus` 严格一致：DRAFT / PENDING_APPROVAL / APPROVED / PAID / DISPUTED / VOID。
 * 末态是 `VOID`（作废），不是 `CANCELLED` —— 作废后同一账期可以重新生成结算单。
 */
export type SettlementStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'PAID'
  | 'DISPUTED'
  | 'VOID';

/**
 * 结算明细类型，与后端 itemType 字段一致。
 * 注意是 `REVENUE`（流水分成），不是 `CONTENT` —— 明细按「分成/一口价/CPA/补款/扣款」区分，
 * 而不是按来源载体（载体信息在 contentId / contractId 里）。
 */
export type SettlementItemType = 'REVENUE' | 'FIXED_FEE' | 'CPA' | 'BONUS' | 'DEDUCTION';

export interface SettlementListItem {
  id: string;
  code: string;
  creatorId: string;
  creatorName: string;
  periodStart: string;
  periodEnd: string;
  status: SettlementStatus;
  currency: string;
  grossAmount: string;
  platformFee: string;
  agencyShare: string;
  talentGross: string;
  taxWithheld: string;
  netPayable: string;
  adjustmentAmount: string;
  dueDate: string | null;
  approvedAt: string | null;
  paidAt: string | null;
  itemCount: number;
  createdAt: string;
}

export interface SettlementItem {
  id: string;
  itemType: SettlementItemType;
  description: string;
  grossAmount: string;
  platformFee: string;
  talentGross: string;
  taxWithheld: string;
  netPayable: string;
  platformFeeBp: number;
  agencyShareBp: number;
  talentShareBp: number;
  taxWithholdBp: number;
  contentId: string | null;
  contractCode: string | null;
  calculatedAt: string;
}

export interface SettlementDetail extends SettlementListItem {
  items: SettlementItem[];
  /** 后端返回的计算链路（含每一步公式与输入），前端只渲染不重算 */
  calculationTrace: Record<string, unknown> | null;
  disputeReason: string | null;
  remark: string | null;
  approvedBy: UserBrief | null;
  paymentVoucherUrl: string | null;
}

export interface SettlementListQuery extends BaseListQuery {
  status?: SettlementStatus[];
  creatorId?: string;
  periodStart?: string;
  periodEnd?: string;
}

/**
 * 生成结算单请求。
 *
 * `month` 与 `periodStart/periodEnd` 二选一：
 *   - 传 `month`（YYYY-MM）按自然月出账，这是最常见的用法，
 *     也避免前端自己算月末（闰年 2 月、跨年 12 月都容易算错）；
 *   - 传区间则用于补跑或按自定义账期出账。
 * 两者都不传时后端返回 422（早期此处漏了 month，导致按月出账不可用）。
 */
export interface GenerateSettlementRequest {
  /** 账期（YYYY-MM），与 periodStart/periodEnd 二选一 */
  month?: string;
  periodStart?: string;
  periodEnd?: string;
  creatorIds?: string[];
}

export interface GeneratedSettlementBrief {
  id: string;
  code: string;
  creatorName: string;
  netPayable: string;
}

export interface GenerateSettlementResult {
  generated: number;
  skipped: number;
  totalNetYuan: string;
  settlements: GeneratedSettlementBrief[];
}

export interface AdjustSettlementRequest {
  /** 正负均可，字符串元 */
  amount: string;
  reason: string;
}

export interface PaySettlementRequest {
  paymentVoucherUrl?: string;
}

export interface DisputeSettlementRequest {
  reason: string;
}

export interface SettlementExportQuery {
  periodStart?: string;
  periodEnd?: string;
  creatorId?: string;
}

/* ============================================================
   通知 / 待办
   ============================================================ */

/**
 * 通知类型，与后端 `enum NotificationType` 一致。
 *
 * 它同时是**看板待办**（`GET /dashboard/overview` 的 `pendingTodos[].type`）的取值，
 * 侧边栏红点就是用这个值去匹配的。
 *
 * 早期前端把这个字段声明成 `type: string`，而 AppLayout 里的徽标键写的是
 * `'CONTRACT_PENDING_REVIEW'` / `'CONTENT_PENDING_REVIEW'` / `'SETTLEMENT_PENDING_APPROVAL'`
 * —— 三个都是编的。`string` 让比较永远"合法"，于是侧边栏红点**一个都不会显示**，
 * 而且不报任何错。声明成枚举后，写错的键会直接编译失败。
 */
export type NotificationType =
  | 'CONTRACT_EXPIRING'
  | 'SETTLEMENT_DUE'
  | 'CONTENT_REVIEW'
  | 'ANOMALY_ALERT'
  | 'AI_TASK_DONE'
  | 'SYSTEM';

/* ============================================================
   经营看板
   ============================================================ */

export interface DashboardKpi {
  creatorTotal: number;
  creatorActive: number;
  creatorSignedThisMonth: number;
  contentPublished: number;
  contentPublishedDelta: number;
  revenueYuan: string;
  revenueDelta: number;
  settlementPendingYuan: string;
  settlementPendingCount: number;
  avgEngagementRate: number;
}

export interface FunnelStage {
  stage: string;
  label: string;
  count: number;
}

export interface RevenueTrendPoint {
  date: string;
  revenueYuan: string;
  contentCount: number;
}

export interface PlatformDistributionItem {
  platform: Platform | string;
  contentCount: number;
  revenueYuan: string;
}

export interface VerticalDistributionItem {
  vertical: Vertical | string;
  creatorCount: number;
}

export interface TopCreatorItem {
  creatorId: string;
  creatorName: string;
  revenueYuan: string;
  contentCount: number;
  avgViewCount: number;
}

export interface PendingTodo {
  /** 取值来自后端 NotificationType，侧边栏徽标按它匹配 */
  type: NotificationType;
  label: string;
  count: number;
  link: string;
}

export interface DashboardOverview {
  kpi: DashboardKpi;
  funnel: FunnelStage[];
  revenueTrend: RevenueTrendPoint[];
  platformDistribution: PlatformDistributionItem[];
  verticalDistribution: VerticalDistributionItem[];
  topCreators: TopCreatorItem[];
  pendingTodos: PendingTodo[];
}

export interface DashboardQuery {
  from?: string;
  to?: string;
}

/* ============================================================
   审计日志
   ============================================================ */

export interface AuditLogItem {
  id: string;
  userId: string | null;
  userName: string | null;
  action: string;
  resource: string;
  resourceId: string | null;
  success: boolean;
  message: string | null;
  /** 变更前后的快照，前端做字段级 diff 展示 */
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ip: string | null;
  userAgent: string | null;
  durationMs: number | null;
  createdAt: string;
}

export interface AuditLogQuery extends BaseListQuery {
  userId?: string;
  resource?: string;
  resourceId?: string;
  action?: string;
  success?: string;
  from?: string;
  to?: string;
}

export type AuditAction =
  | 'CREATE'
  | 'UPDATE'
  | 'DELETE'
  | 'READ'
  | 'APPROVE'
  | 'REJECT'
  | 'EXPORT'
  | 'LOGIN'
  | 'LOGOUT'
  | 'PAY'
  | 'SYNC'
  | 'OTHER';
