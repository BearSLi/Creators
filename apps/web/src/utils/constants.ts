import type {
  AgencyType,
  AiTaskStatus,
  AiTaskType,
  AuditAction,
  Availability,
  AvailabilityCommitment,
  BrandLevel,
  ComplianceLevel,
  ContentStatus,
  ContractStatus,
  CreatorStatus,
  CreatorTier,
  DataSource,
  NotificationType,
  Platform,
  ProjectStatus,
  RiskLevel,
  SettlementItemType,
  SettlementMode,
  SettlementStatus,
  UserRole,
  UserStatus,
  Vertical,
} from '@/api/types';

/**
 * 枚举中文映射 + 下拉选项。
 *
 * 为什么集中在一个文件：后端枚举变化时（新增渠道、新增平台）只需要改这里，
 * 页面里禁止出现裸的英文枚举值——那会让"某个状态忘了翻译"变成线上事故。
 */

export interface Option<T extends string> {
  value: T;
  label: string;
}

/** 由「值 → 中文」映射生成下拉选项，避免同一份枚举写两遍 */
function toOptions<T extends string>(labels: Record<T, string>): Array<Option<T>> {
  return (Object.keys(labels) as T[]).map((value) => ({ value, label: labels[value] }));
}

/* ---------------- 达人 ---------------- */

export const CREATOR_STATUS_LABELS: Record<CreatorStatus, string> = {
  LEAD: '线索',
  CONTACTING: '建联中',
  EVALUATING: '评估中',
  SIGNED: '已签约',
  ACTIVE: '合作中',
  PAUSED: '已暂停',
  TERMINATED: '已解约',
  BLACKLIST: '黑名单',
};

export const CREATOR_STATUS_OPTIONS = toOptions(CREATOR_STATUS_LABELS);

/** 状态色：与 StatusTag 的 tone 对应，保持列表里同一状态颜色一致 */
export const CREATOR_STATUS_TONES: Record<
  CreatorStatus,
  'neutral' | 'info' | 'warning' | 'success' | 'danger' | 'primary'
> = {
  LEAD: 'neutral',
  CONTACTING: 'info',
  EVALUATING: 'warning',
  SIGNED: 'primary',
  ACTIVE: 'success',
  PAUSED: 'warning',
  TERMINATED: 'danger',
  BLACKLIST: 'danger',
};

export const TIER_LABELS: Record<CreatorTier, string> = {
  S: 'S 级（头部）',
  A: 'A 级（优质）',
  B: 'B 级（成长）',
  C: 'C 级（潜力）',
  D: 'D 级（观察）',
};

export const TIER_OPTIONS = toOptions(TIER_LABELS);

export const VERTICAL_LABELS: Record<Vertical, string> = {
  SHORT_DRAMA: '短剧',
  LIFESTYLE: '生活',
  BEAUTY: '美妆',
  GAMING: '游戏',
  FOOD: '美食',
  TECH: '科技数码',
  KNOWLEDGE: '知识科普',
  FASHION: '时尚',
  FITNESS: '健身',
  OTHER: '其他',
};

export const VERTICAL_OPTIONS = toOptions(VERTICAL_LABELS);

/** 达人列表的垂类是 string[]，展示时统一走这个函数兜底未知值 */
export function verticalLabel(value: string): string {
  return VERTICAL_LABELS[value as Vertical] ?? value;
}

export const PLATFORM_LABELS: Record<Platform, string> = {
  DOUYIN: '抖音',
  XIAOHONGSHU: '小红书',
  BILIBILI: '哔哩哔哩',
  WECHAT_CHANNEL: '视频号',
  KUAISHOU: '快手',
  WEIBO: '微博',
  TIKTOK: 'TikTok',
  YOUTUBE: 'YouTube',
  INSTAGRAM: 'Instagram',
};

export const PLATFORM_OPTIONS = toOptions(PLATFORM_LABELS);

export function platformLabel(value: string): string {
  return PLATFORM_LABELS[value as Platform] ?? value;
}

export const DATA_SOURCE_LABELS: Record<DataSource, string> = {
  API_OFFICIAL: '官方接口',
  THIRD_PARTY: '第三方',
  SCREENSHOT: '截图录入',
  MANUAL: '人工填写',
  MOCK: '仿真数据',
};

