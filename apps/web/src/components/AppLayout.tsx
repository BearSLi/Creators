import { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import styles from './AppLayout.module.css';
import { useAuth } from '@/auth/AuthContext';
import { usePermission } from '@/hooks/usePermission';
import { useToast, AUDIT_WRITTEN_HINT } from './Toast';
import { P } from '@/utils/permissions';
import { NOTIFICATION_TYPE_LABELS, ROLE_LABELS } from '@/utils/constants';
import { getDashboardOverview } from '@/api/dashboard';
import type { NotificationType } from '@/api/types';
import { useQuery } from '@tanstack/react-query';

/**
 * 后台主框架：左侧导航 + 顶栏 + 内容区。
 *
 * 导航项由权限驱动（拿不到读权限的模块直接不渲染）。
 * 为什么"隐藏"而不是"进页面再 403"：真实使用中运营/财务/内容各自只用一个模块，
 * 满屏入口但他们点进去全被拒，会直接产生"系统坏了"的工单。
 *
 * 徽标（待处理数）从看板聚合接口取，复用 react-query 缓存，
 * 因此切页面时不会重复请求；没有 dashboard:read 权限的用户则不请求。
 */

interface NavItem {
  to: string;
  label: string;
  icon: string;
  /** 任一个权限命中即可见 */
  anyPermission?: string[];
  /**
   * 徽标来源：看板 `pendingTodos[].type`，取值是后端的 NotificationType。
   * 类型写死成 NotificationType 而不是 string —— 之前是 string，
   * 所以下面三个键全是编的也能通过编译，结果是红点永远不显示。
   */
  badgeType?: NotificationType;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    title: '经营',
    items: [{ to: '/dashboard', label: '经营看板', icon: '📊', anyPermission: [P.DASHBOARD_READ] }],
  },
  {
    title: '达人',
    items: [
      { to: '/creators', label: '达人库', icon: '👤', anyPermission: [P.CREATOR_READ] },
      { to: '/tags', label: '标签管理', icon: '🏷️', anyPermission: [P.CREATOR_READ] },
    ],
  },
  {
    title: '商务',
    items: [
      { to: '/brands', label: '品牌客户', icon: '🏢', anyPermission: [P.BRAND_READ] },
      {
        to: '/contracts',
        label: '合同管理',
        icon: '📄',
        anyPermission: [P.CONTRACT_READ],
        badgeType: 'CONTRACT_EXPIRING',
      },
    ],
  },
  {
    title: '交付',
    items: [
      { to: '/projects', label: '项目管理', icon: '📁', anyPermission: [P.PROJECT_READ] },
      {
        to: '/contents',
        label: '内容排期',
        icon: '🎬',
        anyPermission: [P.CONTENT_READ],
        badgeType: 'CONTENT_REVIEW',
      },
    ],
  },
  {
    title: '财务',
    items: [
      {
        to: '/settlements',
        label: '结算管理',
        icon: '💰',
        anyPermission: [P.SETTLEMENT_READ],
        badgeType: 'SETTLEMENT_DUE',
      },
    ],
  },
  {
    title: '智能',
    items: [
      { to: '/ai/workbench', label: 'AI 工作台', icon: '✨', anyPermission: [P.AI_RUN] },
      { to: '/ai/prompts', label: 'Prompt 模板', icon: '🧩', anyPermission: [P.AI_PROMPT_READ] },
    ],
  },
  {
    title: '系统',
    items: [
      { to: '/system/users', label: '员工与角色', icon: '🧑‍💼', anyPermission: [P.USER_READ] },
      { to: '/system/audit-logs', label: '审计日志', icon: '📜', anyPermission: [P.AUDIT_READ] },
    ],
  },
];

/** 面包屑：路由段 → 中文名。放静态表而不是逐页声明，避免 20 个页面各写一遍 */
const BREADCRUMB_LABELS: Record<string, string> = {
  dashboard: '经营看板',
  creators: '达人库',
  contracts: '合同管理',
  projects: '项目管理',
  contents: '内容排期',
  settlements: '结算管理',
  ai: '智能工具',
  workbench: 'AI 工作台',
  prompts: 'Prompt 模板',
  system: '系统管理',
  users: '员工与角色',
  'audit-logs': '审计日志',
  tags: '标签管理',
  brands: '品牌客户',
  new: '新建',
  edit: '编辑',
};

