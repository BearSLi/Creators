import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { usePermission } from '@/hooks/usePermission';
import { permissionLabel } from '@/utils/permissions';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';

/**
 * 路由守卫。
 *
 * 两种用法：
 *   1) 作为布局包装：<Route element={<ProtectedRoute />}> 包裹子路由（渲染 <Outlet/>）
 *   2) 作为单页包装：<ProtectedRoute permission="audit:read"><AuditLogPage/></ProtectedRoute>
 *
 * 判定顺序：先初始化（避免刷新页面时闪登录页）→ 再登录 → 最后权限。
 * 无权限时不跳登录页而是渲染 403 说明：用户已经登录，跳登录页会让他以为"登录失效"，
 * 反而制造支持成本。
 */

export interface ProtectedRouteProps {
  children?: ReactNode;
  /** 需要的权限码；不传表示"登录即可访问" */
  permission?: string;
  /** 需要任意一个权限（菜单级入口用） */
  anyPermission?: string[];
  /** 需要全部权限（复合动作页用） */
  allPermissions?: string[];
}

function Forbidden({ required }: { required: string[] }) {
  const labels = required.map(permissionLabel).join('、');
  return (
    <div className="page">
      <div className="card">
        <div className="cardBody" style={{ padding: 'var(--space-10)', textAlign: 'center' }}>
          <div style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 600 }}>403</div>
          <p style={{ marginTop: 'var(--space-2)', color: 'var(--color-text-secondary)' }}>
            你没有访问该页面的权限
            {labels ? `（需要：${labels}）` : ''}，可联系系统管理员为你开通。
          </p>
        </div>
      </div>
    </div>
  );
}

export function ProtectedRoute({
  children,
  permission,
  anyPermission,
  allPermissions,
}: ProtectedRouteProps) {
  const { user, initializing } = useAuth();
  const { has, hasAny, hasAll } = usePermission();
  const location = useLocation();

  // 会话校验中：渲染骨架而不是跳转，否则每次刷新都会闪一下登录页
  if (initializing) {
    return (
      <div className="page">
        <LoadingSkeleton rows={6} />
      </div>
    );
  }

  if (!user) {
    // 记录来源路径，登录成功后可以回到用户原本想去的页面
    const redirect = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?redirect=${encodeURIComponent(redirect)}`} replace />;
  }

  const required: string[] = [];
  let allowed = true;

  if (permission) {
    required.push(permission);
    allowed = allowed && has(permission);
  }
  if (anyPermission && anyPermission.length > 0) {
    required.push(...anyPermission);
    allowed = allowed && hasAny(anyPermission);
  }
  if (allPermissions && allPermissions.length > 0) {
    required.push(...allPermissions);
    allowed = allowed && hasAll(allPermissions);
  }

  if (!allowed) {
    return <Forbidden required={required} />;
  }

  return <>{children ?? <Outlet />}</>;
}