export const DATA_SOURCE_OPTIONS = toOptions(DATA_SOURCE_LABELS);

/** 数据来源可信度：官方接口 > 第三方 > 人工，用于提示"这份数据能不能直接用于结算" */
export const DATA_SOURCE_TRUST: Record<DataSource, 'high' | 'medium' | 'low'> = {
  API_OFFICIAL: 'high',
  THIRD_PARTY: 'medium',
  SCREENSHOT: 'low',
  MANUAL: 'low',
  // 仿真数据不能作为结算依据，可信度单独标出来，避免演示数据被当成真实流水
  MOCK: 'low',
};

export const RISK_LEVEL_LABELS: Record<RiskLevel, string> = {
  LOW: '低',
  MEDIUM: '中',
  HIGH: '高',
};

export const RISK_LEVEL_TONES: Record<RiskLevel, 'success' | 'warning' | 'danger'> = {
  LOW: 'success',
  MEDIUM: 'warning',
  HIGH: 'danger',
};

export const AGENCY_TYPE_LABELS: Record<AgencyType, string> = {
  FULL_MCN: '全约（MCN 独家代理）',
  COMMERCIAL: '商务约（仅商单代理）',
  INDEPENDENT: '独立（无机构）',
};

export const AGENCY_TYPE_OPTIONS = toOptions(AGENCY_TYPE_LABELS);

/**
 * 招募渠道。后端是自由文本（`@IsString() @MaxLength(64)`），没有白名单校验，
 * 所以这里给的是**建议值**而不是枚举：`labels` 用 string 索引，
 * 遇到后端下发的自定义渠道时回退显示原文，而不是渲染成 undefined。
 */
export const SOURCE_CHANNEL_LABELS: Record<string, string> = {
  PLATFORM_RECOMMEND: '平台推荐',
  INBOUND: '主动咨询',
  OUTBOUND: '主动拓展',
  REFERRAL: '同行转介',
  AGENCY: '机构推荐',
  SCHOOL: '校园渠道',
  OFFLINE: '线下活动',
  DOUYIN_DM: '抖音私信',
  OTHER: '其他',
};

export const SOURCE_CHANNEL_OPTIONS = Object.entries(SOURCE_CHANNEL_LABELS).map(([value, label]) => ({
  value,
  label,
}));

/** 渠道名可能是后端下发的自定义值，取不到标签时显示原文 */
export function sourceChannelLabel(value: string | null | undefined): string {
  if (!value) return '—';
  return SOURCE_CHANNEL_LABELS[value] ?? value;
}

export const AVAILABILITY_LABELS: Record<AvailabilityCommitment, string> = {
  FULL_TIME: '全职合作',
  PART_TIME: '兼职合作',
  ON_BREAK: '暂停接单',
};

export const AVAILABILITY_OPTIONS = toOptions(AVAILABILITY_LABELS);

/** 档期是 JSON 对象，取 commitment 再查标签；老数据里可能是裸字符串，一并兼容 */
export function availabilityLabel(value: Availability | null | undefined): string {
  if (!value) return '—';
  const commitment = typeof value === 'string' ? value : value.commitment;
  if (!commitment) return '—';
  return AVAILABILITY_LABELS[commitment as AvailabilityCommitment] ?? String(commitment);
}

/** 合作评价的四个维度：内容力/商业力/配合度/数据力，各自 0~25 分 */
export const EVALUATION_DIMENSIONS = [
  { key: 'contentScore', label: '内容力', hint: '选题与脚本质量、镜头表现' },
  { key: 'commercialScore', label: '商业力', hint: '带货转化与品牌适配度' },
  { key: 'cooperationScore', label: '配合度', hint: '改稿配合、准时交付' },
  { key: 'dataScore', label: '数据力', hint: '播放/互动/涨粉表现' },
] as const;

/* ---------------- 合同 ---------------- */

/**
 * 合同状态。后端 `enum ContractStatus`：DRAFT / PENDING_REVIEW / ACTIVE / EXPIRED / TERMINATED。
 *
 * 早期这里多了 `APPROVED` 和 `REJECTED`，是把「本次审批的结论」当成了「合同的状态」。
 * 审批通过后合同就是 ACTIVE，驳回后回到 DRAFT（可改后重新提交），
 * 不存在 APPROVED/REJECTED 这两个持久化状态 —— 提交带这两个值的筛选条件会直接 400。
 */
