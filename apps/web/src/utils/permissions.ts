/**
 * 权限码常量。
 *
 * 必须与后端 apps/api/src/modules/auth/permissions.ts 的 PERMISSIONS 完全一致。
 * 前端用它的唯一目的是"决定要不要渲染某个入口/按钮"，真正的拦截在后端——
 * 前端隐藏按钮是体验优化（避免用户点了才被拒），不是安全边界。
 */

export const P = {
  CREATOR_READ: 'creator:read',
  CREATOR_WRITE: 'creator:write',
  CREATOR_DELETE: 'creator:delete',
  CREATOR_EXPORT: 'creator:export',
  CREATOR_SENSITIVE_READ: 'creator:sensitive:read',
  CREATOR_ASSIGN: 'creator:assign',

  ACCOUNT_READ: 'account:read',
  ACCOUNT_WRITE: 'account:write',
  METRICS_SYNC: 'metrics:sync',
  METRICS_READ: 'metrics:read',

  BRAND_READ: 'brand:read',
  BRAND_WRITE: 'brand:write',

  CONTRACT_READ: 'contract:read',
  CONTRACT_WRITE: 'contract:write',
  CONTRACT_SUBMIT: 'contract:submit',
  CONTRACT_APPROVE: 'contract:approve',
  CONTRACT_TERMINATE: 'contract:terminate',

  PROJECT_READ: 'project:read',
  PROJECT_WRITE: 'project:write',
  CONTENT_READ: 'content:read',
  CONTENT_WRITE: 'content:write',
  CONTENT_REVIEW: 'content:review',
  CONTENT_PUBLISH: 'content:publish',

  SETTLEMENT_READ: 'settlement:read',
  SETTLEMENT_GENERATE: 'settlement:generate',
  SETTLEMENT_EDIT: 'settlement:edit',
  SETTLEMENT_APPROVE: 'settlement:approve',
  SETTLEMENT_PAY: 'settlement:pay',
  SETTLEMENT_EXPORT: 'settlement:export',

  AI_RUN: 'ai:run',
  AI_FEEDBACK: 'ai:feedback',
  AI_PROMPT_READ: 'ai:prompt:read',
  AI_PROMPT_WRITE: 'ai:prompt:write',

  USER_READ: 'user:read',
  USER_WRITE: 'user:write',
  ROLE_MANAGE: 'role:manage',
  AUDIT_READ: 'audit:read',
  DASHBOARD_READ: 'dashboard:read',
  SYSTEM_CONFIG: 'system:config',
} as const;

export type PermissionCode = (typeof P)[keyof typeof P];

/** 权限码中文名：用于「无权限」提示与权限勾选框，与后端 PERMISSION_META 对齐 */
export const PERMISSION_LABELS: Record<string, string> = {
  'creator:read': '查看达人',
  'creator:write': '新建/编辑达人',
  'creator:delete': '删除达人',
  'creator:export': '导出达人数据',
  'creator:sensitive:read': '查看敏感信息',
  'creator:assign': '分配负责人',
  'account:read': '查看平台账号',
  'account:write': '维护平台账号',
  'metrics:sync': '触发数据采集',
  'metrics:read': '查看数据看板',
  'brand:read': '查看品牌',
  'brand:write': '维护品牌',
  'contract:read': '查看合同',
  'contract:write': '拟定合同',
  'contract:submit': '提交合同审核',
  'contract:approve': '审批合同',
  'contract:terminate': '解约/终止合同',
  'project:read': '查看项目',
  'project:write': '维护项目',
  'content:read': '查看内容',
  'content:write': '维护内容',
  'content:review': '内容审核',
  'content:publish': '发布/下线内容',
  'settlement:read': '查看结算单',
  'settlement:generate': '生成结算单',
  'settlement:edit': '调整结算明细',
  'settlement:approve': '审批结算单',
  'settlement:pay': '标记打款',
  'settlement:export': '导出结算表',
  'ai:run': '使用 AI 能力',
  'ai:feedback': '提交 AI 反馈',
  'ai:prompt:read': '查看 Prompt 模板',
  'ai:prompt:write': '维护 Prompt 模板',
  'user:read': '查看员工',
  'user:write': '维护员工',
  'role:manage': '分配角色与权限',
  'audit:read': '查看审计日志',
  'dashboard:read': '查看经营看板',
  'system:config': '系统配置',
};

export function permissionLabel(code: string): string {
  return PERMISSION_LABELS[code] ?? code;
}

/**
 * 权限覆盖（permissionOverrides）的展示转换。
 * 后端语义：'creator:write' 表示额外授予，'-creator:export' 表示从角色权限中撤销。
 * UI 上把两者分开呈现，避免用户把撤销项误读成勾选项。
 */
export interface PermissionOverrideView {
  grant: string[];
  revoke: string[];
}

export function splitPermissionOverrides(overrides: readonly string[]): PermissionOverrideView {
  const grant: string[] = [];
  const revoke: string[] = [];
  for (const item of overrides) {
    if (item.startsWith('-')) revoke.push(item.slice(1));
    else grant.push(item);
  }
  return { grant, revoke };
}

/** 与 splitPermissionOverrides 互逆，保存前调用 */
export function joinPermissionOverrides(view: PermissionOverrideView): string[] {
  return [...view.grant, ...view.revoke.map((code) => `-${code}`)];
}
