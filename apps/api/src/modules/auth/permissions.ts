import { UserRole } from '@prisma/client';

/**
 * 权限模型（RBAC + 数据范围 + 资源归属校验）
 *
 * 三级判定，缺一不可：
 *   1) 功能权限：能不能进这个接口（PERMISSIONS 命中与否）
 *   2) 数据范围：能看/能改哪些数据（ScopeGuard：ALL / TEAM / OWN）
 *   3) 归属校验：这条数据是不是你的（Service 层 assertOwnership）
 *
 * 为什么不只用角色判断：达人手机号、结算金额属于敏感数据，
 * 「能进行人列表」不等于「能看全部达人的结算」。所以把权限点拆到动作级。
 */

export const PERMISSIONS = {
  // ---- 达人主数据 ----
  CREATOR_READ: 'creator:read',
  CREATOR_WRITE: 'creator:write',
  CREATOR_DELETE: 'creator:delete',
  CREATOR_EXPORT: 'creator:export', // 导出含手机号/微信号，单独授权
  CREATOR_SENSITIVE_READ: 'creator:sensitive:read', // 查看证件号/手机号明文
  CREATOR_ASSIGN: 'creator:assign', // 分配负责人

  // ---- 平台账号与数据 ----
  ACCOUNT_READ: 'account:read',
  ACCOUNT_WRITE: 'account:write',
  METRICS_SYNC: 'metrics:sync', // 手动触发采集
  METRICS_READ: 'metrics:read',

  // ---- 品牌 ----
  BRAND_READ: 'brand:read',
  BRAND_WRITE: 'brand:write',

  // ---- 合同 ----
  CONTRACT_READ: 'contract:read',
  CONTRACT_WRITE: 'contract:write',
  CONTRACT_SUBMIT: 'contract:submit', // 提交审核
  CONTRACT_APPROVE: 'contract:approve', // 审批通过/驳回
  CONTRACT_TERMINATE: 'contract:terminate',

  // ---- 项目与内容 ----
  PROJECT_READ: 'project:read',
  PROJECT_WRITE: 'project:write',
  CONTENT_READ: 'content:read',
  CONTENT_WRITE: 'content:write',
  CONTENT_REVIEW: 'content:review', // 内容审核
  CONTENT_PUBLISH: 'content:publish',

  // ---- 结算（资金相关，权限最细）----
  SETTLEMENT_READ: 'settlement:read',
  SETTLEMENT_GENERATE: 'settlement:generate',
  SETTLEMENT_EDIT: 'settlement:edit',
  SETTLEMENT_APPROVE: 'settlement:approve',
  SETTLEMENT_PAY: 'settlement:pay',
  SETTLEMENT_EXPORT: 'settlement:export',

  // ---- AI ----
  AI_RUN: 'ai:run',
  AI_FEEDBACK: 'ai:feedback',
  AI_PROMPT_READ: 'ai:prompt:read',
  AI_PROMPT_WRITE: 'ai:prompt:write',

  // ---- 系统 ----
  USER_READ: 'user:read',
  USER_WRITE: 'user:write',
  ROLE_MANAGE: 'role:manage',
  AUDIT_READ: 'audit:read',
  DASHBOARD_READ: 'dashboard:read',
  SYSTEM_CONFIG: 'system:config',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS);

