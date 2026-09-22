import { UserRole } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_ONLY_PERMISSIONS,
  ALL_PERMISSIONS,
  DATA_SCOPE,
  hasAllPermissions,
  hasAnyPermission,
  PERMISSION_META,
  PERMISSIONS,
  resolvePermissions,
  ROLE_DATA_SCOPE,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
} from './permissions';
import type { AuthUser } from './auth.types';
import { assertOwnership, buildScopeFilter, ScopedAccessError } from '../../common/utils/scope';

/**
 * 权限模型测试。
 *
 * 权限是安全边界，必须防止三类回归：
 *   1) 新增权限点但忘记配置到任何角色（导致功能「谁都点不了」，或误配给只读角色）；
 *   2) 元数据与权限点不一致（前端渲染勾选框少一项）；
 *   3) 审计角色获得写权限（合规红线）。
 */

/**
 * 仅系统管理员可持有的高敏感权限。
 *
 * 直接复用生产代码里的 ADMIN_ONLY_PERMISSIONS，而不是在测试里再抄一份：
 * 抄一份就会出现「测试认为某权限是管理员专属」与「矩阵里其实没分配给任何人」
 * 两套事实漂移的情况——这份清单最初只列了 system:config，结果
 * creator:delete / contract:terminate / user:write 等 6 项长期处于「定义了但谁都没有」的状态。
 */
const ADMIN_ONLY = ADMIN_ONLY_PERMISSIONS;

describe('权限矩阵完整性', () => {
  it('每个权限点都有中文元数据（前端角色配置页依赖）', () => {
    for (const permission of ALL_PERMISSIONS) {
      expect(PERMISSION_META[permission], `缺少权限元数据：${permission}`).toBeDefined();
      expect(PERMISSION_META[permission].label.length).toBeGreaterThan(0);
      expect(PERMISSION_META[permission].group.length).toBeGreaterThan(0);
    }
  });

  it('每个角色都有权限矩阵与中文名', () => {
    for (const role of Object.values(UserRole)) {
      expect(ROLE_PERMISSIONS[role], `角色 ${role} 缺少权限矩阵`).toBeDefined();
      expect(ROLE_LABELS[role], `角色 ${role} 缺少中文名`).toBeDefined();
      expect(ROLE_DATA_SCOPE[role], `角色 ${role} 缺少数据范围`).toBeDefined();
    }
  });

  it('SUPER_ADMIN 拥有全部权限', () => {
    expect(resolvePermissions('SUPER_ADMIN').size).toBe(ALL_PERMISSIONS.length);
  });

  it('除管理员专属权限外，每个权限点都被业务角色使用（否则说明漏配）', () => {
    const usedByBusinessRoles = new Set<string>();
    for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
      if (role === 'SUPER_ADMIN') continue;
      permissions.forEach((permission) => usedByBusinessRoles.add(permission));
    }
    const unused = ALL_PERMISSIONS.filter(
      (permission) => !usedByBusinessRoles.has(permission) && !ADMIN_ONLY.includes(permission),
    );
    expect(unused, `以下权限点未分配给任何业务角色：${unused.join(', ')}`).toEqual([]);
  });

  it('矩阵中不出现未定义的权限码（防止拼写错误静默失效）', () => {
    for (const [role, permissions] of Object.entries(ROLE_PERMISSIONS)) {
      for (const permission of permissions) {
        expect(ALL_PERMISSIONS, `${role} 中出现未知权限码：${permission}`).toContain(permission);
      }
    }
  });
});

