import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createUser,
  getPermissionCatalog,
  getRoles,
  listUsers,
  resetUserPassword,
  updateUser,
  updateUserPermissions,
  updateUserStatus,
} from '@/api/users';
import { resolveErrorMessage } from '@/api/client';
import type {
  CreateUserRequest,
  UpdateUserRequest,
  UserListItem,
  UserPermissionCatalogItem,
  UserRole,
  UserStatus,
} from '@/api/types';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DataTable, type Column } from '@/components/DataTable';
import { Drawer } from '@/components/Drawer';
import { ErrorState } from '@/components/EmptyState';
import { FilterBar } from '@/components/FilterBar';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';
import { Modal } from '@/components/Modal';
import { PageHeader } from '@/components/PageHeader';
import { PermissionGate } from '@/components/PermissionGate';
import { StatusTag, type StatusTone } from '@/components/StatusTag';
import { AUDIT_WRITTEN_HINT, useToast } from '@/components/Toast';
import { useTableQuery } from '@/hooks/useTableQuery';
import {
  EMAIL_PATTERN,
  PHONE_PATTERN,
  ROLE_LABELS,
  ROLE_OPTIONS,
  USER_STATUS_LABELS,
  USER_STATUS_OPTIONS,
  USER_STATUS_TONES,
} from '@/utils/constants';
import { formatDateTime } from '@/utils/format';
import { P, joinPermissionOverrides, permissionLabel } from '@/utils/permissions';

/**
 * 员工与角色。
 *
 * 三条与"账号安全"直接相关的业务约束：
 *   1) 初始密码/重置密码后端**只返回一次**明文，页面必须当场用弹窗展示并引导复制，
 *      关掉就永远看不到了（这是唯一一次分发凭据的机会）；
 *   2) 停用会立即吊销会话：不写清这一点，被停用的人会以为是系统故障而反复重试登录；
 *   3) 权限覆盖（override）是在角色基础上的增量，UI 必须同时呈现"角色默认"这条基线，
 *      否则管理员看到空勾选框会以为员工什么权限都没有，进而重复授予。
 */

type UserFilters = {
  keyword: string;
  role: string;
  status: string;
};

interface UserFormValues {
  email: string;
  name: string;
  role: UserRole | '';
  phone: string;
  teamId: string;
  password: string;
}

const EMPTY_USER_FORM: UserFormValues = {
  email: '',
  name: '',
  role: '',
  phone: '',
  teamId: '',
  password: '',
};

/** 权限覆盖的三种状态：继承角色 / 额外授予 / 从角色中撤销 */
type OverrideMode = 'inherit' | 'grant' | 'revoke';

/** dataScope 只有三种取值，后端契约固定，页面内联映射即可，不必污染 constants */
const DATA_SCOPE_LABELS: Record<string, string> = {
  ALL: '全部数据',
  TEAM: '本团队数据',
  OWN: '仅本人负责',
};

const RISK_TONES: Record<UserPermissionCatalogItem['risk'], StatusTone> = {
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
};

const RISK_LABELS: Record<UserPermissionCatalogItem['risk'], string> = {
  high: '高风险',
  medium: '中风险',
  low: '低风险',
};

function validateUserForm(form: UserFormValues, isCreate: boolean): string | null {
  if (form.name.trim() === '') return '姓名必填';
  if (form.email.trim() === '') return '邮箱必填，它是登录账号';
  if (!EMAIL_PATTERN.test(form.email.trim())) return '邮箱格式不正确';
  if (form.role === '') return '角色必填：角色决定了员工的基础权限与数据范围';
  if (form.phone.trim() !== '' && !PHONE_PATTERN.test(form.phone.trim())) {
    return '手机号格式不正确（需为 11 位大陆手机号）';
  }
  if (isCreate && form.password.trim() !== '' && form.password.trim().length < 8) {
    return '自定义密码至少 8 位，或留空由后端生成一次性初始密码';
  }
  return null;
}