export function AppLayout() {
  const { user, logout } = useAuth();
  const { hasAny, has } = usePermission();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();

  const [collapsed, setCollapsed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // 待处理徽标：有看板权限才请求，否则省一次无意义的鉴权失败
  const canReadDashboard = has(P.DASHBOARD_READ);
  const { data: overview } = useQuery({
    queryKey: ['dashboard', 'overview', 'badge'],
    queryFn: () => getDashboardOverview({}),
    enabled: canReadDashboard,
    staleTime: 60_000,
  });

  const badgeMap = useMemo(() => {
    const map = new Map<string, number>();
    overview?.pendingTodos?.forEach((todo) => map.set(todo.type, todo.count));
    return map;
  }, [overview]);

  // 点击外部关闭用户菜单：这是下拉菜单的基本预期，缺少会显得很"生硬"
  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [menuOpen]);

  // 路由变化时收起菜单，避免切页后菜单还挂在屏幕上
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  const groups = useMemo(
    () =>
      NAV_GROUPS.map((group) => ({
        ...group,
        items: group.items.filter((item) => !item.anyPermission || hasAny(item.anyPermission)),
      })).filter((group) => group.items.length > 0),
    [hasAny],
  );

  const breadcrumb = useMemo(() => {
    const segments = location.pathname.split('/').filter(Boolean);
    // 累积路径：/creators/new 的"新建"应链接到 /creators 而不是 /new
    let accumulated = '';
    const items = segments.map((segment) => {
      accumulated += `/${segment}`;
      const known = Boolean(BREADCRUMB_LABELS[segment]);
      return {
        key: `${segment}-${accumulated}`,
        label: BREADCRUMB_LABELS[segment] ?? (segment.length > 12 ? `${segment.slice(0, 8)}…` : segment),
        // 只有已知的模块段可点击（UUID / 动态段点了没有意义）
        to: known ? accumulated : null,
      };
    });
    return items;
  }, [location.pathname]);

  const handleLogout = async () => {
    await logout();
    toast.success('已安全退出登录');
    navigate('/login', { replace: true });
  };

  const roleLabel = user ? ROLE_LABELS[user.role] : '';

  return (
    <div className={styles.layout}>
      <aside className={`${styles.sidebar} ${collapsed ? styles.sidebarCollapsed : ''}`}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>C</span>
          <span className={styles.brandText}>
            <span className={styles.brandTitle}>CreatorOps</span>
            <span className={styles.brandSub}>达人合作管理平台</span>
          </span>
        </div>

        <nav className={styles.nav}>
          {groups.map((group) => (
            <div key={group.title}>
              <div className={styles.navGroupTitle}>{group.title}</div>
              {group.items.map((item) => {
                const badge = item.badgeType ? badgeMap.get(item.badgeType) : undefined;
                // 徽标数字本身不带语义，悬停时补一句「待处理的是什么」，否则用户只看到一个红点
                const badgeHint = item.badgeType
                  ? `${NOTIFICATION_TYPE_LABELS[item.badgeType]}：${badge ?? 0}`
                  : null;
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={({ isActive }) =>
                      `${styles.navItem} ${isActive ? styles.navItemActive : ''}`
                    }
                    title={badgeHint ? `${item.label}（${badgeHint}）` : item.label}
                  >
                    <span className={styles.navIcon} aria-hidden="true">
                      {item.icon}
                    </span>
                    <span className={styles.navLabel}>{item.label}</span>
                    {badge ? <span className={styles.navBadge}>{badge > 99 ? '99+' : badge}</span> : null}
                  </NavLink>
                );
              })}
            </div>
          ))}
        </nav>

        <div className={styles.sidebarFooter}>
          <button
            type="button"
            className={styles.collapseButton}
            onClick={() => setCollapsed((prev) => !prev)}
          >
            {collapsed ? '»' : '« 收起侧栏'}
          </button>
        </div>
      </aside>

      <div className={`${styles.main} ${collapsed ? styles.mainCollapsed : ''}`}>
        <header className={styles.header}>
          <nav className={styles.breadcrumb} aria-label="面包屑">
            {breadcrumb.map((item, index) => (
              <span key={item.key} className="row">
                {index > 0 && <span className={styles.breadcrumbSep}>/</span>}
                {item.to ? (
                  <NavLink className={styles.breadcrumbItem} to={item.to}>
                    {item.label}
                  </NavLink>
                ) : (
                  <span className={styles.breadcrumbItem}>{item.label}</span>
                )}
              </span>
            ))}
          </nav>

          <div className={styles.headerSpacer} />

          <div className={styles.headerActions}>
            <div className={styles.userMenuWrap} ref={menuRef}>
              <button
                type="button"
                className={styles.userButton}
                onClick={() => setMenuOpen((prev) => !prev)}
                aria-expanded={menuOpen}
                aria-haspopup="menu"
              >
                <span className={styles.avatar}>
                  {user?.avatarUrl ? (
                    <img src={user.avatarUrl} alt="" />
                  ) : (
                    (user?.name ?? '?').slice(0, 1)
                  )}
                </span>
                <span className={styles.userMeta}>
                  <span className={styles.userName}>{user?.name}</span>
                  <span className={styles.userRole}>{roleLabel}</span>
                </span>
                <span aria-hidden="true" className="subtle">
                  ▾
                </span>
              </button>

              {menuOpen && (
                <div className={styles.dropdown} role="menu">
                  <div className={styles.dropdownInfo}>
                    <div className={styles.dropdownInfoMain}>{user?.name}</div>
                    <div className={styles.dropdownInfoSub}>{user?.email}</div>
                  </div>
                  <button
                    type="button"
                    className={styles.dropdownItem}
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      toast.info(`当前共有 ${user?.permissions.length ?? 0} 个权限点，可联系管理员调整`);
                    }}
                  >
                    <span aria-hidden="true">🔑</span> 我的权限（{user?.permissions.length ?? 0}）
                  </button>
                  <button
                    type="button"
                    className={styles.dropdownItem}
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      navigate('/ai/workbench');
                    }}
                  >
                    <span aria-hidden="true">✨</span> AI 工作台
                  </button>
                  <button
                    type="button"
                    className={`${styles.dropdownItem} ${styles.dropdownItemDanger}`}
                    role="menuitem"
                    onClick={handleLogout}
                  >
                    <span aria-hidden="true">⎋</span> 退出登录
                  </button>
                  <div className="hint" style={{ padding: 'var(--space-2) var(--space-3)' }}>
                    登出与资料变更均写入审计日志（{AUDIT_WRITTEN_HINT.slice(0, 2)}…）
                  </div>
                </div>
              )}
            </div>
          </div>
        </header>

        <main className={styles.content}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