describe('角色边界（安全红线）', () => {
  it('审计角色只能读，不能有任何写/审批/导出类高风险权限', () => {
    const permissions = resolvePermissions('AUDITOR');
    const writeLikePermissions = [...permissions].filter((permission) =>
      /:(write|delete|approve|pay|generate|edit|manage|config|run)/.test(permission),
    );
    expect(writeLikePermissions).toEqual([]);
    expect(permissions.has(PERMISSIONS.AUDIT_READ)).toBe(true);
  });

  it('审计角色不能删除达人、不能审批结算', () => {
    const permissions = resolvePermissions('AUDITOR');
    expect(permissions.has(PERMISSIONS.CREATOR_DELETE)).toBe(false);
    expect(permissions.has(PERMISSIONS.SETTLEMENT_APPROVE)).toBe(false);
    expect(permissions.has(PERMISSIONS.SETTLEMENT_PAY)).toBe(false);
  });

  it('财务有结算审批与打款权限，但不能改达人资料或内容', () => {
    const permissions = resolvePermissions('FINANCE');
    expect(permissions.has(PERMISSIONS.SETTLEMENT_APPROVE)).toBe(true);
    expect(permissions.has(PERMISSIONS.SETTLEMENT_PAY)).toBe(true);
    expect(permissions.has(PERMISSIONS.CREATOR_WRITE)).toBe(false);
    expect(permissions.has(PERMISSIONS.CONTENT_WRITE)).toBe(false);
  });

  it('内容角色不接触合同金额与结算', () => {
    const permissions = resolvePermissions('CONTENT');
    expect(permissions.has(PERMISSIONS.CONTENT_WRITE)).toBe(true);
    expect(permissions.has(PERMISSIONS.CONTRACT_WRITE)).toBe(false);
    expect(permissions.has(PERMISSIONS.CONTRACT_APPROVE)).toBe(false);
    expect(permissions.has(PERMISSIONS.SETTLEMENT_READ)).toBe(false);
  });

  it('运营不能审批结算、不能接管员工管理', () => {
    const permissions = resolvePermissions('OPERATIONS');
    expect(permissions.has(PERMISSIONS.SETTLEMENT_GENERATE)).toBe(true);
    expect(permissions.has(PERMISSIONS.SETTLEMENT_APPROVE)).toBe(false);
    expect(permissions.has(PERMISSIONS.USER_WRITE)).toBe(false);
    expect(permissions.has(PERMISSIONS.ROLE_MANAGE)).toBe(false);
  });

  it('商务不能审批合同（自己拟的合同由他人审）', () => {
    const permissions = resolvePermissions('BD');
    expect(permissions.has(PERMISSIONS.CONTRACT_WRITE)).toBe(true);
    expect(permissions.has(PERMISSIONS.CONTRACT_SUBMIT)).toBe(true);
    expect(permissions.has(PERMISSIONS.CONTRACT_APPROVE)).toBe(false);
  });
});

describe('权限覆盖 (permissionOverrides)', () => {
  it('可以额外授予权限', () => {
    const permissions = resolvePermissions('CONTENT', [PERMISSIONS.SETTLEMENT_READ]);
    expect(permissions.has(PERMISSIONS.SETTLEMENT_READ)).toBe(true);
    expect(permissions.has(PERMISSIONS.CONTENT_WRITE)).toBe(true);
  });

  it('可以用 - 前缀撤销角色权限（最小权限原则下的临时收权）', () => {
    const permissions = resolvePermissions('FINANCE', [`-${PERMISSIONS.SETTLEMENT_PAY}`]);
    expect(permissions.has(PERMISSIONS.SETTLEMENT_PAY)).toBe(false);
    expect(permissions.has(PERMISSIONS.SETTLEMENT_APPROVE)).toBe(true);
  });

  it('撤销优先于授予（同一权限既授又撤时以撤销为准）', () => {
    const permissions = resolvePermissions('OPERATIONS', [
      PERMISSIONS.SETTLEMENT_APPROVE,
      `-${PERMISSIONS.SETTLEMENT_APPROVE}`,
    ]);
    expect(permissions.has(PERMISSIONS.SETTLEMENT_APPROVE)).toBe(false);
  });

  it('忽略非法权限码而不是抛错（避免历史脏数据导致用户无法登录）', () => {
    const permissions = resolvePermissions('CONTENT', ['not:a:permission', '-also:invalid']);
    expect(permissions.has(PERMISSIONS.CONTENT_WRITE)).toBe(true);
    expect([...permissions].every((permission) => ALL_PERMISSIONS.includes(permission))).toBe(true);
  });
});