/** 权限点中文名 + 说明，用于「角色管理」页面渲染勾选框 */
export const PERMISSION_META: Record<Permission, { label: string; group: string; risk: 'low' | 'medium' | 'high' }> = {
  [PERMISSIONS.CREATOR_READ]: { label: '查看达人', group: '达人', risk: 'low' },
  [PERMISSIONS.CREATOR_WRITE]: { label: '新建/编辑达人', group: '达人', risk: 'low' },
  [PERMISSIONS.CREATOR_DELETE]: { label: '删除达人', group: '达人', risk: 'high' },
  [PERMISSIONS.CREATOR_EXPORT]: { label: '导出达人数据', group: '达人', risk: 'high' },
  [PERMISSIONS.CREATOR_SENSITIVE_READ]: { label: '查看敏感信息', group: '达人', risk: 'high' },
  [PERMISSIONS.CREATOR_ASSIGN]: { label: '分配负责人', group: '达人', risk: 'medium' },

  [PERMISSIONS.ACCOUNT_READ]: { label: '查看平台账号', group: '账号数据', risk: 'low' },
  [PERMISSIONS.ACCOUNT_WRITE]: { label: '维护平台账号', group: '账号数据', risk: 'low' },
  [PERMISSIONS.METRICS_SYNC]: { label: '触发数据采集', group: '账号数据', risk: 'medium' },
  [PERMISSIONS.METRICS_READ]: { label: '查看数据看板', group: '账号数据', risk: 'low' },

  [PERMISSIONS.BRAND_READ]: { label: '查看品牌', group: '品牌', risk: 'low' },
  [PERMISSIONS.BRAND_WRITE]: { label: '维护品牌', group: '品牌', risk: 'medium' },

  [PERMISSIONS.CONTRACT_READ]: { label: '查看合同', group: '合同', risk: 'low' },
  [PERMISSIONS.CONTRACT_WRITE]: { label: '拟定合同', group: '合同', risk: 'medium' },
  [PERMISSIONS.CONTRACT_SUBMIT]: { label: '提交合同审核', group: '合同', risk: 'medium' },
  [PERMISSIONS.CONTRACT_APPROVE]: { label: '审批合同', group: '合同', risk: 'high' },
  [PERMISSIONS.CONTRACT_TERMINATE]: { label: '解约/终止合同', group: '合同', risk: 'high' },

  [PERMISSIONS.PROJECT_READ]: { label: '查看项目', group: '项目内容', risk: 'low' },
  [PERMISSIONS.PROJECT_WRITE]: { label: '维护项目', group: '项目内容', risk: 'medium' },
  [PERMISSIONS.CONTENT_READ]: { label: '查看内容', group: '项目内容', risk: 'low' },
  [PERMISSIONS.CONTENT_WRITE]: { label: '维护内容', group: '项目内容', risk: 'medium' },
  [PERMISSIONS.CONTENT_REVIEW]: { label: '内容审核', group: '项目内容', risk: 'medium' },
  [PERMISSIONS.CONTENT_PUBLISH]: { label: '发布/下线内容', group: '项目内容', risk: 'medium' },

  [PERMISSIONS.SETTLEMENT_READ]: { label: '查看结算单', group: '结算', risk: 'medium' },
  [PERMISSIONS.SETTLEMENT_GENERATE]: { label: '生成结算单', group: '结算', risk: 'high' },
  [PERMISSIONS.SETTLEMENT_EDIT]: { label: '调整结算明细', group: '结算', risk: 'high' },
  [PERMISSIONS.SETTLEMENT_APPROVE]: { label: '审批结算单', group: '结算', risk: 'high' },
  [PERMISSIONS.SETTLEMENT_PAY]: { label: '标记打款', group: '结算', risk: 'high' },
  [PERMISSIONS.SETTLEMENT_EXPORT]: { label: '导出结算表', group: '结算', risk: 'high' },

  [PERMISSIONS.AI_RUN]: { label: '使用 AI 能力', group: 'AI', risk: 'low' },
  [PERMISSIONS.AI_FEEDBACK]: { label: '提交 AI 反馈', group: 'AI', risk: 'low' },
  [PERMISSIONS.AI_PROMPT_READ]: { label: '查看 Prompt 模板', group: 'AI', risk: 'medium' },
  [PERMISSIONS.AI_PROMPT_WRITE]: { label: '维护 Prompt 模板', group: 'AI', risk: 'medium' },

  [PERMISSIONS.USER_READ]: { label: '查看员工', group: '系统', risk: 'medium' },
  [PERMISSIONS.USER_WRITE]: { label: '维护员工', group: '系统', risk: 'high' },
  [PERMISSIONS.ROLE_MANAGE]: { label: '分配角色与权限', group: '系统', risk: 'high' },
  [PERMISSIONS.AUDIT_READ]: { label: '查看审计日志', group: '系统', risk: 'high' },
  [PERMISSIONS.DASHBOARD_READ]: { label: '查看经营看板', group: '系统', risk: 'low' },
  [PERMISSIONS.SYSTEM_CONFIG]: { label: '系统配置', group: '系统', risk: 'high' },
};

/** 只读权限集合：审计角色只能拿这些 */
const READ_ONLY_PERMISSIONS: Permission[] = ALL_PERMISSIONS.filter((p) => /:(read|export)$/.test(p));

