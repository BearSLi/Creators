import { Suspense, lazy, useState, type ReactNode } from 'react';
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
} from 'react-router-dom';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/auth/AuthContext';
import { ProtectedRoute } from '@/auth/ProtectedRoute';
import { AppLayout } from '@/components/AppLayout';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';
import { ToastProvider, useToast } from '@/components/Toast';
import { resolveErrorMessage } from '@/api/client';

/**
 * 路由表与全局 Provider 装配。
 *
 * 三个刻意的设计：
 *   1) 页面全部 lazy：后台系统首屏只需要登录页/看板，把 20+ 业务页拆成独立 chunk，
 *      首屏体积与登录耗时都会明显下降；
 *   2) QueryCache/MutationCache 只对**写操作**做全局错误 toast——
 *      查询错误由页面渲染三态中的错误态（带重试按钮）承接，
 *      全局再弹一次会变成"错误提示满天飞"；
 *   3) ProtectedRoute 逐页声明所需权限，路由层即权限边界，
 *      不需要在每个页面内部再写一次"没权限就返回占位"。
 */

/* ---------------- 页面（懒加载） ---------------- */

const LoginPage = lazy(() => import('@/pages/LoginPage'));
const DashboardPage = lazy(() => import('@/pages/DashboardPage'));
const NotFoundPage = lazy(() => import('@/pages/NotFoundPage'));

const CreatorListPage = lazy(() => import('@/pages/creator/CreatorListPage'));
const CreatorDetailPage = lazy(() => import('@/pages/creator/CreatorDetailPage'));
const CreatorFormPage = lazy(() => import('@/pages/creator/CreatorFormPage'));

const ContractListPage = lazy(() => import('@/pages/contract/ContractListPage'));
const ContractDetailPage = lazy(() => import('@/pages/contract/ContractDetailPage'));
const ContractFormPage = lazy(() => import('@/pages/contract/ContractFormPage'));

const ProjectListPage = lazy(() => import('@/pages/project/ProjectListPage'));
const ProjectDetailPage = lazy(() => import('@/pages/project/ProjectDetailPage'));
const ContentListPage = lazy(() => import('@/pages/project/ContentListPage'));
const ContentDetailPage = lazy(() => import('@/pages/project/ContentDetailPage'));

const SettlementListPage = lazy(() => import('@/pages/settlement/SettlementListPage'));
const SettlementDetailPage = lazy(() => import('@/pages/settlement/SettlementDetailPage'));

const AiWorkbenchPage = lazy(() => import('@/pages/ai/AiWorkbenchPage'));
const PromptTemplatePage = lazy(() => import('@/pages/ai/PromptTemplatePage'));

const UserListPage = lazy(() => import('@/pages/system/UserListPage'));
const AuditLogPage = lazy(() => import('@/pages/system/AuditLogPage'));
const TagManagePage = lazy(() => import('@/pages/system/TagManagePage'));
const BrandListPage = lazy(() => import('@/pages/system/BrandListPage'));

/* ---------------- Provider 装配 ---------------- */

/** 页面 chunk 加载中的占位：保持与列表页一致的骨架，切换路由不闪白 */
function RouteFallback() {
  return (
    <div className="page">
      <LoadingSkeleton rows={8} columns={6} />
    </div>
  );
}

