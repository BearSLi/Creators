import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/PageHeader';
import { DataTable, type Column } from '@/components/DataTable';
import { FilterBar, type FilterField } from '@/components/FilterBar';
import { Modal } from '@/components/Modal';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StatusTag } from '@/components/StatusTag';
import { MoneyText } from '@/components/MoneyText';
import { PermissionGate } from '@/components/PermissionGate';
import { useToast, AUDIT_WRITTEN_HINT } from '@/components/Toast';
import { useTableQuery } from '@/hooks/useTableQuery';
import { createProject, deleteProject, getProject, listProjects, updateProject } from '@/api/projects';
import type {
  CreateProjectRequest,
  ProjectDetail,
  ProjectListItem,
  ProjectStatus,
  UpdateProjectRequest,
  Vertical,
} from '@/api/types';
import { resolveErrorMessage } from '@/api/client';
import {
  PROJECT_STATUS_LABELS,
  PROJECT_STATUS_OPTIONS,
  PROJECT_STATUS_TONES,
  VERTICAL_OPTIONS,
  verticalLabel,
} from '@/utils/constants';
import { formatDate } from '@/utils/format';
import { P } from '@/utils/permissions';

/**
 * 项目列表。
 *
 * 项目 = 一次品牌投放，下面挂多条内容，所以列表上最关键的列是「内容进度」——
 * 运营打开这个页面主要是在追"还剩几条没发"，金额只是辅助信息。
 *
 * 三个刻意的取舍：
 *   1) 品牌/达人筛选用**文本 id 输入**而不是下拉：后端目前没有"品牌/达人候选"的轻量
 *      picker 接口，前端若拉全量 listBrands/listCreators 拼下拉，达人上万时会打出一串
 *      大分页请求；这里先用 id 精确筛选（id 通常从达人页或详情页复制），等后端补了
 *      searchable picker 再换 UI，筛选参数不用动；
 *   2) 超预算只做**纯展示比较**：budget / actualCost 都是后端下发的字符串元，前端比较
 *      一下就标红，不做差值计算、更不回写——金额一旦在前端算过，就会出现
 *      "界面 9,999.99、结算单 10,000.00"的对账事故；
 *   3) 编辑不跳独立页面而是复用同一个 Modal：项目字段不多，跳页再返回会丢掉列表的筛选
 *      与页码，运营只改一个截止日期不该付出这个成本。
 */

/** 列表筛选条件；字段名与 ProjectListQuery 对齐，空值由 buildParams 丢弃 */
interface ProjectFilters extends Record<string, unknown> {
  keyword: string;
  status: ProjectStatus[];
  brandId: string;
  creatorId: string;
}

const EMPTY_FILTERS: ProjectFilters = { keyword: '', status: [], brandId: '', creatorId: '' };

/** 表单状态全部用字符串保存：日期控件原生就是 yyyy-MM-dd，与后端契约一致 */
interface ProjectFormState {
  name: string;
  brandId: string;
  creatorId: string;
  vertical: string;
  budget: string;
  startDate: string;
  dueDate: string;
  /** 字段名与后端 DTO 一致：brief，不是 description */
  brief: string;
}

/**
 * 详情 / 列表行 → 表单初值。金额原样带入，不做格式化，避免「打开就变数」。
 *
 * 注意这里**没有 status**：后端 CreateProjectDto / UpdateProjectDto 都不接受该字段，
 * 项目状态只能通过 `POST /api/projects/:id/status` 流转（受状态机约束并写审计日志）。
 * 早期表单带了这个字段，提交时被后端的 forbidNonWhitelisted 直接拒绝。
 */
function toFormState(project: Partial<ProjectDetail> & { name: string }): ProjectFormState {
  return {
    name: project.name,
    brandId: project.brandId ?? '',
    creatorId: project.creatorId ?? '',
    vertical: project.vertical ?? '',
    budget: project.budget ?? '',
    startDate: project.startDate ? formatDate(project.startDate) : '',
    dueDate: project.dueDate ? formatDate(project.dueDate) : '',
    brief: project.brief ?? '',
  };
}

/** 金额输入兜底：允许留空，但绝不能把空串塞给后端的 decimal 字段 */
function normalizeMoney(input: string): string {
  return input.trim() === '' ? '0' : input.trim();
}