/**
 * 仅系统管理员可持有的高敏感权限。
 *
 * 刻意不下放给任何业务角色，理由分别是：
 *   - `creator:delete`     删除达人会破坏业务链路，运营只应「解约」而非删除；
 *   - `contract:terminate` 终止合同涉及违约与法务后果；
 *   - `ai:prompt:write`    改 Prompt 会同时影响所有人的 AI 输出质量，属于平台级配置；
 *   - `user:write` / `role:manage`  账号与授权管理；
 *   - `system:config`      系统配置。
 *
 * 这份清单被两处共用，避免"文档写一套、测试查另一套"：
 *   1) 权限矩阵单元测试会断言「除这些之外，每个权限点都必须分配给某个业务角色」，
 *      用来拦住"新增权限点却忘了配角色"这类漏配；
 *   2) 角色管理页面对这些权限做特别提示。
 * 若将来要下放其中某一项，请只改这一处，矩阵与文档同步更新。
 */
export const ADMIN_ONLY_PERMISSIONS: readonly Permission[] = [
  PERMISSIONS.CREATOR_DELETE,
  PERMISSIONS.CONTRACT_TERMINATE,
  PERMISSIONS.AI_PROMPT_WRITE,
  PERMISSIONS.USER_WRITE,
  PERMISSIONS.ROLE_MANAGE,
  PERMISSIONS.SYSTEM_CONFIG,
];

/** 角色 → 权限点矩阵。新增权限点时请同步更新本矩阵与单元测试。 */
export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  // 系统管理员：全部权限
  SUPER_ADMIN: ALL_PERMISSIONS,

  // 运营：达人全生命周期 + 内容排期 + AI 工具，但不碰资金审批与员工管理
  OPERATIONS: [
    PERMISSIONS.CREATOR_READ,
    PERMISSIONS.CREATOR_WRITE,
    PERMISSIONS.CREATOR_EXPORT,
    PERMISSIONS.CREATOR_SENSITIVE_READ,
    PERMISSIONS.CREATOR_ASSIGN,
    PERMISSIONS.ACCOUNT_READ,
    PERMISSIONS.ACCOUNT_WRITE,
    PERMISSIONS.METRICS_SYNC,
    PERMISSIONS.METRICS_READ,
    PERMISSIONS.BRAND_READ,
    PERMISSIONS.CONTRACT_READ,
    PERMISSIONS.CONTRACT_WRITE,
    PERMISSIONS.CONTRACT_SUBMIT,
    // 审批合同：运营有权审自己负责达人的合同。
    // 原先该权限只挂在 SUPER_ADMIN 上，等于「合同必须找管理员批」，
    // 实际业务里会卡住流程（这也是权限矩阵测试专门要拦的漏配）。
    PERMISSIONS.CONTRACT_APPROVE,
    PERMISSIONS.PROJECT_READ,
    PERMISSIONS.PROJECT_WRITE,
    PERMISSIONS.CONTENT_READ,
    PERMISSIONS.CONTENT_WRITE,
    PERMISSIONS.CONTENT_REVIEW,
    PERMISSIONS.CONTENT_PUBLISH,
    PERMISSIONS.SETTLEMENT_READ,
    PERMISSIONS.SETTLEMENT_GENERATE,
    PERMISSIONS.AI_RUN,
    PERMISSIONS.AI_FEEDBACK,
    PERMISSIONS.AI_PROMPT_READ,
    PERMISSIONS.DASHBOARD_READ,
  ],

  // 商务：品牌与合同线，可看结算金额但不可审批/打款
  BD: [
    PERMISSIONS.CREATOR_READ,
    PERMISSIONS.CREATOR_WRITE,
    PERMISSIONS.ACCOUNT_READ,
    PERMISSIONS.METRICS_READ,
    PERMISSIONS.BRAND_READ,
    PERMISSIONS.BRAND_WRITE,
    PERMISSIONS.CONTRACT_READ,
    PERMISSIONS.CONTRACT_WRITE,
    PERMISSIONS.CONTRACT_SUBMIT,
    PERMISSIONS.PROJECT_READ,
    PERMISSIONS.PROJECT_WRITE,
    PERMISSIONS.CONTENT_READ,
    PERMISSIONS.SETTLEMENT_READ,
    PERMISSIONS.AI_RUN,
    PERMISSIONS.AI_FEEDBACK,
    PERMISSIONS.DASHBOARD_READ,
  ],

  // 内容：选题、脚本、成片，不接触合同金额与结算
  CONTENT: [
    PERMISSIONS.CREATOR_READ,
    PERMISSIONS.ACCOUNT_READ,
    PERMISSIONS.METRICS_READ,
    PERMISSIONS.PROJECT_READ,
    PERMISSIONS.PROJECT_WRITE,
    PERMISSIONS.CONTENT_READ,
    PERMISSIONS.CONTENT_WRITE,
    PERMISSIONS.CONTENT_REVIEW,
    PERMISSIONS.CONTENT_PUBLISH,
    PERMISSIONS.AI_RUN,
    PERMISSIONS.AI_FEEDBACK,
    PERMISSIONS.AI_PROMPT_READ,
    PERMISSIONS.DASHBOARD_READ,
  ],

  // 财务：结算与付款 + 合同只读，不能改达人资料与内容
  FINANCE: [
    PERMISSIONS.CREATOR_READ,
    PERMISSIONS.CONTRACT_READ,
    PERMISSIONS.SETTLEMENT_READ,
    PERMISSIONS.SETTLEMENT_GENERATE,
    PERMISSIONS.SETTLEMENT_EDIT,
    PERMISSIONS.SETTLEMENT_APPROVE,
    PERMISSIONS.SETTLEMENT_PAY,
    PERMISSIONS.SETTLEMENT_EXPORT,
    PERMISSIONS.METRICS_READ,
    PERMISSIONS.AI_RUN,
    PERMISSIONS.AI_FEEDBACK,
    PERMISSIONS.DASHBOARD_READ,
  ],

  // 审计：全量只读（含审计日志），任何写操作都被拒绝
  AUDITOR: [...READ_ONLY_PERMISSIONS, PERMISSIONS.AUDIT_READ, PERMISSIONS.DASHBOARD_READ],
};