export const CONTRACT_STATUS_LABELS: Record<ContractStatus, string> = {
  DRAFT: '草稿',
  PENDING_REVIEW: '待审核',
  ACTIVE: '生效中',
  EXPIRED: '已到期',
  TERMINATED: '已终止',
};

export const CONTRACT_STATUS_OPTIONS = toOptions(CONTRACT_STATUS_LABELS);

export const CONTRACT_STATUS_TONES: Record<
  ContractStatus,
  'neutral' | 'info' | 'warning' | 'success' | 'danger'
> = {
  DRAFT: 'neutral',
  PENDING_REVIEW: 'warning',
  ACTIVE: 'success',
  EXPIRED: 'neutral',
  TERMINATED: 'danger',
};

export const SETTLEMENT_MODE_LABELS: Record<SettlementMode, string> = {
  FIXED_FEE: '一口价',
  REVENUE_SHARE: '流水分成',
  HYBRID: '保底 + 分成',
  CPA: '按效果付费（CPA）',
};

export const SETTLEMENT_MODE_OPTIONS = toOptions(SETTLEMENT_MODE_LABELS);

/* ---------------- 项目与内容 ---------------- */

/**
 * 项目状态。后端 `enum ProjectStatus`：DRAFT / SCHEDULED / IN_PRODUCTION / IN_REVIEW / PUBLISHED / COMPLETED / CANCELED。
 *
 * 早期这里写的是 PLANNING / IN_PROGRESS / DELIVERING / COMPLETED / PAUSED / CANCELLED ——
 * 五个值是编的，而且 `CANCELLED` 还拼错了（后端是单 L 的 `CANCELED`）。
 * 项目筛选下拉直接调后端接口，选中任一项都会 400。
 */
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  DRAFT: '草稿',
  SCHEDULED: '已排期',
  IN_PRODUCTION: '制作中',
  IN_REVIEW: '审核中',
  PUBLISHED: '已发布',
  COMPLETED: '已结项',
  CANCELED: '已取消',
};

export const PROJECT_STATUS_OPTIONS = toOptions(PROJECT_STATUS_LABELS);

export const PROJECT_STATUS_TONES: Record<
  ProjectStatus,
  'neutral' | 'info' | 'warning' | 'success' | 'danger' | 'primary'
> = {
  DRAFT: 'neutral',
  SCHEDULED: 'info',
  IN_PRODUCTION: 'primary',
  IN_REVIEW: 'warning',
  PUBLISHED: 'success',
  COMPLETED: 'success',
  CANCELED: 'danger',
};

/**
 * 内容状态。后端 `enum ContentStatus`：IDEA / SCRIPTING / SHOOTING / EDITING /
 * INTERNAL_REVIEW / PLATFORM_REVIEW / PUBLISHED / REJECTED / OFFLINE。
 *
 * 这是一条真实的内容生产流水线（选题→脚本→拍摄→剪辑→内审→平台审→发布），
 * 早期前端却写成了 DRAFT / PENDING_REVIEW / APPROVED / SCHEDULED 这种通用审批状态，
 * 既不反映业务，也和后端完全对不上。
 */
export const CONTENT_STATUS_LABELS: Record<ContentStatus, string> = {
  IDEA: '选题',
  SCRIPTING: '脚本',
  SHOOTING: '拍摄',
  EDITING: '剪辑',
  INTERNAL_REVIEW: '内部审核',
  PLATFORM_REVIEW: '平台审核',
  PUBLISHED: '已发布',
  REJECTED: '已驳回',
  OFFLINE: '已下线',
};

export const CONTENT_STATUS_OPTIONS = toOptions(CONTENT_STATUS_LABELS);

export const CONTENT_STATUS_TONES: Record<
  ContentStatus,
  'neutral' | 'info' | 'warning' | 'success' | 'danger' | 'primary'