export default function UserListPage() {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [userFormOpen, setUserFormOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<UserListItem | null>(null);
  const [userForm, setUserForm] = useState<UserFormValues>(EMPTY_USER_FORM);
  const [userFormError, setUserFormError] = useState<string | null>(null);

  // 一次性凭据：新建员工与重置密码共用同一个展示弹窗
  const [credential, setCredential] = useState<{ name: string; password: string } | null>(null);
  const [resetTarget, setResetTarget] = useState<UserListItem | null>(null);
  const [statusTarget, setStatusTarget] = useState<{ user: UserListItem; next: UserStatus } | null>(
    null,
  );

  const [permissionTarget, setPermissionTarget] = useState<UserListItem | null>(null);
  /**
   * 本地维护的权限覆盖。
   * 为什么从空数组开始：listUsers 的返回里没有 overrides 字段（后端只在 permission 接口回写），
   * 页面不能假装有这个字段——否则会把"角色默认权限"错当成"已有覆盖"再提交一次，
   * 造成看起来一样的配置却写了一条多余的 override。
   * 角色默认权限通过 getRoles() 单独拉取，只作为参考基线展示。
   */
  const [overrides, setOverrides] = useState<{ grant: string[]; revoke: string[] }>({
    grant: [],
    revoke: [],
  });
  const [expandedRole, setExpandedRole] = useState<UserRole | null>(null);
  // FilterBar 的关键词框是非受控 + 防抖实现，重置筛选时靠重挂载清掉输入框里的残留文本
  const [filterResetKey, setFilterResetKey] = useState(0);

  /* ---------------- 列表 ---------------- */

  const table = useTableQuery<UserFilters>({
    initialFilters: { keyword: '', role: '', status: '' },
    initialPageSize: 20,
    initialSort: { sortBy: 'createdAt', sortOrder: 'desc' },
  });
  // 筛选值单独取：query 里已把 filters 拍平（含分页与排序），回填控件仍用原始的 filters 更直观
  const filters = table.filters;

  const listQuery = useQuery({
    queryKey: ['users', 'list', table.query],
    queryFn: () =>
      listUsers({
        page: table.query.page,
        pageSize: table.query.pageSize,
        sortBy: table.query.sortBy,
        sortOrder: table.query.sortOrder,
        keyword: filters.keyword,
        // FilterBar 的 select 只给字符串（未选为 ''），这里收窄回枚举；
        // 空串会被 listUsers 内部的 buildParams 丢掉，不会把非法枚举发给后端
        role: filters.role === '' ? undefined : (filters.role as UserRole),
        status: filters.status === '' ? undefined : (filters.status as UserStatus),
      }),
    placeholderData: keepPreviousData,
  });

  const catalogQuery = useQuery({
    queryKey: ['users', 'permission-catalog'],
    queryFn: () => getPermissionCatalog(),
  });

  const rolesQuery = useQuery({
    queryKey: ['users', 'roles'],
    queryFn: () => getRoles(),
  });

  /* ---------------- 写操作 ---------------- */

  const createMutation = useMutation({
    mutationFn: (body: CreateUserRequest) => createUser(body),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setUserFormOpen(false);
      setUserForm(EMPTY_USER_FORM);
      // 初始密码只出现这一次，必须立刻弹窗让管理员复制
      setCredential({ name: created.name, password: created.initialPassword });
      toast.success(`员工「${created.name}」已创建，请立即复制初始密码，${AUDIT_WRITTEN_HINT}`);
    },
  });

  const updateMutation = useMutation({
    mutationFn: (payload: { id: string; body: UpdateUserRequest }) =>
      updateUser(payload.id, payload.body),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setUserFormOpen(false);
      setEditingUser(null);
      setUserForm(EMPTY_USER_FORM);
      toast.success(`员工「${updated.name}」的资料已更新，${AUDIT_WRITTEN_HINT}`);
    },
  });

  const resetMutation = useMutation({
    mutationFn: (user: UserListItem) => resetUserPassword(user.id),
    onSuccess: (result, user) => {
      setResetTarget(null);
      setCredential({ name: user.name, password: result.initialPassword });
      toast.success(`已重置「${user.name}」的密码，旧密码立即失效，${AUDIT_WRITTEN_HINT}`);
    },
  });

  const statusMutation = useMutation({
    mutationFn: (target: { user: UserListItem; next: UserStatus }) =>
      updateUserStatus(target.user.id, target.next),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setStatusTarget(null);
      toast.success(
        `「${updated.name}」已${updated.status === 'ACTIVE' ? '启用' : '停用'}，${AUDIT_WRITTEN_HINT}`,
      );
    },
  });

  const permissionMutation = useMutation({
    mutationFn: (payload: { user: UserListItem; overrides: string[] }) =>
      updateUserPermissions(payload.user.id, payload.overrides),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setPermissionTarget(null);
      toast.success(`「${updated.name}」的权限覆盖已保存，${AUDIT_WRITTEN_HINT}`);
    },
  });

  /* ---------------- 交互 ---------------- */

  function openCreate() {
    setEditingUser(null);
    setUserForm(EMPTY_USER_FORM);
    setUserFormError(null);
    setUserFormOpen(true);
  }

  function openEdit(user: UserListItem) {
    setEditingUser(user);
    setUserForm({
      email: user.email,
      name: user.name,
      role: user.role,
      phone: user.phone ?? '',
      teamId: user.team?.id ?? '',
      password: '',
    });
    setUserFormError(null);
    setUserFormOpen(true);
  }

  function handleUserFormSubmit() {
    const isCreate = editingUser === null;
    const message = validateUserForm(userForm, isCreate);
    setUserFormError(message);
    if (message !== null || userForm.role === '') return;

    const trimmedPhone = userForm.phone.trim();
    const trimmedTeamId = userForm.teamId.trim();

    if (isCreate) {
      createMutation.mutate({
        email: userForm.email.trim(),
        name: userForm.name.trim(),
        role: userForm.role,
        phone: trimmedPhone === '' ? undefined : trimmedPhone,
        teamId: trimmedTeamId === '' ? undefined : trimmedTeamId,
        // 留空时后端生成一次性初始密码（更安全：管理员不需要自己编密码再口头传递）
        password: userForm.password.trim() === '' ? undefined : userForm.password.trim(),
      });
      return;
    }

    updateMutation.mutate({
      id: editingUser.id,
      body: {
        name: userForm.name.trim(),
        role: userForm.role,
        phone: trimmedPhone === '' ? undefined : trimmedPhone,
        teamId: trimmedTeamId === '' ? undefined : trimmedTeamId,
      },
    });
  }

  function openPermissionDrawer(user: UserListItem) {
    setPermissionTarget(user);
    // 每次打开都从"无覆盖"开始：见 overrides 的说明，接口不回传历史覆盖值
    setOverrides({ grant: [], revoke: [] });
  }

  function overrideModeOf(code: string): OverrideMode {
    if (overrides.grant.includes(code)) return 'grant';
    if (overrides.revoke.includes(code)) return 'revoke';
    return 'inherit';
  }

  function setOverrideMode(code: string, mode: OverrideMode) {
    setOverrides((prev) => {
      const grant = prev.grant.filter((item) => item !== code);
      const revoke = prev.revoke.filter((item) => item !== code);
      if (mode === 'grant') grant.push(code);
      if (mode === 'revoke') revoke.push(code);
      return { grant, revoke };
    });
  }

  async function copyPassword(password: string) {
    try {
      await navigator.clipboard.writeText(password);
      toast.success('初始密码已复制到剪贴板');
    } catch {
      // 非 HTTPS 或用户拒绝剪贴板权限时会走到这里；不能假装成功，否则用户以为已经复制了
      toast.warning('浏览器拒绝了剪贴板访问，请手动选中密码复制');
    }
  }

  /* ---------------- 表格 ---------------- */

  const columns: Array<Column<UserListItem>> = [
    {
      key: 'name',
      title: '姓名',
      render: (row) => (
        <div className="row">
          {/* 首字母头像：列表里快速区分重名，不依赖后端返回头像文件 */}
          <span
            style={{
              width: 26,
              height: 26,
              flex: '0 0 auto',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '50%',
              background: 'var(--color-primary-50)',
              color: 'var(--color-primary-700)',
              fontSize: 'var(--font-size-xs)',
              fontWeight: 'var(--font-weight-medium)',
            }}
          >
            {row.name.slice(0, 1)}
          </span>
          <span>{row.name}</span>
        </div>
      ),
    },
    { key: 'email', title: '邮箱', render: (row) => <span className="mono">{row.email}</span> },
    {
      key: 'phone',
      title: '手机号',
      render: (row) => (row.phone ? <span className="mono">{row.phone}</span> : <span className="subtle">—</span>),
    },
    { key: 'role', title: '角色', render: (row) => ROLE_LABELS[row.role] ?? row.roleLabel },
    {
      key: 'status',
      title: '状态',
      render: (row) => (
        <StatusTag tone={USER_STATUS_TONES[row.status]} dot size="sm">
          {USER_STATUS_LABELS[row.status]}
        </StatusTag>
      ),
    },
    {
      key: 'team',
      title: '团队',
      render: (row) => row.team?.name ?? <span className="subtle">—</span>,
    },
    {
      key: 'lastLoginAt',
      title: '最后登录',
      sortable: true,
      render: (row) => formatDateTime(row.lastLoginAt),
    },
    {
      key: 'createdAt',
      title: '创建时间',
      sortable: true,
      render: (row) => formatDateTime(row.createdAt),
    },
    {
      key: 'actions',
      title: '操作',
      render: (row) => (
        <div className="tableActions">
          <PermissionGate permission={P.USER_WRITE}>
            <button type="button" className="btnLink" onClick={() => openEdit(row)}>
              编辑
            </button>
            <button type="button" className="btnLink" onClick={() => setResetTarget(row)}>
              重置密码
            </button>
            <button
              type="button"
              className={`btnLink ${row.status === 'ACTIVE' ? 'btnLinkDanger' : ''}`}
              onClick={() =>
                setStatusTarget({ user: row, next: row.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' })
              }
            >
              {row.status === 'ACTIVE' ? '停用' : '启用'}
            </button>
          </PermissionGate>
          <PermissionGate permission={P.ROLE_MANAGE}>
            <button type="button" className="btnLink" onClick={() => openPermissionDrawer(row)}>
              权限配置
            </button>
          </PermissionGate>
        </div>
      ),
    },
  ];

  const roleDefaults = new Set(
    rolesQuery.data?.find((role) => role.role === permissionTarget?.role)?.permissions ?? [],
  );
  const catalog = catalogQuery.data ?? [];
  // 目录按 group 分组：权限点有 40+ 个，平铺展示管理员会找不到目标权限
  const catalogGroups = [...new Set(catalog.map((item) => item.group))];

  return (
    <div className="page">
      <PageHeader
        title="员工与角色"
        subtitle="账号由系统管理员维护；初始密码只在创建/重置的那一刻展示一次，请当场转交"
        actions={
          <PermissionGate permission={P.USER_WRITE}>
            <button type="button" className="btn btnPrimary" onClick={openCreate}>
              新建员工
            </button>
          </PermissionGate>
        }
      />

      <FilterBar
        key={filterResetKey}
        fields={[
          {
            type: 'keyword',
            key: 'keyword',
            value: filters.keyword,
            placeholder: '姓名 / 邮箱 / 手机号',
            onChange: (value) => table.setFilters({ keyword: value }),
          },
          {
            type: 'select',
            key: 'role',
            label: '角色',
            value: filters.role,
            options: ROLE_OPTIONS,
            onChange: (value) => table.setFilters({ role: value }),
          },
          {
            type: 'select',
            key: 'status',
            label: '状态',
            value: filters.status,
            options: USER_STATUS_OPTIONS,
            onChange: (value) => table.setFilters({ status: value }),
          },
        ]}
        onReset={() => {
          table.reset();
          setFilterResetKey((prev) => prev + 1);
        }}
        resultCount={listQuery.data?.total}
      />

      <DataTable<UserListItem>
        columns={columns}
        rows={listQuery.data?.items ?? []}
        rowKey={(row) => row.id}
        loading={listQuery.isLoading}
        error={listQuery.isError ? resolveErrorMessage(listQuery.error) : null}
        onRetry={() => {
          void listQuery.refetch();
        }}
        onSortChange={table.setSort}
        sortBy={table.query.sortBy}
        sortOrder={table.query.sortOrder}
        page={table.query.page}
        pageSize={table.query.pageSize}
        total={listQuery.data?.total}
        totalPages={listQuery.data?.totalPages}
        onPageChange={table.setPage}
        onPageSizeChange={table.setPageSize}
        pageSizeOptions={table.pageSizeOptions}
        emptyTitle="没有符合条件的员工"
        emptyDescription="换个关键词，或清空筛选条件后重新查询"
        stickyHeader
      />

      {/* ---------------- 角色矩阵 ---------------- */}
      <div className="card" style={{ marginTop: 'var(--space-4)' }}>
        <div className="cardHeader">
          <span className="cardTitle">角色矩阵</span>
          <span className="hint">角色决定了基础权限与数据范围，个人差异走「权限配置」里的覆盖项</span>
        </div>
        <div className="cardBody">
          {rolesQuery.isLoading && <LoadingSkeleton rows={4} columns={4} />}

          {rolesQuery.isError && (
            <ErrorState
              message={resolveErrorMessage(rolesQuery.error)}
              onRetry={() => {
                void rolesQuery.refetch();
              }}
              compact
            />
          )}

          {rolesQuery.data?.length === 0 && <div className="emptyInline">后端未返回任何角色定义</div>}

          {(rolesQuery.data ?? []).map((role) => {
            const expanded = expandedRole === role.role;
            return (
              <div key={role.role} style={{ borderBottom: '1px solid var(--color-border)' }}>
                <div
                  className="rowBetween"
                  style={{ padding: 'var(--space-2) 0', cursor: 'pointer' }}
                  onClick={() => setExpandedRole(expanded ? null : role.role)}
                >
                  <span className="row" style={{ gap: 'var(--space-2)' }}>
                    <span className="mono subtle">{expanded ? '▾' : '▸'}</span>
                    <strong>{role.label || ROLE_LABELS[role.role]}</strong>
                    <span className="mono subtle">{role.role}</span>
                  </span>
                  <span className="row" style={{ gap: 'var(--space-2)' }}>
                    <StatusTag tone="info" size="sm">
                      {DATA_SCOPE_LABELS[role.dataScope] ?? role.dataScope}
                    </StatusTag>
                    <span className="muted">{role.permissions.length} 个权限点</span>
                  </span>
                </div>

                {expanded && (
                  <div className="chipGroup" style={{ paddingBottom: 'var(--space-3)' }}>
                    {role.permissions.map((code) => (
                      <span key={code} className="chip" title={code}>
                        {permissionLabel(code)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ---------------- 新建 / 编辑员工 ---------------- */}
      <Modal
        open={userFormOpen}
        title={editingUser === null ? '新建员工' : `编辑「${editingUser.name}」`}
        description="邮箱即登录账号；初始密码留空时由后端生成一次性密码"
        onClose={() => {
          if (createMutation.isPending || updateMutation.isPending) return;
          setUserFormOpen(false);
          setEditingUser(null);
        }}
        footer={
          <>
            <button
              type="button"
              className="btn"
              disabled={createMutation.isPending || updateMutation.isPending}
              onClick={() => {
                setUserFormOpen(false);
                setEditingUser(null);
              }}
            >
              取消
            </button>
            <button
              type="button"
              className="btn btnPrimary"
              disabled={createMutation.isPending || updateMutation.isPending}
              onClick={handleUserFormSubmit}
            >
              {(createMutation.isPending || updateMutation.isPending) && (
                <span className="spinner" aria-hidden="true" />
              )}
              {editingUser === null ? '创建并生成初始密码' : '保存'}
            </button>
          </>
        }
      >
        <div className="formGrid">
          <div className="field">
            <label className="label labelRequired" htmlFor="user-email">
              邮箱
            </label>
            <input
              id="user-email"
              className="input"
              type="email"
              // 邮箱是登录标识，后端 UpdateUserRequest 里也不含 email，编辑时锁定避免误导
              disabled={editingUser !== null}
              placeholder="name@company.com"
              value={userForm.email}
              onChange={(event) => setUserForm((prev) => ({ ...prev, email: event.target.value }))}
            />
            <span className="hint">
              {editingUser === null ? '创建后不可修改，改邮箱等于换账号。' : '邮箱不可修改。'}
            </span>
          </div>

          <div className="field">
            <label className="label labelRequired" htmlFor="user-name">
              姓名
            </label>
            <input
              id="user-name"
              className="input"
              type="text"
              value={userForm.name}
              onChange={(event) => setUserForm((prev) => ({ ...prev, name: event.target.value }))}
            />
          </div>

          <div className="field">
            <label className="label labelRequired" htmlFor="user-role">
              角色
            </label>
            <select
              id="user-role"
              className="select"
              value={userForm.role}
              onChange={(event) =>
                setUserForm((prev) => ({ ...prev, role: event.target.value as UserRole }))
              }
            >
              <option value="">请选择</option>
              {ROLE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label className="label" htmlFor="user-phone">
              手机号
            </label>
            <input
              id="user-phone"
              className="input"
              type="text"
              placeholder="用于登录异常时的联系与二次验证"
              value={userForm.phone}
              onChange={(event) => setUserForm((prev) => ({ ...prev, phone: event.target.value }))}
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="user-team">
              所属团队 ID
            </label>
            {/* 平台暂未开放团队列表接口，因此不做下拉：与其造一个假选项，不如让管理员填已知的团队 ID */}
            <input
              id="user-team"
              className="input mono"
              type="text"
              placeholder="选填，团队 UUID"
              value={userForm.teamId}
              onChange={(event) => setUserForm((prev) => ({ ...prev, teamId: event.target.value }))}
            />
            <span className="hint">影响数据范围（本团队数据）的判定，留空表示不归属具体团队。</span>
          </div>

          {editingUser === null && (
            <div className="field">
              <label className="label" htmlFor="user-password">
                初始密码
              </label>
              <input
                id="user-password"
                className="input"
                type="password"
                placeholder="留空则由后端生成一次性密码"
                value={userForm.password}
                onChange={(event) =>
                  setUserForm((prev) => ({ ...prev, password: event.target.value }))
                }
              />
              <span className="hint">
                建议留空：自动生成的随机密码比人手编的更强，且只在提交后展示一次。
              </span>
            </div>
          )}

          {userFormError !== null && (
            <div className="field fieldFull errorText">{userFormError}</div>
          )}
        </div>
      </Modal>

      {/* ---------------- 一次性初始密码 ---------------- */}
      <Modal
        open={credential !== null}
        title="初始密码（仅展示这一次）"
        size="sm"
        closeOnMaskClick={false}
        onClose={() => setCredential(null)}
        footer={
          <button type="button" className="btn btnPrimary" onClick={() => setCredential(null)}>
            我已记录，关闭
          </button>
        }
      >
        {credential && (
          <div className="stack">
            <div>
              员工 <strong>{credential.name}</strong> 的初始密码：
            </div>
            <div className="row">
              <code
                className="mono"
                style={{
                  flex: '1 1 auto',
                  padding: 'var(--space-3)',
                  background: 'var(--color-bg-subtle)',
                  border: '1px solid var(--color-border-strong)',
                  borderRadius: 'var(--radius-md)',
                  fontSize: 'var(--font-size-lg)',
                  letterSpacing: '0.08em',
                }}
              >
                {credential.password}
              </code>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void copyPassword(credential.password);
                }}
              >
                复制
              </button>
            </div>
            <div className="errorText">
              关闭后无法再次查看（后端只保存密码哈希）。请通过企业微信等可信渠道单独转交，并要求首次登录后立即修改。
            </div>
          </div>
        )}
      </Modal>

      {/* ---------------- 重置密码确认 ---------------- */}
      <ConfirmDialog
        open={resetTarget !== null}
        title="重置密码"
        message={
          <>
            将重置 <strong>{resetTarget?.name}</strong> 的登录密码，旧密码立即失效。
            重置后系统会生成一次性初始密码，请当场复制并转交给本人。
          </>
        }
        confirmText="重置密码"
        loading={resetMutation.isPending}
        onCancel={() => setResetTarget(null)}
        onConfirm={() => {
          if (resetTarget) resetMutation.mutate(resetTarget);
        }}
      />

      {/* ---------------- 停用 / 启用确认 ---------------- */}
      <ConfirmDialog
        open={statusTarget !== null}
        title={statusTarget?.next === 'ACTIVE' ? '启用员工账号' : '停用员工账号'}
        message={
          statusTarget?.next === 'ACTIVE' ? (
            <>
              启用后 <strong>{statusTarget?.user.name}</strong> 可以重新登录系统，权限与停用前一致。
            </>
          ) : (
            <>
              停用后 <strong>{statusTarget?.user.name}</strong>{' '}
              会被<strong>立即登出</strong>，且无法再登录，直到重新启用。已产生的业务数据不受影响。
            </>
          )
        }
        confirmText={statusTarget?.next === 'ACTIVE' ? '启用' : '停用'}
        danger={statusTarget?.next !== 'ACTIVE'}
        loading={statusMutation.isPending}
        onCancel={() => setStatusTarget(null)}
        onConfirm={() => {
          if (statusTarget) statusMutation.mutate(statusTarget);
        }}
      />

      {/* ---------------- 权限配置 ---------------- */}
      <Drawer
        open={permissionTarget !== null}
        title={permissionTarget ? `权限配置 · ${permissionTarget.name}` : '权限配置'}
        description={
          permissionTarget
            ? `角色：${ROLE_LABELS[permissionTarget.role] ?? permissionTarget.roleLabel}（角色权限是基线，覆盖项在其之上生效）`
            : undefined
        }
        size="wide"
        onClose={() => setPermissionTarget(null)}
        footer={
          <>
            <button
              type="button"
              className="btn"
              disabled={permissionMutation.isPending}
              onClick={() => setPermissionTarget(null)}
            >
              取消
            </button>
            <button
              type="button"
              className="btn btnPrimary"
              disabled={permissionMutation.isPending}
              onClick={() => {
                if (!permissionTarget) return;
                // 提交前用 joinPermissionOverrides 拼成后端约定的形式：
                // 授予写裸权限码，撤销在权限码前加 '-'（最小权限原则下的临时收权）
                permissionMutation.mutate({
                  user: permissionTarget,
                  overrides: joinPermissionOverrides(overrides),
                });
              }}
            >
              {permissionMutation.isPending && <span className="spinner" aria-hidden="true" />}
              保存覆盖项
            </button>
          </>
        }
      >
        {catalogQuery.isLoading && <LoadingSkeleton rows={8} columns={3} />}

        {catalogQuery.isError && (
          <ErrorState
            message={resolveErrorMessage(catalogQuery.error)}
            onRetry={() => {
              void catalogQuery.refetch();
            }}
            compact
          />
        )}

        {catalogQuery.data && (
          <div className="stack">
            <div className="hint">
              当前覆盖：额外授予 {overrides.grant.length} 项，撤销 {overrides.revoke.length} 项。
              「角色默认」列来自 getRoles()，仅作参考——它不代表该员工当前的实际授权结果。
            </div>

            {catalogGroups.map((group) => (
              <div key={group}>
                <div className="sectionTitle">{group}</div>
                {catalog
                  .filter((item) => item.group === group)
                  .map((item) => {
                    const mode = overrideModeOf(item.code);
                    return (
                      <div
                        key={item.code}
                        className="rowBetween"
                        style={{
                          padding: 'var(--space-2) 0',
                          borderBottom: '1px solid var(--color-border)',
                        }}
                      >
                        <div className="grow">
                          <div className="row" style={{ gap: 'var(--space-2)' }}>
                            <span>{item.label}</span>
                            <StatusTag tone={RISK_TONES[item.risk]} size="sm">
                              {RISK_LABELS[item.risk]}
                            </StatusTag>
                            {roleDefaults.has(item.code) ? (
                              <StatusTag tone="neutral" size="sm">
                                角色默认
                              </StatusTag>
                            ) : (
                              <span className="subtle">角色无此权限</span>
                            )}
                          </div>
                          <div className="hint mono">{item.code}</div>
                        </div>

                        <select
                          className="select"
                          style={{ width: 150 }}
                          value={mode}
                          onChange={(event) =>
                            setOverrideMode(item.code, event.target.value as OverrideMode)
                          }
                        >
                          <option value="inherit">继承角色</option>
                          <option value="grant">额外授予</option>
                          <option value="revoke">撤销该权限</option>
                        </select>
                      </div>
                    );
                  })}
              </div>
            ))}
          </div>
        )}
      </Drawer>
    </div>
  );
}