/** 数据范围：决定 Service 层拼 where 条件时是否追加 owner/team 过滤 */
export const DATA_SCOPE = {
  ALL: 'ALL',
  TEAM: 'TEAM',
  OWN: 'OWN',
} as const;
export type DataScope = (typeof DATA_SCOPE)[keyof typeof DATA_SCOPE];

/** 角色的默认数据范围 */
export const ROLE_DATA_SCOPE: Record<UserRole, DataScope> = {
  SUPER_ADMIN: DATA_SCOPE.ALL,
  OPERATIONS: DATA_SCOPE.ALL,
  BD: DATA_SCOPE.OWN, // 商务只看自己负责的达人与合同，防止互相挖客户
  CONTENT: DATA_SCOPE.ALL,
  FINANCE: DATA_SCOPE.ALL,
  AUDITOR: DATA_SCOPE.ALL,
};

/** 角色中文名，用于前端展示与日志可读性 */
export const ROLE_LABELS: Record<UserRole, string> = {
  SUPER_ADMIN: '系统管理员',
  OPERATIONS: '运营',
  BD: '商务',
  CONTENT: '内容',
  FINANCE: '财务',
  AUDITOR: '审计（只读）',
};

/**
 * 计算用户最终权限集合。
 *
 * overrides 语义：
 *   'creator:write'    → 额外授予
 *   '-creator:export'  → 从角色权限中撤销（最小权限原则下的临时收权）
 * 撤销优先于授予，防止出现「既授又撤」的歧义。
 */
export function resolvePermissions(
  role: UserRole,
  overrides: readonly string[] = [],
): Set<Permission> {
  const granted = new Set<Permission>(ROLE_PERMISSIONS[role] ?? []);
  const revoked = new Set<string>();

  for (const override of overrides) {
    if (override.startsWith('-')) {
      revoked.add(override.slice(1));
      continue;
    }
    if (ALL_PERMISSIONS.includes(override as Permission)) {
      granted.add(override as Permission);
    }
    // 非法权限点静默忽略：清洗应发生在写入侧（UserService 校验），
    // 读取侧若因历史脏数据抛错会导致整个用户无法登录，得不偿失。
  }
  for (const code of revoked) {
    granted.delete(code as Permission);
  }
  return granted;
}

/** 判断权限集合是否包含目标权限 */
export function hasPermission(permissions: ReadonlySet<Permission>, required: Permission): boolean {
  return permissions.has(required);
}

/** 判断是否满足「任一」权限要求（用于列表页：有读权限即可） */
export function hasAnyPermission(
  permissions: ReadonlySet<Permission>,
  required: readonly Permission[],
): boolean {
  return required.some((permission) => permissions.has(permission));
}

/** 判断是否满足「全部」权限要求（用于组合动作：改结算并打款） */
export function hasAllPermissions(
  permissions: ReadonlySet<Permission>,
  required: readonly Permission[],
): boolean {
  return required.every((permission) => permissions.has(permission));
}