> = {
  IDEA: 'neutral',
  SCRIPTING: 'neutral',
  SHOOTING: 'info',
  EDITING: 'info',
  INTERNAL_REVIEW: 'warning',
  PLATFORM_REVIEW: 'warning',
  PUBLISHED: 'success',
  REJECTED: 'danger',
  OFFLINE: 'neutral',
};

/** 内容排期看板的列顺序：与内容生产流水线一致，前端只按这个顺序分列 */
export const CONTENT_BOARD_COLUMNS: ContentStatus[] = [
  'IDEA',
  'SCRIPTING',
  'SHOOTING',
  'EDITING',
  'INTERNAL_REVIEW',
  'PLATFORM_REVIEW',
  'PUBLISHED',
  'REJECTED',
  'OFFLINE',
];

/**
 * 可以执行「审核」动作的状态。
 *
 * 对应后端 `resolveApprovedNext()`：审核通过时 INTERNAL_REVIEW → PLATFORM_REVIEW，
 * PLATFORM_REVIEW → PUBLISHED，其它状态一律 409。
 * 早期前端判断的条件是 `status === 'PENDING_REVIEW'`（一个不存在的状态），
 * 结果「审核」按钮永远不会出现 —— 而这恰恰是内容审核的核心入口。
 */
export const CONTENT_REVIEWABLE_STATUSES: ContentStatus[] = ['INTERNAL_REVIEW', 'PLATFORM_REVIEW'];

export const COMPLIANCE_LEVEL_LABELS: Record<ComplianceLevel, string> = {
  PASS: '通过',
  WARN: '需关注',
  REJECT: '不建议发布',
};

export const COMPLIANCE_LEVEL_TONES: Record<ComplianceLevel, 'success' | 'warning' | 'danger'> = {
  PASS: 'success',
  WARN: 'warning',
  REJECT: 'danger',
};

/* ---------------- 结算 ---------------- */

/** 结算单状态。末态是 `VOID`（作废）—— 作废后同一账期可以重新生成，不是删除 */
export const SETTLEMENT_STATUS_LABELS: Record<SettlementStatus, string> = {
  DRAFT: '草稿',
  PENDING_APPROVAL: '待审批',
  APPROVED: '已审批',
  PAID: '已打款',
  DISPUTED: '争议中',
  VOID: '已作废',
};

export const SETTLEMENT_STATUS_OPTIONS = toOptions(SETTLEMENT_STATUS_LABELS);

export const SETTLEMENT_STATUS_TONES: Record<
  SettlementStatus,
  'neutral' | 'info' | 'warning' | 'success' | 'danger' | 'primary'
> = {
  DRAFT: 'neutral',
  PENDING_APPROVAL: 'warning',
  APPROVED: 'info',
  PAID: 'success',
  DISPUTED: 'danger',
  VOID: 'neutral',
};

/**
 * 结算明细类型。后端 `SettlementItem.itemType` 是 VarChar，取值
 * REVENUE / FIXED_FEE / CPA / BONUS / DEDUCTION —— 按**计费口径**分类，
 * 不是按来源载体分类（早期前端写的 CONTENT / ADJUSTMENT 就是按载体分的，错位）。
 * 载体信息本身在 contentId / contractId 里，不需要再单独做一类。
 */
export const SETTLEMENT_ITEM_TYPE_LABELS: Record<SettlementItemType, string> = {
  REVENUE: '流水分成',
  FIXED_FEE: '一口价',
  CPA: 'CPA 结算',
  BONUS: '奖励',
  DEDUCTION: '扣款',
};

/** 单笔净额超过该阈值时高亮，便于财务快速定位大额单（元） */
export const LARGE_AMOUNT_THRESHOLD_YUAN = 100000;

/* ---------------- AI ---------------- */

export const AI_TASK_TYPE_LABELS: Record<AiTaskType, string> = {
  SCRIPT_GENERATE: '脚本生成',
  TITLE_OPTIMIZE: '标题优化',
  CREATOR_MATCH: '达人匹配',
  COMMENT_INSIGHT: '评论洞察',
  COMPLIANCE_CHECK: '合规预检',
  SETTLEMENT_ANOMALY: '结算异常解释',
  DAILY_BRIEF: '运营日报',
};

export const AI_TASK_TYPE_OPTIONS = toOptions(AI_TASK_TYPE_LABELS);

