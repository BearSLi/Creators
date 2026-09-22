import { useAuth } from '@/auth/AuthContext';
import type { PermissionCode } from '@/utils/permissions';

/**
 * 权限判断 Hook。
 *
 * 三个方法覆盖了后台系统的全部权限场景：
 *   has      —— 单个按钮（审批、打款）
 *   hasAny   —— 菜单项（有任一读权限即可进入）
 *   hasAll   —— 复合动作（改结算并打款，缺一不可）
 *
 * 只返回布尔值，不负责渲染；渲染请用 <PermissionGate>。
 */
export function usePermission() {
  const { user, hasPermission } = useAuth();

  const has = (code: PermissionCode | string): boolean => hasPermission(code);

  const hasAny = (codes: Array<PermissionCode | string>): boolean =>
    codes.length > 0 && codes.some((code) => hasPermission(code));

  const hasAll = (codes: Array<PermissionCode | string>): boolean =>
    codes.length > 0 && codes.every((code) => hasPermission(code));

  return {
    has,
    hasAny,
    hasAll,
    permissions: user?.permissions ?? [],
    role: user?.role ?? null,
  };
}
