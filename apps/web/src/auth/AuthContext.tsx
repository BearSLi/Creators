import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  abortPendingRefresh,
  ApiError,
  registerAuthHandlers,
  tokenStore,
} from '@/api/client';
import * as authApi from '@/api/auth';
import type { AuthUser, LoginRequest, LoginResponse } from '@/api/types';

/**
 * 登录态。
 *
 * 设计取舍：
 *   - 用 Context 而不是 zustand：登录态只有"当前用户 + 权限集合"两个字段，Context 足够，
 *     少一个依赖也少一层心智负担（zustand 仍在依赖里供后续偏好设置使用）。
 *   - token 由 client.ts 的 tokenStore 负责落盘，这里不复刻一份，避免"两处状态不一致"。
 *   - 刷新 token 的时机在 axios 拦截器里（被动 401 触发），本模块只通过
 *     registerAuthHandlers 接收回调，保持"认证状态"与"HTTP 细节"的边界清晰。
 *
 * 缓存策略：localStorage 里额外存一份 user，用于刷新页面时先渲染出导航骨架，
 * 避免"整页空白等 profile 接口"的观感；profile 回来后以服务端为准覆盖。
 */

const USER_CACHE_KEY = 'creatorops.user';

interface AuthContextValue {
  user: AuthUser | null;
  /** 首次启动校验会话中：此时不应渲染登录页，否则会闪一下 */
  initializing: boolean;
  login: (payload: LoginRequest) => Promise<AuthUser>;
  logout: () => Promise<void>;
  /** 更新本地用户信息（如改密码后、权限被管理员调整后重新拉 profile） */
  refreshProfile: () => Promise<AuthUser | null>;
  hasPermission: (code: string) => boolean;
  hasAnyPermission: (codes: string[]) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function readCachedUser(): AuthUser | null {
  try {
    const raw = window.localStorage.getItem(USER_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthUser;
    // 缓存可能来自旧版本结构，字段校验失败时当作没有缓存，宁可多一次请求
    if (!parsed || typeof parsed.id !== 'string' || !Array.isArray(parsed.permissions)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCachedUser(user: AuthUser | null): void {
  try {
    if (user) window.localStorage.setItem(USER_CACHE_KEY, JSON.stringify(user));
    else window.localStorage.removeItem(USER_CACHE_KEY);
  } catch {
    /* 忽略：无法持久化时退化为内存态 */
  }
}

function toAuthUser(source: {
  id: string;
  email: string;
  name: string;
  role: AuthUser['role'];
  status: AuthUser['status'];
  permissions: string[];
  avatarUrl: string | null;
  teamId?: string | null;
  team?: { id: string } | null;
}): AuthUser {
  return {
    id: source.id,
    email: source.email,
    name: source.name,
    role: source.role,
    status: source.status,
    // profile 返回的是 team 对象，登录返回的是 teamId，归一化成 teamId 字段
    teamId: source.teamId ?? source.team?.id ?? null,
    permissions: source.permissions ?? [],
    avatarUrl: source.avatarUrl ?? null,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<AuthUser | null>(() => readCachedUser());
  const [initializing, setInitializing] = useState(true);

  const applyUser = useCallback((next: AuthUser | null) => {
    setUser(next);
    writeCachedUser(next);
  }, []);

  const clearSession = useCallback(() => {
    tokenStore.clear();
    abortPendingRefresh();
    applyUser(null);
    // 换账号后不能看到上一个账号的缓存数据（达人列表、结算金额），必须整体清空。
    // 注意不要把 clear 放进 setState 的 updater 里：StrictMode 会双调用 updater，
    // 副作用必须留在事件/effect 层，这是 React 的硬性约束。
    queryClient.clear();
  }, [applyUser, queryClient]);

  // 注册拦截器回调：刷新成功 → 同步用户信息；刷新失败 → 清会话并要求重新登录
  useEffect(() => {
    registerAuthHandlers({
      onRefreshed: (payload: LoginResponse) => {
        applyUser(toAuthUser(payload.user));
      },
      onUnauthorized: (reason: string) => {
        clearSession();
        // 这里刻意不走 react-router 的 navigate：会话失效可能发生在路由树之外
        // （例如页面卸载中的请求、ErrorBoundary 内部），window.location 一定能生效。
        // 用 replace 而不是 assign，避免用户回退又回到需要鉴权的页面。
        if (window.location.pathname !== '/login') {
          const target = `/login?reason=${encodeURIComponent(reason || '登录状态已过期，请重新登录')}`;
          window.location.replace(target);
        }
      },
    });
    return () => {
      registerAuthHandlers({});
    };
  }, [applyUser, clearSession]);

  // 启动时校验会话：有 token 就拉 profile，401 说明会话已失效
  useEffect(() => {
    let cancelled = false;

    async function bootstrap(): Promise<void> {
      const hasToken = Boolean(tokenStore.getAccessToken() || tokenStore.getRefreshToken());
      if (!hasToken) {
        if (!cancelled) {
          applyUser(null);
          setInitializing(false);
        }
        return;
      }
      try {
        const profile = await authApi.getProfile();
        if (cancelled) return;
        applyUser(toAuthUser(profile));
      } catch (error) {
        if (cancelled) return;
        // 只有明确的鉴权失败才清会话：网络抖动/后端未启动时清掉登录态会让用户白输一次密码
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          clearSession();
        }
      } finally {
        if (!cancelled) setInitializing(false);
      }
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
    // 仅首次挂载执行：后续用户信息变更由 applyUser 直接写入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = useCallback(
    async (payload: LoginRequest): Promise<AuthUser> => {
      const result = await authApi.login(payload);
      const nextUser = toAuthUser(result.user);
      applyUser(nextUser);
      // 上一个账号可能留下缓存（同一浏览器多人共用场景），登录成功后整体失效
      await queryClient.invalidateQueries();
      return nextUser;
    },
    [applyUser, queryClient],
  );

  const logout = useCallback(async (): Promise<void> => {
    try {
      // 通知后端吊销会话（记录 revoked 数）；失败也要继续清本地，不能让用户"登不出去"
      await authApi.logout();
    } catch {
      /* 忽略：网络异常时本地登出优先 */
    } finally {
      clearSession();
    }
  }, [clearSession]);

  const refreshProfile = useCallback(async (): Promise<AuthUser | null> => {
    try {
      const profile = await authApi.getProfile();
      const nextUser = toAuthUser(profile);
      applyUser(nextUser);
      return nextUser;
    } catch {
      return null;
    }
  }, [applyUser]);

  const hasPermission = useCallback(
    (code: string): boolean => {
      if (!user) return false;
      return user.permissions.includes(code);
    },
    [user],
  );

  const hasAnyPermission = useCallback(
    (codes: string[]): boolean => {
      if (!user || codes.length === 0) return false;
      return codes.some((code) => user.permissions.includes(code));
    },
    [user],
  );

  const value = useMemo<AuthContextValue>(
    () => ({ user, initializing, login, logout, refreshProfile, hasPermission, hasAnyPermission }),
    [user, initializing, login, logout, refreshProfile, hasPermission, hasAnyPermission],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** 业务组件获取登录态的唯一入口 */
export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    // 直接抛错而不是返回默认值：静默降级会让"忘了包 Provider"变成难以定位的空白页面
    throw new Error('useAuth 必须在 <AuthProvider> 内使用');
  }
  return context;
}

export type { AuthContextValue };
