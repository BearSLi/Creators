import type { ReactNode } from 'react';
import { usePermission } from '@/hooks/usePermission';

/**
 * 权限门（Permission Gate）。
 *
 * 用法：包住任何"需要权限才该出现"的 UI。
 *   <PermissionGate permission={P.SETTLEMENT_PAY}>
 *     <Button onClick={pay}>标记打款</Button>
 *   </PermissionGate>
 *
 * 两种降级方式：
 *   - 默认：无权限直接不渲染（后台系统最常见，避免给用户"永远点不动"的按钮）；
 *   - fallback="lock"：渲染一个带锁的占位，用于表格里的敏感列——
 *     用户需要知道"这里有一列数据你没权限看"，直接隐藏反而会让他以为数据缺失。
 */

export interface PermissionGateProps {
  /** 需要某一个权限 */
  permission?: string;
  /** 需要任意一个权限 */
  anyPermission?: string[];
  /** 需要全部权限（复合动作，如"改结算 + 打款"） */
  allPermissions?: string[];
  children: ReactNode;
  /** 无权限时的替代渲染；'lock' 为内置的锁定占位 */
  fallback?: ReactNode | 'lock';
  /** 锁定占位文案 */
  lockText?: string;
}

export function PermissionGate({
  permission,
  anyPermission,
  allPermissions,
  children,
  fallback = null,
  lockText = '无权限查看',
}: PermissionGateProps) {
  const { has, hasAny, hasAll } = usePermission();

  let allowed = true;
  if (permission) allowed = allowed && has(permission);
  if (anyPermission && anyPermission.length > 0) allowed = allowed && hasAny(anyPermission);
  if (allPermissions && allPermissions.length > 0) allowed = allowed && hasAll(allPermissions);

  if (allowed) return <>{children}</>;

  if (fallback === 'lock') {
    return (
      <span
        title={`${lockText}（可联系系统管理员开通权限）`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 'var(--space-1)',
          color: 'var(--color-text-tertiary)',
          fontSize: 'var(--font-size-xs)',
        }}
      >
        <span aria-hidden="true">🔒</span>
        {lockText}
      </span>
    );
  }

  return <>{fallback}</>;
}