export default function ProjectListPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { query, setPage, setPageSize, setFilters, reset, setSort, pageSizeOptions } =
    useTableQuery<ProjectFilters>({ initialFilters: EMPTY_FILTERS, initialPageSize: 20 });

  /** formTarget 为 null 表示新建，否则为正在编辑的那一行 */
  const [formTarget, setFormTarget] = useState<ProjectListItem | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProjectListItem | null>(null);

  /** 编辑目标：既驱动弹窗，也驱动详情查询（详情没到位不允许提交） */
  const editTarget = formOpen && formTarget !== null ? formTarget : null;

  const detailQuery = useQuery({
    queryKey: ['projects', 'detail', editTarget?.id],
    queryFn: () => getProject(editTarget?.id ?? ''),
    // 只有编辑态才需要详情；新建态把查询关掉，避免多余请求
    enabled: editTarget !== null,
  });

  const { keyword, status, brandId, creatorId } = query.filters;

  const { data, isLoading, isError, error, refetch } = useQuery({
    // 整个查询条件进 key：筛选/翻页/排序任一变化自动重取，不需要 useEffect 手工同步
    queryKey: [
      'projects',
      'list',
      query.page,
      query.pageSize,
      query.sortBy,
      query.sortOrder,
      keyword,
      status,
      brandId,
      creatorId,
    ],
    queryFn: () =>
      listProjects({
        page: query.page,
        pageSize: query.pageSize,
        sortBy: query.sortBy,
        sortOrder: query.sortOrder,
        keyword: keyword || undefined,
        status,
        brandId: brandId || undefined,
        creatorId: creatorId || undefined,
      }),
    // 翻页时保留上一页数据：表格不闪骨架，行高不跳动
    placeholderData: keepPreviousData,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteProject(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      // 内容列表带 projectName，项目没了内容缓存也要失效
      queryClient.invalidateQueries({ queryKey: ['contents'] });
      toast.success(`项目已删除，${AUDIT_WRITTEN_HINT}`);
      setDeleteTarget(null);
    },
  });

  const openCreate = () => {
    setFormTarget(null);
    setFormOpen(true);
  };

  // useCallback 只为让列表 columns 的依赖稳定；行数据在点击时才传入，不进依赖
  const openEdit = useCallback((row: ProjectListItem) => {
    setFormTarget(row);
    setFormOpen(true);
  }, []);

  /** 展示用比较：只回答"实际成本是否超过预算"，不产出任何派生金额 */
  const isOverBudget = (row: ProjectListItem): boolean => {
    const budget = Number(row.budget);
    const actual = Number(row.actualCost);
    if (!Number.isFinite(budget) || !Number.isFinite(actual) || budget <= 0) return false;
    return actual > budget;
  };

  const fields: FilterField[] = [
    {
      type: 'keyword',
      key: 'keyword',
      placeholder: '项目名称 / 编号',
      value: keyword,
      onChange: (value) => setFilters({ keyword: value }),
    },
    {
      type: 'multi',
      key: 'status',
      label: '项目状态',
      value: status,
      options: PROJECT_STATUS_OPTIONS,
      // FilterBar 是通用组件，多选值类型是 string[]，这里收窄回 ProjectStatus[]
      onChange: (value) => setFilters({ status: value as ProjectStatus[] }),
    },
    {
      type: 'custom',
      key: 'brandId',
      label: '品牌 ID',
      // 见文件头取舍 1：后端暂无品牌下拉接口，先用文本 id 精确筛选
      render: () => (
        <input
          className="input"
          style={{ width: 210 }}
          value={brandId}
          placeholder="粘贴品牌 id 精确筛选"
          onChange={(event) => setFilters({ brandId: event.target.value })}
        />
      ),
    },
    {
      type: 'custom',
      key: 'creatorId',
      label: '达人 ID',
      render: () => (
        <input
          className="input"
          style={{ width: 210 }}
          value={creatorId}
          placeholder="粘贴达人 id 精确筛选"
          onChange={(event) => setFilters({ creatorId: event.target.value })}
        />
      ),
    },
  ];

  const columns: Column<ProjectListItem>[] = useMemo(
    () => [
      {
        key: 'code',
        title: '项目编号',
        width: 132,
        render: (row) => <span className="mono">{row.code}</span>,
      },
      {
        key: 'name',
        title: '项目名称',
        minWidth: 200,
        render: (row) => (
          <button
            type="button"
            className="btnLink"
            onClick={(event) => {
              // 阻止冒泡：行点击本身也会进详情，按钮点击不该触发两次导航
              event.stopPropagation();
              navigate(`/projects/${row.id}`);
            }}
          >
            {row.name}
          </button>
        ),
      },
      {
        key: 'status',
        title: '状态',
        width: 104,
        render: (row) => (
          <StatusTag tone={PROJECT_STATUS_TONES[row.status]}>{PROJECT_STATUS_LABELS[row.status]}</StatusTag>
        ),
      },
      {
        key: 'vertical',
        title: '垂类',
        width: 96,
        render: (row) => (row.vertical ? verticalLabel(row.vertical) : '—'),
      },
      {
        key: 'brandName',
        title: '品牌',
        width: 148,
        ellipsis: true,
        render: (row) => row.brandName ?? '—',
      },
      {
        key: 'creatorName',
        title: '达人',
        width: 124,
        ellipsis: true,
        render: (row) => row.creatorName ?? '—',
      },
      {
        key: 'budget',
        title: '预算（元）',
        width: 124,
        align: 'right',
        render: (row) => <MoneyText value={row.budget} variant="plain" />,
      },
      {
        key: 'actualCost',
        title: '实际成本（元）',
        width: 136,
        align: 'right',
        tooltip: '超过预算时标红。前端只做展示比较，不做金额运算回写',
        render: (row) => {
          const over = isOverBudget(row);
          return (
            // MoneyText 不支持内联样式，超预算的红色提示放在外层容器上
            <span
              style={over ? { color: 'var(--color-money-negative)' } : undefined}
              title={over ? '实际成本已超过预算' : undefined}
            >
              <MoneyText value={row.actualCost} variant="plain" />
            </span>
          );
        },
      },
      {
        key: 'period',
        title: '起止日期',
        width: 196,
        render: (row) => (
          <span className="nowrap">
            {formatDate(row.startDate)} ~ {formatDate(row.dueDate)}
          </span>
        ),
      },
      {
        key: 'contentProgress',
        title: '内容进度',
        width: 140,
        render: (row) => {
          // 分母为 0 时进度给 0：否则 0/0 算出 NaN 宽度，进度条会直接消失
          const percent =
            row.contentCount > 0
              ? Math.min(100, Math.round((row.publishedCount / row.contentCount) * 100))
              : 0;
          return (
            <div className="stack" style={{ gap: 'var(--space-1)' }}>
              <span className="nowrap">
                {row.publishedCount}/{row.contentCount}
              </span>
              <div
                role="progressbar"
                aria-valuenow={percent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="已发布内容占比"
                style={{
                  height: 6,
                  borderRadius: 'var(--radius-pill)',
                  background: 'var(--color-bg-active)',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${percent}%`,
                    height: '100%',
                    background: 'var(--color-primary-500)',
                  }}
                />
              </div>
            </div>
          );
        },
      },
      {
        key: 'actions',
        title: '操作',
        width: 176,
        render: (row) => (
          <div className="tableActions">
            <button type="button" className="btn btnSm" onClick={() => navigate(`/projects/${row.id}`)}>
              查看
            </button>
            {/* 编辑/删除会改数据，必须过权限门；无权限直接不渲染，避免"点了才被拒" */}
            <PermissionGate permission={P.PROJECT_WRITE}>
              <button type="button" className="btn btnSm" onClick={() => openEdit(row)}>
                编辑
              </button>
            </PermissionGate>
            <PermissionGate permission={P.PROJECT_WRITE}>
              <button type="button" className="btn btnSm" onClick={() => setDeleteTarget(row)}>
                删除
              </button>
            </PermissionGate>
          </div>
        ),
      },
    ],
    // navigate / openEdit 都是稳定引用，列不随筛选条件重建
    [navigate, openEdit],
  );

  return (
    <div className="page">
      <PageHeader
        title="项目管理"
        subtitle="一个项目对应一次品牌投放；内容进度与超预算情况在这里一眼看完"
        actions={
          <PermissionGate permission={P.PROJECT_WRITE}>
            <button type="button" className="btn btnPrimary" onClick={openCreate}>
              新建项目
            </button>
          </PermissionGate>
        }
      />

      <FilterBar fields={fields} onReset={reset} resultCount={data?.total} />

      <DataTable<ProjectListItem>
        columns={columns}
        rows={data?.items ?? []}
        rowKey={(row) => row.id}
        loading={isLoading}
        error={isError ? resolveErrorMessage(error) : null}
        onRetry={() => void refetch()}
        emptyTitle="还没有项目"
        emptyDescription="项目是内容排期与结算归属的载体，先建一个项目再把内容挂进来"
        emptyAction={
          <PermissionGate permission={P.PROJECT_WRITE}>
            <button type="button" className="btn btnPrimary" onClick={openCreate}>
              新建项目
            </button>
          </PermissionGate>
        }
        onSortChange={setSort}
        sortBy={query.sortBy}
        sortOrder={query.sortOrder}
        page={query.page}
        pageSize={query.pageSize}
        total={data?.total}
        totalPages={data?.totalPages}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        pageSizeOptions={pageSizeOptions}
        onRowClick={(row) => navigate(`/projects/${row.id}`)}
        stickyHeader
      />

      {/* key 绑定编辑对象：切换项目时重挂弹窗，表单初值不会被上一个项目污染 */}
      <ProjectFormModal
        key={formTarget?.id ?? 'new'}
        open={formOpen}
        target={formTarget}
        detail={detailQuery.data}
        loadingDetail={editTarget !== null && detailQuery.isPending}
        onClose={() => setFormOpen(false)}
        onSaved={(name, isEdit) => {
          queryClient.invalidateQueries({ queryKey: ['projects'] });
          toast.success(`项目「${name}」已${isEdit ? '更新' : '创建'}，${AUDIT_WRITTEN_HINT}`);
          setFormOpen(false);
        }}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除项目"
        danger
        confirmText="删除项目"
        loading={deleteMutation.isPending}
        message={
          <>
            将删除项目「{deleteTarget?.name}」（{deleteTarget?.code}）。
            <br />
            项目下若还挂着内容，后端会拒绝删除；请先转移或删除内容，避免误删投放记录。
          </>
        }
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
        }}
      />
    </div>
  );
}

/* ============================================================
   新建 / 编辑弹窗
   ============================================================ */

interface ProjectFormModalProps {
  open: boolean;
  /** 编辑对象；null 表示新建 */
  target: ProjectListItem | null;
  /** 编辑时的完整详情：列表行没有 description，用它做初值才不会被空值覆盖 */
  detail: ProjectDetail | undefined;
  loadingDetail: boolean;
  onClose: () => void;
  onSaved: (name: string, isEdit: boolean) => void;
}

/**
 * 项目新建 / 编辑弹窗。
 *
 * 编辑态先拉详情再灌初值：项目列表不返回 description，若用列表行做初值，
 * 用户只改了截止日期，一起提交的 description 也会被当成"要清空"，
 * 把原来的投放说明洗掉——这是"用不完整数据做 PATCH"的典型事故，宁可多一次详情请求。
 * 组件由父级按 editTarget.id 设 key，切换对象时整块重挂，初值不依赖 useEffect。
 */
function ProjectFormModal({
  open,
  target,
  detail,
  loadingDetail,
  onClose,
  onSaved,
}: ProjectFormModalProps) {
  const isEdit = target !== null;
  // detail 到位前用列表行兜底，避免输入框先渲染成空再被填上
  const [form, setForm] = useState<ProjectFormState>(() =>
    toFormState(detail ?? { name: target?.name ?? '' }),
  );
  const [nameTouched, setNameTouched] = useState(false);

  const createMutation = useMutation({
    mutationFn: (body: CreateProjectRequest) => createProject(body),
    onSuccess: (created) => onSaved(created.name, false),
  });

  const updateMutation = useMutation({
    mutationFn: (body: UpdateProjectRequest) => updateProject(target?.id ?? '', body),
    onSuccess: (updated) => onSaved(updated.name, true),
  });

  const pending = createMutation.isPending || updateMutation.isPending;
  const nameInvalid = form.name.trim().length === 0;
  /** 详情未到位就提交 = 拿空表单覆盖线上数据，必须锁住 */
  const submitBlocked = pending || (isEdit && loadingDetail);

  const submit = () => {
    setNameTouched(true);
    if (nameInvalid || submitBlocked) return;

    const payload: CreateProjectRequest = {
      name: form.name.trim(),
      // 选填项留空就不提交：PATCH 里空串的语义是"清空该字段"，与"没填"是两回事
      brandId: form.brandId.trim() || undefined,
      creatorId: form.creatorId.trim() || undefined,
      vertical: (form.vertical || undefined) as Vertical | undefined,
      // 不再提交 status：后端 DTO 无此字段，状态流转走专门的状态机接口
      budget: normalizeMoney(form.budget),
      startDate: form.startDate || undefined,
      dueDate: form.dueDate || undefined,
      brief: form.brief.trim() || undefined,
    };

    if (isEdit) {
      updateMutation.mutate(payload);
      return;
    }
    createMutation.mutate(payload);
  };

  return (
    <Modal
      open={open}
      title={isEdit ? `编辑项目「${target?.name}」` : '新建项目'}
      description="名称必填；品牌与达人可稍后补充，日期留空表示未排期"
      onClose={pending ? () => undefined : onClose}
      size="lg"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={pending}>
            取消
          </button>
          <button type="button" className="btn btnPrimary" onClick={submit} disabled={submitBlocked}>
            {pending && <span className="spinner" aria-hidden="true" />}
            {isEdit ? '保存修改' : '创建项目'}
          </button>
        </>
      }
    >
      {isEdit && loadingDetail ? (
        <div className="stack">
          <span className="skeleton" style={{ width: '60%', height: 16 }} />
          <span className="skeleton" style={{ width: '80%', height: 16 }} />
          <span className="skeleton" style={{ width: '45%', height: 16 }} />
        </div>
      ) : (
        <div className="formGrid">
          <div className="field">
            <label className="label labelRequired" htmlFor="project-name">
              项目名称
            </label>
            <input
              id="project-name"
              className={`input ${nameTouched && nameInvalid ? 'inputError' : ''}`}
              value={form.name}
              placeholder="例：美丽雅洗碗布 3 月种草"
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              onBlur={() => setNameTouched(true)}
            />
            {nameTouched && nameInvalid && <span className="errorText">项目名称不能为空</span>}
          </div>

          <div className="field">
            <label className="label" htmlFor="project-brand">
              品牌 ID
            </label>
            <input
              id="project-brand"
              className="input"
              value={form.brandId}
              placeholder="品牌 id，可留空"
              onChange={(event) => setForm({ ...form, brandId: event.target.value })}
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="project-creator">
              达人 ID
            </label>
            <input
              id="project-creator"
              className="input"
              value={form.creatorId}
              placeholder="达人 id，可留空"
              onChange={(event) => setForm({ ...form, creatorId: event.target.value })}
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="project-vertical">
              垂类
            </label>
            <select
              id="project-vertical"
              className="select"
              value={form.vertical}
              onChange={(event) => setForm({ ...form, vertical: event.target.value })}
            >
              <option value="">未指定</option>
              {VERTICAL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          {/*
            这里原本有一个「状态」下拉。已移除，原因是后端 CreateProjectDto /
            UpdateProjectDto 都不接受 status —— 新建项目固定为 DRAFT，
            后续流转必须走 POST /api/projects/:id/status（受状态机约束、写审计日志）。
            保留这个下拉只会让用户以为能直接指定状态，提交却报「字段不存在」。
            状态变更入口在项目详情页的操作按钮（只渲染后端返回的 allowedNext）。
          */}

          <div className="field">
            <label className="label" htmlFor="project-budget">
              预算（元）
            </label>
            <input
              id="project-budget"
              className="input"
              inputMode="decimal"
              value={form.budget}
              placeholder="例：50000"
              onChange={(event) => setForm({ ...form, budget: event.target.value })}
            />
            <span className="hint">按字符串元提交，留空按 0 处理；前端不做任何加减</span>
          </div>

          <div className="field">
            <label className="label" htmlFor="project-start">
              开始日期
            </label>
            <input
              id="project-start"
              type="date"
              className="input"
              value={form.startDate}
              onChange={(event) => setForm({ ...form, startDate: event.target.value })}
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="project-due">
              结束日期
            </label>
            <input
              id="project-due"
              type="date"
              className="input"
              value={form.dueDate}
              min={form.startDate || undefined}
              onChange={(event) => setForm({ ...form, dueDate: event.target.value })}
            />
          </div>

          <div className="field fieldFull">
            <label className="label" htmlFor="project-brief">
              项目 brief（内容方向与交付要求）
            </label>
            <textarea
              id="project-brief"
              className="textarea"
              rows={3}
              value={form.brief}
              placeholder="投放目标、交付要求、注意事项等。这是给内容团队看的交付说明"
              onChange={(event) => setForm({ ...form, brief: event.target.value })}
            />
          </div>
        </div>
      )}
    </Modal>
  );
}
