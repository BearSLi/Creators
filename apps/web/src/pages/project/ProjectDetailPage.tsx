import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/PageHeader';
import { DataTable, type Column } from '@/components/DataTable';
import { Modal } from '@/components/Modal';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StatusTag } from '@/components/StatusTag';
import { MoneyText } from '@/components/MoneyText';
import { DetailSkeleton } from '@/components/LoadingSkeleton';
import { ErrorState } from '@/components/EmptyState';
import { PermissionGate } from '@/components/PermissionGate';
import { useToast, AUDIT_WRITTEN_HINT } from '@/components/Toast';
import { deleteProject, getProject, updateProject } from '@/api/projects';
import { createContent, listContents } from '@/api/contents';
import type {
  ContentListItem,
  ContentStatus,
  CreateContentRequest,
  UpdateProjectRequest,
  Vertical,
} from '@/api/types';
import { resolveErrorMessage } from '@/api/client';
import {
  CONTENT_STATUS_LABELS,
  CONTENT_STATUS_TONES,
  PLATFORM_LABELS,
  PLATFORM_OPTIONS,
  PROJECT_STATUS_LABELS,
  PROJECT_STATUS_TONES,
  VERTICAL_OPTIONS,
  verticalLabel,
} from '@/utils/constants';
import { formatCount, formatDate, formatDateTime } from '@/utils/format';
import { P } from '@/utils/permissions';

/**
 * 项目详情。
 *
 * 页面结构围绕"项目是投放的执行单元"来组织：
 *   上半部分回答"这个项目是什么"（编号/状态/品牌/达人/预算/实际成本/起止），
 *   下半部分回答"执行到哪一步了"（项目下的内容列表）。
 *
 * 两个关键取舍：
 *   - 内容列表只取前 20 条而不是做分页：项目详情里的内容区是"概览"，用户要看全量
 *     应该去内容看板按 projectId 筛选（那里有完整的筛选与分页）；
 *     在详情页塞一套分页器会让"项目信息"和"内容排期"两个任务互相干扰；
 *   - 编辑用 Modal 复用列表页的字段集；删除成功后**回列表**而不是留在详情页，
 *     因为当前路由的 id 已经不存在，继续停留只会得到 404 错误态。
 */

/**
 * 编辑表单状态：全部字符串化，方便直接绑定原生控件。
 *
 * 字段与 `UpdateProjectRequest` 一一对应 —— 不含 `status`：
 * 状态只能走 `POST /api/projects/:id/status`（受状态机约束并写审计日志），
 * 早期这里放了一个可编辑的状态下拉，但提交时后端会因 `forbidNonWhitelisted`
 * 直接 400；即使能提交也是绕过状态机改状态，属于越权。
 */
interface ProjectEditForm {
  name: string;
  vertical: string;
  budget: string;
  startDate: string;
  dueDate: string;
  brief: string;
}