describe('权限判断辅助函数', () => {
  const permissions = resolvePermissions('OPERATIONS');

  it('hasAnyPermission 任一满足即为真', () => {
    expect(hasAnyPermission(permissions, [PERMISSIONS.SETTLEMENT_APPROVE, PERMISSIONS.CREATOR_READ])).toBe(true);
    expect(hasAnyPermission(permissions, [PERMISSIONS.SETTLEMENT_APPROVE, PERMISSIONS.USER_WRITE])).toBe(false);
  });

  it('hasAllPermissions 需全部满足', () => {
    expect(hasAllPermissions(permissions, [PERMISSIONS.CREATOR_READ, PERMISSIONS.CREATOR_WRITE])).toBe(true);
    expect(hasAllPermissions(permissions, [PERMISSIONS.CREATOR_READ, PERMISSIONS.USER_WRITE])).toBe(false);
  });
});

describe('数据范围 (scope)', () => {
  const buildUser = (role: UserRole, teamId: string | null = 'team-1', id = 'user-1'): AuthUser => ({
    id,
    email: `${role.toLowerCase()}@demo.com`,
    name: role,
    role,
    teamId,
    permissions: resolvePermissions(role),
    sessionId: 'session-1',
  });

  it('商务范围为 OWN，只能看自己负责的数据', () => {
    const filter = buildScopeFilter(buildUser('BD'));
    expect(filter).toEqual({ ownerId: 'user-1' });
  });

  it('运营/财务/审计范围为 ALL，不追加过滤条件', () => {
    expect(buildScopeFilter(buildUser('OPERATIONS'))).toEqual({});
    expect(buildScopeFilter(buildUser('FINANCE'))).toEqual({});
    expect(buildScopeFilter(buildUser('AUDITOR'))).toEqual({});
  });

  it('可显式指定 TEAM 范围与字段名', () => {
    const filter = buildScopeFilter(buildUser('OPERATIONS'), { scope: 'TEAM' });
    expect(filter).toEqual({ teamId: 'team-1' });
  });

  it('TEAM 范围但用户未分配团队时，退化为仅看自己（不能看到全部）', () => {
    const filter = buildScopeFilter(buildUser('OPERATIONS', null), { scope: 'TEAM' });
    expect(filter).toEqual({ ownerId: 'user-1' });
  });

  describe('assertOwnership', () => {
    it('OWN 范围下，仅本人负责的资源可通过', () => {
      const user = buildUser('BD');
      expect(() => assertOwnership(user, { ownerId: 'user-1' })).not.toThrow();
      expect(() => assertOwnership(user, { ownerId: 'user-2' })).toThrowError(ScopedAccessError);
      expect(() => assertOwnership(user, { ownerId: null })).toThrowError(/不在你的数据范围内/);
    });

    it('ALL 范围下不做校验', () => {
      const user = buildUser('OPERATIONS');
      expect(() => assertOwnership(user, { ownerId: 'someone-else' })).not.toThrow();
    });

    it('TEAM 范围下同团队可通过，跨团队被拒', () => {
      const user = buildUser('OPERATIONS');
      expect(() =>
        assertOwnership(user, { teamId: 'team-1', ownerId: 'other' }, { scope: 'TEAM' }),
      ).not.toThrow();
      expect(() =>
        assertOwnership(user, { teamId: 'team-2', ownerId: 'other' }, { scope: 'TEAM' }),
      ).toThrowError(ScopedAccessError);
    });

    it('TEAM 范围下自己创建但未指定团队的数据仍可见', () => {
      const user = buildUser('OPERATIONS');
      expect(() =>
        assertOwnership(user, { teamId: null, ownerId: 'user-1' }, { scope: 'TEAM' }),
      ).not.toThrow();
    });
  });
});

describe('数据范围映射与角色的一致性', () => {
  it('只有商务是 OWN 范围（避免误把运营限制成只看自己）', () => {
    const ownRoles = Object.entries(ROLE_DATA_SCOPE)
      .filter(([, scope]) => scope === DATA_SCOPE.OWN)
      .map(([role]) => role);
    expect(ownRoles).toEqual(['BD']);
  });
});