export const AI_TASK_STATUS_LABELS: Record<AiTaskStatus, string> = {
  QUEUED: '排队中',
  RUNNING: '生成中',
  SUCCEEDED: '成功',
  FAILED: '失败',
  FALLBACK_USED: '降级完成',
  REJECTED: '未执行',
};

export const AI_TASK_STATUS_TONES: Record<
  AiTaskStatus,
  'neutral' | 'info' | 'warning' | 'success' | 'danger'
> = {
  QUEUED: 'neutral',
  RUNNING: 'info',
  SUCCEEDED: 'success',
  FAILED: 'danger',
  FALLBACK_USED: 'warning',
  REJECTED: 'warning',
};

export const HUMAN_FEEDBACK_LABELS: Record<string, string> = {
  '1': '已采纳',
  '-1': '已拒绝',
};

/** AI 工作台里可以直接填参数的任务类型与字段定义，驱动动态表单渲染 */
export const AI_TASK_INPUT_FIELDS: Record<
  string,
  Array<{ key: string; label: string; placeholder?: string; type?: 'text' | 'textarea' | 'select'; options?: string[] }>
> = {
  SCRIPT_GENERATE: [
    { key: 'brief', label: '创作 Brief', type: 'textarea', placeholder: '例：为美丽雅洗碗布做一条 60 秒种草短视频，突出吸油不沾手' },
    { key: 'vertical', label: '垂类', type: 'select', options: ['短剧', '生活', '美妆', '游戏', '美食', '科技数码', '知识科普', '时尚', '健身'] },
    { key: 'platform', label: '平台', type: 'select', options: ['抖音', '小红书', '哔哩哔哩', '视频号', '快手'] },
    { key: 'duration', label: '时长', placeholder: '例：60s' },
    { key: 'tone', label: '语气风格', placeholder: '例：轻松口语化、专业测评' },
    { key: 'creatorName', label: '达人昵称', placeholder: '选填，用于匹配人设口吻' },
  ],
  TITLE_OPTIMIZE: [
    { key: 'title', label: '原标题', type: 'textarea', placeholder: '粘贴待优化的标题' },
    { key: 'platform', label: '平台', type: 'select', options: ['抖音', '小红书', '哔哩哔哩', '视频号'] },
    { key: 'keyword', label: '核心关键词', placeholder: '选填，希望覆盖的搜索词' },
  ],
  CREATOR_MATCH: [
    { key: 'brief', label: '投放需求', type: 'textarea', placeholder: '例：母婴品牌新品，需要 20-50 万粉的宝妈向达人口播' },
    { key: 'vertical', label: '垂类', type: 'select', options: ['生活', '美妆', '美食', '知识科普', '健身'] },
    { key: 'budget', label: '预算（元）', placeholder: '例：30000' },
  ],
  COMMENT_INSIGHT: [
    { key: 'comments', label: '评论内容', type: 'textarea', placeholder: '每行一条评论，粘贴后提交' },
    { key: 'contentTitle', label: '内容标题', placeholder: '选填' },
  ],
  COMPLIANCE_CHECK: [
    { key: 'text', label: '待检文本', type: 'textarea', placeholder: '粘贴脚本或文案，检查极限词/医疗宣称等风险' },
    { key: 'platform', label: '平台', type: 'select', options: ['抖音', '小红书', '哔哩哔哩', '视频号'] },
  ],
  SETTLEMENT_ANOMALY: [
    { key: 'settlementCode', label: '结算单号', placeholder: '例：ST2024060001' },
    { key: 'question', label: '异常描述', type: 'textarea', placeholder: '例：这条结算比上月少了 30%，帮我看看原因' },
  ],
  DAILY_BRIEF: [
    { key: 'date', label: '日期', placeholder: '例：2024-06-18' },
    { key: 'scope', label: '范围', type: 'select', options: ['全团队', '我负责的达人', '指定项目'] },
  ],
};

/* ---------------- 系统 ---------------- */

export const ROLE_LABELS: Record<UserRole, string> = {
  SUPER_ADMIN: '系统管理员',
  OPERATIONS: '运营',
  BD: '商务',
  CONTENT: '内容',
  FINANCE: '财务',
  AUDITOR: '审计（只读）',
};