export default function ProjectDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState<ProjectEditForm | null>(null);
  const [nameTouched, setNameTouched] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [contentOpen, setContentOpen] = useState(false);

  const projectQuery = useQuery({
    queryKey: ['projects', 'detail', id],
    queryFn: () => getProject(id),
    enabled: id !== '',
  });

  // 内容区固定取 20 条：详情页只做概览，全量内容去内容看板看（那里有分页与筛选）
  const contentsQuery = useQuery({
    queryKey: ['contents', 'list', { projectId: id, pageSize: 20 }],
    queryFn: () => listContents({ projectId: id, pageSize: 20 }),
    enabled: id !== '',
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteProject(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['contents'] });
      toast.success(`项目已删除，${AUDIT_WRITTEN_HINT}`);
      // 当前 id 已不存在，必须回列表，否则页面会停在 404 错误态
      navigate('/projects', { replace: true });
    },
  });

  const updateMutation = useMutation({
    mutationFn: (body: UpdateProjectRequest) => updateProject(id, body),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast.success(`项目「${updated.name}」已更新，${AUDIT_WRITTEN_HINT}`);
      setEditOpen(false);
      setEditForm(null);
    },
  });

  const createContentMutation = useMutation({
    mutationFn: (body: CreateContentRequest) => createContent(body),
    onSuccess: (created) => {
      // 内容数/发布数变了，项目列表与详情都要刷新
      queryClient.invalidateQueries({ queryKey: ['contents'] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast.success(`内容「${created.title}」已创建，${AUDIT_WRITTEN_HINT}`);
      setContentOpen(false);
    },
  });

  if (projectQuery.isLoading) {
    return (
      <div className="page">
        <PageHeader title="项目详情" subtitle="加载中…" />
        <DetailSkeleton />
      </div>
    );
  }

  if (projectQuery.isError || !projectQuery.data) {
    return (
      <div className="page">
        <PageHeader title="项目详情" />
        <div className="card">
          <ErrorState
            message={resolveErrorMessage(projectQuery.error)}
            onRetry={() => void projectQuery.refetch()}
          />
        </div>
      </div>
    );
  }

  const project = projectQuery.data;

  const openEdit = () => {
    // 用详情数据灌初值：列表接口不返回 brief，详情才拿得到
    setEditForm({
      name: project.name,
      vertical: project.vertical ?? '',
      budget: project.budget,
      startDate: project.startDate ? formatDate(project.startDate) : '',
      dueDate: project.dueDate ? formatDate(project.dueDate) : '',
      brief: project.brief ?? '',
    });
    setNameTouched(false);
    setEditOpen(true);
  };

  const submitEdit = () => {
    if (!editForm) return;
    setNameTouched(true);
    if (editForm.name.trim() === '' || updateMutation.isPending) return;
    updateMutation.mutate({
      name: editForm.name.trim(),
      vertical: (editForm.vertical || undefined) as Vertical | undefined,
      budget: editForm.budget.trim() === '' ? '0' : editForm.budget.trim(),
      startDate: editForm.startDate || undefined,
      dueDate: editForm.dueDate || undefined,
      brief: editForm.brief.trim() || undefined,
    });
  };

  /** 展示用比较：实际成本是否超预算，只做提示不做金额运算 */
  const overBudget = (() => {
    const budget = Number(project.budget);
    const actual = Number(project.actualCost);
    return Number.isFinite(budget) && Number.isFinite(actual) && budget > 0 && actual > budget;
  })();

  const contentColumns: Column<ContentListItem>[] = [
    {
      key: 'title',
      title: '内容标题',
      minWidth: 220,
      render: (row) => (
        <button
          type="button"
          className="btnLink"
          onClick={(event) => {
            // 阻止冒泡：行点击也进详情，避免触发两次导航
            event.stopPropagation();
            navigate(`/contents/${row.id}`);
          }}
        >
          {row.title}
        </button>
      ),
    },
    {
      key: 'platform',
      title: '平台',
      width: 100,
      render: (row) => PLATFORM_LABELS[row.platform],
    },
    {
      key: 'status',
      title: '状态',
      width: 100,
      render: (row) => (
        <StatusTag tone={CONTENT_STATUS_TONES[row.status]}>{CONTENT_STATUS_LABELS[row.status]}</StatusTag>
      ),
    },
    {
      key: 'scheduledAt',
      title: '排期时间',
      width: 156,
      render: (row) => <span className="nowrap">{formatDateTime(row.scheduledAt)}</span>,
    },
    {
      key: 'publishedAt',
      title: '发布时间',
      width: 156,
      render: (row) => <span className="nowrap">{formatDateTime(row.publishedAt)}</span>,
    },
    {
      key: 'viewCount',
      title: '播放',
      width: 92,
      align: 'right',
      // 互动数据是字符串（大 V 播放量会超安全整数），只格式化不参与运算
      render: (row) => <span className="mono">{formatCount(row.viewCount)}</span>,
    },
    {
      key: 'engagement',
      title: '互动（赞/评）',
      width: 130,
      align: 'right',
      render: (row) => (
        <span className="mono">
          {formatCount(row.likeCount)} / {formatCount(row.commentCount)}
        </span>
      ),
    },
    {
      key: 'revenueYuan',
      title: '营收（元）',
      width: 120,
      align: 'right',
      render: (row) => <MoneyText value={row.revenueYuan} variant="plain" />,
    },
    {
      key: 'complianceScore',
      title: '合规分',
      width: 96,
      align: 'right',
      tooltip: '后端合规检测得分，分数越高越安全；未检测时为空',
      render: (row) =>
        row.complianceScore === null ? (
          <span className="subtle">未检测</span>
        ) : (
          <span className="mono">{row.complianceScore}</span>
        ),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title={
          <span className="row" style={{ gap: 'var(--space-2)' }}>
            {project.name}
            <StatusTag tone={PROJECT_STATUS_TONES[project.status]}>
              {PROJECT_STATUS_LABELS[project.status]}
            </StatusTag>
          </span>
        }
        subtitle={
          <span className="row wrap" style={{ gap: 'var(--space-2)' }}>
            <span className="mono">{project.code}</span>
            <span>·</span>
            <span>
              {project.brandName ?? '未关联品牌'} / {project.creatorName ?? '未关联达人'}
            </span>
          </span>
        }
        actions={
          <>
            <PermissionGate permission={P.PROJECT_WRITE}>
              <button type="button" className="btn" onClick={openEdit}>
                编辑项目
              </button>
            </PermissionGate>
            <PermissionGate permission={P.PROJECT_WRITE}>
              <button type="button" className="btn btnDanger" onClick={() => setDeleteOpen(true)}>
                删除项目
              </button>
            </PermissionGate>
          </>
        }
      />

      <section className="card">
        <div className="cardHeader">
          <span className="cardTitle">项目信息</span>
          <span className="subtle" style={{ fontSize: 'var(--font-size-xs)' }}>
            金额为后端下发的字符串元，前端只展示
          </span>
        </div>
        <div className="cardBody">
          <dl className="descriptions">
            <div className="descriptionsItem">
              <dt>项目编号</dt>
              <dd className="mono">{project.code}</dd>
            </div>
            <div className="descriptionsItem">
              <dt>状态</dt>
              <dd>
                <StatusTag tone={PROJECT_STATUS_TONES[project.status]}>
                  {PROJECT_STATUS_LABELS[project.status]}
                </StatusTag>
              </dd>
            </div>
            <div className="descriptionsItem">
              <dt>垂类</dt>
              <dd>{project.vertical ? verticalLabel(project.vertical) : '—'}</dd>
            </div>
            <div className="descriptionsItem">
              <dt>品牌</dt>
              <dd>{project.brandName ?? '—'}</dd>
            </div>
            <div className="descriptionsItem">
              <dt>达人</dt>
              <dd>{project.creatorName ?? '—'}</dd>
            </div>
            <div className="descriptionsItem">
              <dt>负责人</dt>
              <dd>{project.ownerName ?? '—'}</dd>
            </div>
            <div className="descriptionsItem">
              <dt>预算（元）</dt>
              <dd>
                <MoneyText value={project.budget} variant="plain" />
              </dd>
            </div>
            <div className="descriptionsItem">
              <dt>实际成本（元）</dt>
              <dd>
                <span style={overBudget ? { color: 'var(--color-money-negative)' } : undefined}>
                  <MoneyText value={project.actualCost} variant="plain" />
                </span>
                {overBudget && (
                  <span className="subtle" style={{ marginLeft: 'var(--space-2)' }}>
                    已超预算
                  </span>
                )}
              </dd>
            </div>
            <div className="descriptionsItem">
              <dt>起止日期</dt>
              <dd>
                {formatDate(project.startDate)} ~ {formatDate(project.dueDate)}
              </dd>
            </div>
            <div className="descriptionsItem">
              <dt>内容进度</dt>
              <dd>
                已发布 {project.publishedCount} / 共 {project.contentCount} 条
              </dd>
            </div>
            <div className="descriptionsItem">
              <dt>创建时间</dt>
              <dd>{formatDateTime(project.createdAt)}</dd>
            </div>
            <div className="descriptionsItem">
              <dt>更新时间</dt>
              <dd>{formatDateTime(project.updatedAt)}</dd>
            </div>
            <div className="descriptionsItem" style={{ gridColumn: '1 / -1' }}>
              <dt>项目 brief</dt>
              <dd style={{ whiteSpace: 'pre-wrap' }}>{project.brief ?? '—'}</dd>
            </div>
          </dl>
        </div>
      </section>

      <section>
        <div className="rowBetween" style={{ margin: 'var(--space-5) 0 var(--space-3)' }}>
          <h2 className="sectionTitle" style={{ margin: 0 }}>
            内容列表（最近 20 条）
          </h2>
          <div className="row">
            <button type="button" className="btn btnSm" onClick={() => navigate('/contents')}>
              去内容看板
            </button>
            <PermissionGate permission={P.CONTENT_WRITE}>
              <button type="button" className="btn btnSm btnPrimary" onClick={() => setContentOpen(true)}>
                新建内容
              </button>
            </PermissionGate>
          </div>
        </div>

        <DataTable<ContentListItem>
          columns={contentColumns}
          rows={contentsQuery.data?.items ?? []}
          rowKey={(row) => row.id}
          loading={contentsQuery.isLoading}
          error={contentsQuery.isError ? resolveErrorMessage(contentsQuery.error) : null}
          onRetry={() => void contentsQuery.refetch()}
          emptyTitle="该项目下还没有内容"
          emptyDescription="内容挂在项目下，才能统计投放进度与结算归属"
          emptyAction={
            <PermissionGate permission={P.CONTENT_WRITE}>
              <button type="button" className="btn btnPrimary" onClick={() => setContentOpen(true)}>
                新建内容
              </button>
            </PermissionGate>
          }
          onRowClick={(row) => navigate(`/contents/${row.id}`)}
        />
      </section>

      {/* ---------------- 编辑项目 ---------------- */}
      <Modal
        open={editOpen && editForm !== null}
        title={`编辑项目「${project.name}」`}
        description="状态可直接调整；金额按字符串元提交，前端不做运算"
        size="lg"
        onClose={updateMutation.isPending ? () => undefined : () => setEditOpen(false)}
        footer={
          <>
            <button
              type="button"
              className="btn"
              onClick={() => setEditOpen(false)}
              disabled={updateMutation.isPending}
            >
              取消
            </button>
            <button
              type="button"
              className="btn btnPrimary"
              onClick={submitEdit}
              disabled={updateMutation.isPending}
            >
              {updateMutation.isPending && <span className="spinner" aria-hidden="true" />}
              保存修改
            </button>
          </>
        }
      >
        {editForm && (
          <div className="formGrid">
            <div className="field">
              <label className="label labelRequired" htmlFor="edit-project-name">
                项目名称
              </label>
              <input
                id="edit-project-name"
                className={`input ${nameTouched && editForm.name.trim() === '' ? 'inputError' : ''}`}
                value={editForm.name}
                onChange={(event) => setEditForm({ ...editForm, name: event.target.value })}
                onBlur={() => setNameTouched(true)}
              />
              {nameTouched && editForm.name.trim() === '' && (
                <span className="errorText">项目名称不能为空</span>
              )}
            </div>

            <div className="field">
              <label className="label" htmlFor="edit-project-brief">
                项目 brief
              </label>
              <textarea
                id="edit-project-brief"
                className="input"
                rows={4}
                value={editForm.brief}
                onChange={(event) => setEditForm({ ...editForm, brief: event.target.value })}
              />
              <span className="hint">内容方向、交付要求、注意事项；项目状态请用页面顶部的流转按钮变更</span>
            </div>

            <div className="field">
              <label className="label" htmlFor="edit-project-vertical">
                垂类
              </label>
              <select
                id="edit-project-vertical"
                className="select"
                value={editForm.vertical}
                onChange={(event) => setEditForm({ ...editForm, vertical: event.target.value })}
              >
                <option value="">未指定</option>
                {VERTICAL_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label className="label" htmlFor="edit-project-budget">
                预算（元）
              </label>
              <input
                id="edit-project-budget"
                className="input"
                inputMode="decimal"
                value={editForm.budget}
                onChange={(event) => setEditForm({ ...editForm, budget: event.target.value })}
              />
            </div>

            <div className="field">
              <label className="label" htmlFor="edit-project-start">
                开始日期
              </label>
              <input
                id="edit-project-start"
                type="date"
                className="input"
                value={editForm.startDate}
                onChange={(event) => setEditForm({ ...editForm, startDate: event.target.value })}
              />
            </div>

            <div className="field">
              <label className="label" htmlFor="edit-project-due">
                结束日期
              </label>
              <input
                id="edit-project-due"
                type="date"
                className="input"
                value={editForm.dueDate}
                min={editForm.startDate || undefined}
                onChange={(event) => setEditForm({ ...editForm, dueDate: event.target.value })}
              />
            </div>
          </div>
        )}
      </Modal>

      {/* ---------------- 删除项目 ---------------- */}
      <ConfirmDialog
        open={deleteOpen}
        title="删除项目"
        danger
        confirmText="删除项目并返回列表"
        loading={deleteMutation.isPending}
        message={
          <>
            将删除项目「{project.name}」（{project.code}）及其关联关系。
            <br />
            该项目下已有 {project.contentCount} 条内容，若后端判定存在内容会拒绝删除；
            删除成功后将自动返回项目列表。
          </>
        }
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => deleteMutation.mutate()}
      />

      {/* ---------------- 新建内容 ---------------- */}
      <NewContentModal
        key={project.id}
        open={contentOpen}
        projectId={project.id}
        projectName={project.name}
        defaultCreatorId={project.creatorId ?? ''}
        pending={createContentMutation.isPending}
        onClose={() => setContentOpen(false)}
        onSubmit={(body) => createContentMutation.mutate(body)}
      />
    </div>
  );
}

/* ============================================================
   新建内容弹窗
   ============================================================ */

interface NewContentForm {
  title: string;
  creatorId: string;
  platform: string;
  scheduledAt: string;
  status: ContentStatus;
}

/**
 * 后端只接受这两种初始状态（content.service.ts 的 allowedInitialStatuses）。
 * 写成 ContentStatus[] 而不是裸数组，这样后端要是改了枚举，这里会编译报错而不是运行时 422。
 */
const CREATE_CONTENT_INITIAL_STATUSES: ContentStatus[] = ['IDEA', 'SCRIPTING'];

interface NewContentModalProps {
  open: boolean;
  projectId: string;
  projectName: string;
  /** 项目上已关联达人时预填，减少一次复制粘贴 */
  defaultCreatorId: string;
  pending: boolean;
  onClose: () => void;
  onSubmit: (body: CreateContentRequest) => void;
}

function NewContentModal({
  open,
  projectId,
  projectName,
  defaultCreatorId,
  pending,
  onClose,
  onSubmit,
}: NewContentModalProps) {
  const [form, setForm] = useState<NewContentForm>({
    title: '',
    creatorId: defaultCreatorId,
    platform: 'DOUYIN',
    scheduledAt: '',
    // 新建内容默认「选题」：后端只允许 IDEA / SCRIPTING 两种初始状态
    // （其余状态都隐含「已经过某道工序」，必须走状态流转接口）
    status: 'IDEA',
  });
  const [touched, setTouched] = useState(false);

  const titleInvalid = form.title.trim() === '';
  const creatorInvalid = form.creatorId.trim() === '';
  const invalid = titleInvalid || creatorInvalid;

  const submit = () => {
    setTouched(true);
    if (invalid || pending) return;
    onSubmit({
      title: form.title.trim(),
      // 达人必填：内容分成要按达人结算，没有达人归属的流水无法入账
      creatorId: form.creatorId.trim(),
      projectId,
      platform: form.platform as CreateContentRequest['platform'],
      status: form.status,
      // 未排期的内容不带 scheduledAt：空串会被后端当成非法日期
      scheduledAt: form.scheduledAt || undefined,
    });
  };

  return (
    <Modal
      open={open}
      title="新建内容"
      description={`项目：${projectName}（内容将自动归属到该项目）`}
      onClose={pending ? () => undefined : onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={pending}>
            取消
          </button>
          <button type="button" className="btn btnPrimary" onClick={submit} disabled={pending}>
            {pending && <span className="spinner" aria-hidden="true" />}
            创建内容
          </button>
        </>
      }
    >
      <div className="formGrid">
        <div className="field fieldFull">
          <label className="label labelRequired" htmlFor="content-title">
            内容标题
          </label>
          <input
            id="content-title"
            className={`input ${touched && titleInvalid ? 'inputError' : ''}`}
            value={form.title}
            placeholder="例：洗碗布吸油实测｜3 个场景对比"
            onChange={(event) => setForm({ ...form, title: event.target.value })}
            onBlur={() => setTouched(true)}
          />
          {touched && titleInvalid && <span className="errorText">内容标题不能为空</span>}
        </div>

        <div className="field">
          <label className="label labelRequired" htmlFor="content-creator">
            达人 ID
          </label>
          <input
            id="content-creator"
            className={`input ${touched && creatorInvalid ? 'inputError' : ''}`}
            value={form.creatorId}
            placeholder="达人 id（结算归属用）"
            onChange={(event) => setForm({ ...form, creatorId: event.target.value })}
          />
          {touched && creatorInvalid && <span className="errorText">必须指定达人，否则无法结算</span>}
        </div>

        <div className="field">
          <label className="label labelRequired" htmlFor="content-platform">
            平台
          </label>
          <select
            id="content-platform"
            className="select"
            value={form.platform}
            onChange={(event) => setForm({ ...form, platform: event.target.value })}
          >
            {PLATFORM_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="label" htmlFor="content-scheduled">
            排期时间
          </label>
          <input
            id="content-scheduled"
            type="datetime-local"
            className="input"
            value={form.scheduledAt}
            onChange={(event) => setForm({ ...form, scheduledAt: event.target.value })}
          />
          <span className="hint">留空表示尚未排期，后续可在内容看板补</span>
        </div>

        <div className="field">
          <label className="label" htmlFor="content-status">
            初始状态
          </label>
          <select
            id="content-status"
            className="select"
            value={form.status}
            onChange={(event) => setForm({ ...form, status: event.target.value as ContentStatus })}
          >
            {CREATE_CONTENT_INITIAL_STATUSES.map((value) => (
              <option key={value} value={value}>
                {CONTENT_STATUS_LABELS[value]}
              </option>
            ))}
          </select>
          {/*
            只允许选这两个：后端 content.service 明确校验
            `allowedInitialStatuses = [IDEA, SCRIPTING]`，其余状态
            （拍摄/剪辑/审核/已发布/已驳回）都必须通过状态流转接口产生。
          */}
          <span className="hint">其余状态需经审核与发布流程推进</span>
        </div>
      </div>
    </Modal>
  );
}
