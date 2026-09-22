import { DATA_SCOPE, ROLE_DATA_SCOPE } from '../../modules/auth/permissions';
import type { AuthUser } from '../../modules/auth/auth.types';

/**
 * 数据范围过滤。
 *
 * 功能权限解决「能不能调这个接口」，数据范围解决「能看哪些行」。
 * 商务只看自己负责的达人，若列表接口漏加这层过滤，会造成客户资源互相可见，
 * 属于业务事故而非单纯代码问题，因此把它抽成统一工具强制复用。
 */

export interface ScopeFilter {
  ownerId?: string;
  teamId?: string;
}

/**
 * 生成数据范围过滤条件，直接展开进 Prisma where。
 *
 * @param user 当前登录用户
 * @param options.scope 显式覆盖范围（默认取角色映射）
 * @param options.ownerField 归属字段名，默认 ownerId
 * @param options.teamField 团队字段名，默认 teamId
 * @param options.hasTeamField 目标表是否真的有团队字段。
 *        **这个参数很关键**：不是所有表都同时有 ownerId 与 teamId。
 *        若目标表没有 teamId 却拼进 where，Prisma 会抛
 *        `Unknown argument 'teamId'`，把整个列表接口打成 500，
 *        而不是「多过滤了一些数据」这种温和的失败方式。
 *        传 false 时 TEAM 范围会回落到按 ownerId 收敛（宁可少看，不可越权）。
 */
export function buildScopeFilter(
  user: AuthUser,
  options: {
    scope?: 'ALL' | 'TEAM' | 'OWN';
    ownerField?: string;
    teamField?: string;
    hasTeamField?: boolean;
  } = {},
): Record<string, unknown> {
  const scope = options.scope ?? resolveScope(user);
  const ownerField = options.ownerField ?? 'ownerId';
  const teamField = options.teamField ?? 'teamId';
  const hasTeamField = options.hasTeamField ?? true;

  switch (scope) {
    case DATA_SCOPE.ALL:
      return {};
    case DATA_SCOPE.TEAM:
      // 未归属团队的账号（如新入职待分配）不应看到任何团队数据；
      // 目标表没有团队字段时同样退化为「仅自己」，遵循最小权限原则。
      if (user.teamId && hasTeamField) return { [teamField]: user.teamId };
      return { [ownerField]: user.id };
    case DATA_SCOPE.OWN:
    default:
      return { [ownerField]: user.id };
  }
}

/**
 * 从用户角色推导默认数据范围。
 * 直接读 permissions.ts 的 ROLE_DATA_SCOPE，不在这里维护副本——
 * 之前这里有一份手抄的映射表，与权限模块的矩阵形成「同一事实两个来源」，
 * 改角色范围时必然漂移（`/users/roles` 返回的与这里执行的可能不一致）。
 */
export function resolveScope(user: AuthUser): 'ALL' | 'TEAM' | 'OWN' {
  return ROLE_DATA_SCOPE[user.role] ?? DATA_SCOPE.ALL;
}

/**
 * 资源归属校验（单条记录级）。
 * 用于「详情/编辑/删除」这类必须校验具体某条数据归属的场景。
 *
 * 注意：列表接口做了范围过滤**不等于**详情接口安全。
 * 真实越权路径是「猜到别人的 UUID 后直接访问详情接口」，
 * 所以每个按 ID 操作的入口都必须重新校验。
 */
export function assertOwnership(
  user: AuthUser,
  resource: { ownerId?: string | null; teamId?: string | null },
  options: { scope?: 'ALL' | 'TEAM' | 'OWN'; resourceName?: string } = {},
): void {
  const scope = options.scope ?? resolveScope(user);
  const resourceName = options.resourceName ?? '数据';

  if (scope === 'ALL') return;

  if (scope === 'TEAM') {
    const sameTeam = Boolean(user.teamId) && resource.teamId === user.teamId;
    // 团队范围内，自己创建但未指定团队的数据也应可见
    const own = resource.ownerId === user.id;
    if (!sameTeam && !own) {
      throw new ScopedAccessError(resourceName);
    }
    return;
  }

  if (resource.ownerId !== user.id) {
    throw new ScopedAccessError(resourceName);
  }
}

export class ScopedAccessError extends Error {
  readonly code = 'SCOPE_DENIED';
  constructor(resourceName: string) {
    super(`无权访问该${resourceName}：不在你的数据范围内`);
    this.name = 'ScopedAccessError';
  }
}