/** Provider 装配点：新增全局 Provider（主题、国际化）时只改这里一处 */
function AppProviders({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

/** 把 toast 接进 QueryClient：写操作失败统一提示中文原因（后端 code 已映射） */
function AppShell() {
  const toast = useToast();
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // 后台数据变更频率中等：1 分钟内复用缓存，避免来回切页把后端打满
            staleTime: 30_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
            // 只重试一次：权限/状态类错误重试没有意义，反而让用户多等 1 秒
            retry: 1,
            retryDelay: 800,
          },
          mutations: {
            retry: 0,
          },
        },
        queryCache: new QueryCache(),
        mutationCache: new MutationCache({
          onError: (error) => {
            toast.error(resolveErrorMessage(error));
          },
        }),
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <ErrorBoundary>
            <Suspense fallback={<RouteFallback />}>
              <Routes>
                {/* 公共路由：登录页 */}
                <Route path="/login" element={<LoginPage />} />

                {/* 受保护区域：登录守卫 + 主框架 */}
                <Route element={<ProtectedRoute />}>
                  <Route element={<AppLayout />}>
                    <Route path="/" element={<Navigate to="/dashboard" replace />} />
                    <Route
                      path="/dashboard"
                      element={
                        <ProtectedRoute permission="dashboard:read">
                          <DashboardPage />
                        </ProtectedRoute>
                      }
                    />

                    {/* 达人 */}
                    <Route
                      path="/creators"
                      element={
                        <ProtectedRoute permission="creator:read">
                          <CreatorListPage />
                        </ProtectedRoute>
                      }
                    />
                    <Route
                      path="/creators/new"
                      element={
                        <ProtectedRoute permission="creator:write">
                          <CreatorFormPage />
                        </ProtectedRoute>
                      }
                    />
                    <Route
                      path="/creators/:id"
                      element={
                        <ProtectedRoute permission="creator:read">
                          <CreatorDetailPage />
                        </ProtectedRoute>
                      }
                    />
                    <Route
                      path="/creators/:id/edit"
                      element={
                        <ProtectedRoute permission="creator:write">
                          <CreatorFormPage />
                        </ProtectedRoute>
                      }
                    />

                    {/* 合同 */}
                    <Route
                      path="/contracts"
                      element={
                        <ProtectedRoute permission="contract:read">
                          <ContractListPage />
                        </ProtectedRoute>
                      }
                    />
                    <Route
                      path="/contracts/new"
                      element={
                        <ProtectedRoute permission="contract:write">
                          <ContractFormPage />
                        </ProtectedRoute>
                      }
                    />
                    <Route
                      path="/contracts/:id"
                      element={
                        <ProtectedRoute permission="contract:read">
                          <ContractDetailPage />
                        </ProtectedRoute>
                      }
                    />
                    <Route
                      path="/contracts/:id/edit"
                      element={
                        <ProtectedRoute permission="contract:write">
                          <ContractFormPage />
                        </ProtectedRoute>
                      }
                    />

                    {/* 项目与内容 */}
                    <Route
                      path="/projects"
                      element={
                        <ProtectedRoute permission="project:read">
                          <ProjectListPage />
                        </ProtectedRoute>
                      }
                    />
                    <Route
                      path="/projects/:id"
                      element={
                        <ProtectedRoute permission="project:read">
                          <ProjectDetailPage />
                        </ProtectedRoute>
                      }
                    />
                    <Route
                      path="/contents"
                      element={
                        <ProtectedRoute permission="content:read">
                          <ContentListPage />
                        </ProtectedRoute>
                      }
                    />
                    <Route
                      path="/contents/:id"
                      element={
                        <ProtectedRoute permission="content:read">
                          <ContentDetailPage />
                        </ProtectedRoute>
                      }
                    />

                    {/* 结算 */}
                    <Route
                      path="/settlements"
                      element={
                        <ProtectedRoute permission="settlement:read">
                          <SettlementListPage />
                        </ProtectedRoute>
                      }
                    />
                    <Route
                      path="/settlements/:id"
                      element={
                        <ProtectedRoute permission="settlement:read">
                          <SettlementDetailPage />
                        </ProtectedRoute>
                      }
                    />

                    {/* AI */}
                    <Route
                      path="/ai/workbench"
                      element={
                        <ProtectedRoute permission="ai:run">
                          <AiWorkbenchPage />
                        </ProtectedRoute>
                      }
                    />
                    <Route
                      path="/ai/prompts"
                      element={
                        <ProtectedRoute permission="ai:prompt:read">
                          <PromptTemplatePage />
                        </ProtectedRoute>
                      }
                    />

                    {/* 系统 */}
                    <Route
                      path="/system/users"
                      element={
                        <ProtectedRoute permission="user:read">
                          <UserListPage />
                        </ProtectedRoute>
                      }
                    />
                    <Route
                      path="/system/audit-logs"
                      element={
                        <ProtectedRoute permission="audit:read">
                          <AuditLogPage />
                        </ProtectedRoute>
                      }
                    />
                    <Route
                      path="/tags"
                      element={
                        <ProtectedRoute permission="creator:read">
                          <TagManagePage />
                        </ProtectedRoute>
                      }
                    />
                    <Route
                      path="/brands"
                      element={
                        <ProtectedRoute permission="brand:read">
                          <BrandListPage />
                        </ProtectedRoute>
                      }
                    />

                    {/* 404 放在布局内：用户还能看到导航，自己走出错误页 */}
                    <Route path="*" element={<NotFoundPage />} />
                  </Route>
                </Route>

                {/* 未登录时访问任意未知路径：交给登录守卫处理 */}
                <Route path="*" element={<Navigate to="/login" replace />} />
              </Routes>
            </Suspense>
          </ErrorBoundary>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default function App() {
  return (
    <AppProviders>
      <ErrorBoundary>
        <ToastProvider>
          <AppShell />
        </ToastProvider>
      </ErrorBoundary>
    </AppProviders>
  );
}