export const ROLE_OPTIONS = toOptions(ROLE_LABELS);

export const USER_STATUS_LABELS: Record<UserStatus, string> = {
  ACTIVE: '正常',
  DISABLED: '已停用',
};

export const USER_STATUS_OPTIONS = toOptions(USER_STATUS_LABELS);

export const USER_STATUS_TONES: Record<UserStatus, 'success' | 'neutral' | 'danger'> = {
  ACTIVE: 'success',
  DISABLED: 'neutral',
};

export const BRAND_LEVEL_LABELS: Record<BrandLevel, string> = {
  S: 'S 级（战略客户）',
  A: 'A 级（重点客户）',
  B: 'B 级（常规客户）',
  C: 'C 级（长尾客户）',
};

export const BRAND_LEVEL_OPTIONS = toOptions(BRAND_LEVEL_LABELS);

export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  CREATE: '新建',
  UPDATE: '修改',
  DELETE: '删除',
  READ: '查看',
  APPROVE: '审批通过',
  REJECT: '驳回',
  EXPORT: '导出',
  LOGIN: '登录',
  LOGOUT: '登出',
  PAY: '打款',
  SYNC: '数据同步',
  OTHER: '其他',
};

export const AUDIT_ACTION_OPTIONS = toOptions(AUDIT_ACTION_LABELS);

/**
 * 通知 / 待办类型的中文标签。
 * 看板待办与侧边栏红点共用这一份映射 —— 早期两侧各写一套英文键，各错各的。
 */
export const NOTIFICATION_TYPE_LABELS: Record<NotificationType, string> = {
  CONTRACT_EXPIRING: '合同即将到期',
  SETTLEMENT_DUE: '结算单待处理',
  CONTENT_REVIEW: '内容待审核',
  ANOMALY_ALERT: '异常待排查',
  AI_TASK_DONE: 'AI 任务完成',
  SYSTEM: '系统通知',
};

/** 审计日志的资源类型，与后端装饰器里的 resource 名保持一致 */
export const AUDIT_RESOURCE_LABELS: Record<string, string> = {
  creator: '达人',
  creator_account: '平台账号',
  contract: '合同',
  project: '项目',
  content: '内容',
  settlement: '结算单',
  brand: '品牌',
  tag: '标签',
  user: '员工',
  auth: '认证',
  ai_task: 'AI 任务',
  ai_prompt: 'Prompt 模板',
};

/* ---------------- 通用 ---------------- */

/**
 * 标签分类。
 *
 * 取值必须与后端契约一致：`tag.controller.ts` 的 CreateTagDto 注明
 * capability(能力) / category(品类) / risk(风险) / custom，
 * seed.ts 里的 10 个标签也全部用这四个词。
 *
 * 早期前端写的是 STYLE / SCENE / PRICE / COOPERATION / RISK —— 五个全是编的。
 * 因为后端 `Tag.category` 是自由文本（@IsString + @MaxLength，没有 @IsIn），
 * 提交不会报错，只会**把 'STYLE' 这种没人认识的分类静默写库**：
 * 从 UI 建的标签在后端报表和 seed 数据里自成一类，按 category 筛选永远对不上。
 */
export type TagCategory = 'capability' | 'category' | 'risk' | 'custom';

export const TAG_CATEGORY_LABELS: Record<TagCategory, string> = {
  capability: '能力标签',
  category: '品类标签',
  risk: '风险标记',
  custom: '自定义',
};

export const TAG_CATEGORY_OPTIONS = toOptions(TAG_CATEGORY_LABELS);

export const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

/** 分润四档的展示顺序：平台费 → 公司分成 → 达人分成 → 代扣税 */
export const SHARE_BP_FIELDS = [
  { key: 'platformFeeBp', label: '平台费' },
  { key: 'agencyShareBp', label: '公司分成' },
  { key: 'talentShareBp', label: '达人分成' },
  { key: 'taxWithholdBp', label: '代扣税' },
] as const;

/** 手机号校验：与后端 DTO 的 @Matches 保持一致，前端先拦一道减少无效请求 */
export const PHONE_PATTERN = /^1[3-9]\d{9}$/;
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
