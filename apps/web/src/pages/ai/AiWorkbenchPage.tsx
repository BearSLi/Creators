import { useState, type ReactNode } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createAiTask, getAiTask, getAiUsage, listAiTasks, submitAiFeedback } from '@/api/ai';
import { resolveErrorMessage } from '@/api/client';
import type {
  AiTaskListItem,
  AiTaskType,
  ComplianceCheckOutput,
  CreatorMatchOutput,
  ScriptOutput,
} from '@/api/types';
import { isAiTaskInFlight } from '@/api/types';
import { DataTable, type Column } from '@/components/DataTable';
import { EmptyState, ErrorState } from '@/components/EmptyState';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';
import { Modal } from '@/components/Modal';
import { PageHeader } from '@/components/PageHeader';
import { PermissionGate } from '@/components/PermissionGate';
import { StatusTag } from '@/components/StatusTag';
import { AUDIT_WRITTEN_HINT, useToast } from '@/components/Toast';
import { useTableQuery } from '@/hooks/useTableQuery';
import {
  AI_TASK_INPUT_FIELDS,
  AI_TASK_STATUS_LABELS,
  AI_TASK_STATUS_TONES,
  AI_TASK_TYPE_LABELS,
  AI_TASK_TYPE_OPTIONS,
  COMPLIANCE_LEVEL_LABELS,
  COMPLIANCE_LEVEL_TONES,
  HUMAN_FEEDBACK_LABELS,
} from '@/utils/constants';
import {
  createIdempotencyKey,
  formatCents,
  formatDateTime,
  formatInteger,
  formatMs,
  formatPercentValue,
  formatScore,
  formatYuan,
} from '@/utils/format';
import { P } from '@/utils/permissions';

/**
 * AI 工作台。
 *
 * 这个页面的三个业务约束决定了它的形态：
 *   1) **AI 调用按 token 计费**：所以「提交」必须防重复（禁用按钮 + 幂等键双保险），
 *      并且每次产出都要把 tokens / 成本 / 耗时摆在用户面前，让他对"这条脚本花了多少钱"有感知；
 *   2) **生成是异步的**：后端可能返回 PENDING / RUNNING，页面必须轮询任务状态，
 *      否则用户看到的是空白，会反复点提交，进而重复计费；
 *   3) **产出结构随任务类型不同**：脚本要按时间轴看、合规要看分数与风险明细，
 *      统一丢 JSON 会让"面试官级别的产出"退化成调试工具，所以按 taskType 结构化渲染。
 *
 * 除此之外，页面底部保留「最近任务」：回看历史产出是零成本的，
 * 让用户不必为了看一眼上周的脚本再花一次 token。
 */

/** 提交时固化的参数：重新生成时必须复用，但幂等键要换新的 */
interface SubmitPayload {
  taskType: AiTaskType;
  input: Record<string, unknown>;
  creatorId?: string;
}

/**
 * 判断字段是否选填。
 *
 * constants 里的 AI_TASK_INPUT_FIELDS 只描述字段形状（没有 required 标记），
 * 页面又明确不允许改 utils，所以用 placeholder 中的「选填」约定推导必填：
 * 好处是 constants 新增任务类型/字段时页面一行都不用改（这就是"字段定义集中管理"的价值），
 * 代价是标注约定必须保持——已在字段注释里写清，属于可控的取舍。
 */
function isOptionalField(field: { placeholder?: string }): boolean {
  return (field.placeholder ?? '').includes('选填');
}

/** 单行键值展示：成本与效果卡片用，dt/dd 结构走全局 descriptions 类 */
function DescItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="descriptionsItem">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** 结果区：按任务类型分派渲染，未知类型退化 JSON，保证新增任务类型不会白屏 */
function TaskOutputView({ task }: { task: AiTaskListItem }) {
  if (task.taskType === 'SCRIPT_GENERATE') {
    const script = task.output as ScriptOutput | null;
    if (!script) return <div className="emptyInline">任务还没产出脚本内容</div>;
    return (
      <div className="stack">
        <div>
          <div className="sectionTitle">标题</div>
          <div style={{ fontWeight: 'var(--font-weight-semibold)' }}>{script.title}</div>
        </div>

        <div>
          <div className="sectionTitle">开场 Hook</div>
          <div className="muted">{script.hook}</div>
        </div>

        <div>
          <div className="sectionTitle">分镜时间轴</div>
          {(script.scenes ?? []).map((scene) => (
            <div key={scene.index} style={{ display: 'flex', gap: 'var(--space-3)' }}>
              {/* 左侧圆点 + 竖线：时间轴是"顺序"信息，用视觉轴表达比编号列表更快读懂 */}
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  width: 12,
                  flex: '0 0 auto',
                }}
              >
                <span
                  style={{
                    width: 10,
                    height: 10,
                    marginTop: 5,
                    borderRadius: '50%',
                    background: 'var(--color-primary-600)',
                  }}
                />
                <span style={{ flex: '1 1 auto', width: 2, background: 'var(--color-border)' }} />
              </div>
              <div
                style={{
                  flex: '1 1 auto',
                  minWidth: 0,
                  paddingBottom: 'var(--space-4)',
                }}
              >
                <div className="row" style={{ gap: 'var(--space-2)' }}>
                  <span className="mono" style={{ fontWeight: 'var(--font-weight-semibold)' }}>
                    {scene.timeRange}
                  </span>
                  <span className="muted">{scene.shot}</span>
                </div>
                <div style={{ marginTop: 'var(--space-1)' }}>{scene.voiceover}</div>
                {scene.note && <div className="hint">拍摄提示：{scene.note}</div>}
              </div>
            </div>
          ))}
        </div>

        {(script.hashtags ?? []).length > 0 && (
          <div>
            <div className="sectionTitle">话题标签</div>
            <div className="chipGroup">
              {script.hashtags.map((tag) => (
                <span key={tag} className="chip">
                  #{tag}
                </span>
              ))}
            </div>
          </div>
        )}

        {(script.risks ?? []).length > 0 && (
          <div>
            {/* 风险必须标红：这是发布前唯一的拦截机会，弱化成灰色提示等于没有提示 */}
            <div className="sectionTitle">风险提示</div>
            <ul>
              {script.risks.map((risk) => (
                <li key={risk} style={{ color: 'var(--color-danger)' }}>
                  · {risk}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  if (task.taskType === 'COMPLIANCE_CHECK') {
    const compliance = task.output as ComplianceCheckOutput | null;
    if (!compliance) return <div className="emptyInline">任务还没产出合规结论</div>;
    const flags = compliance.flags ?? [];
    return (
      <div className="stack">
        <div className="row" style={{ gap: 'var(--space-4)', alignItems: 'baseline' }}>
          <span
            style={{
              fontSize: 'var(--font-size-3xl)',
              fontWeight: 'var(--font-weight-bold)',
              lineHeight: 'var(--line-height-tight)',
            }}
          >
            {formatScore(compliance.score)}
          </span>
          <span className="muted">合规分（满分 100）</span>
          <StatusTag tone={COMPLIANCE_LEVEL_TONES[compliance.level]} dot>
            {COMPLIANCE_LEVEL_LABELS[compliance.level]}
          </StatusTag>
        </div>

        {flags.length === 0 ? (
          <div className="emptyInline">未发现需要修改的合规风险</div>
        ) : (
          flags.map((flag, index) => (
            <div
              key={`${flag.category}-${index}`}
              style={{
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-md)',
                padding: 'var(--space-3)',
              }}
            >
              <div className="rowBetween">
                <span style={{ fontWeight: 'var(--font-weight-medium)' }}>{flag.category}</span>
                <StatusTag tone={COMPLIANCE_LEVEL_TONES[flag.level]} size="sm">
                  {COMPLIANCE_LEVEL_LABELS[flag.level]}
                </StatusTag>
              </div>
              {/* 命中片段用等宽展示并保留原文：用户要能在脚本里 Ctrl+F 定位到这句话 */}
              <pre className="codeBlock" style={{ marginTop: 'var(--space-2)' }}>
                {flag.snippet}
              </pre>
              <div style={{ marginTop: 'var(--space-2)' }}>原因：{flag.reason}</div>
              <div className="muted">建议改为：{flag.suggestion}</div>
            </div>
          ))
        )}
      </div>
    );
  }

  if (task.taskType === 'CREATOR_MATCH') {
    const match = task.output as CreatorMatchOutput | null;
    const matches = match?.matches ?? [];
    if (matches.length === 0) {
      return <div className="emptyInline">没有匹配到达人，可放宽预算或垂类后重试</div>;
    }
    return (
      <div className="stack">
        {matches.map((item) => (
          <div
            key={item.creatorId}
            style={{
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)',
              padding: 'var(--space-3)',
            }}
          >
            <div className="rowBetween">
              <span style={{ fontWeight: 'var(--font-weight-semibold)' }}>{item.creatorName}</span>
              <StatusTag tone="primary" size="sm">
                匹配度 {formatScore(item.score)}
              </StatusTag>
            </div>
            {(item.reasons ?? []).length > 0 && (
              <ul style={{ marginTop: 'var(--space-2)' }}>
                {item.reasons.map((reason) => (
                  <li key={reason} style={{ color: 'var(--color-money-positive)' }}>
                    + {reason}
                  </li>
                ))}
              </ul>
            )}
            {(item.risks ?? []).length > 0 && (
              <ul>
                {item.risks.map((risk) => (
                  <li key={risk} style={{ color: 'var(--color-danger)' }}>
                    ! {risk}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    );
  }

  // 其余任务类型（标题优化 / 评论洞察 / 结算异常解释 / 运营日报）后端结构尚未定型，
  // 强行做结构化渲染会在后端调整字段时直接白屏，退化 JSON 是此时最稳的选择
  return <pre className="codeBlock">{JSON.stringify(task.output, null, 2)}</pre>;
}

export default function AiWorkbenchPage() {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [taskType, setTaskType] = useState<AiTaskType>('SCRIPT_GENERATE');
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [creatorId, setCreatorId] = useState('');
  const [activeTask, setActiveTask] = useState<AiTaskListItem | null>(null);
  const [activeTaskId, setActiveTaskId] = useState('');
  const [lastPayload, setLastPayload] = useState<SubmitPayload | null>(null);
  const [feedbackTarget, setFeedbackTarget] = useState<1 | -1 | null>(null);
  const [feedbackNote, setFeedbackNote] = useState('');

  /** 字段定义完全来自 constants：新增一种任务类型只需要改 constants，本页零改动 */
  const fields = AI_TASK_INPUT_FIELDS[taskType] ?? [];
  const missingRequired = fields.filter(
    (field) => !isOptionalField(field) && (inputValues[field.key] ?? '').trim() === '',
  );
  const canSubmit = missingRequired.length === 0;

  /* ---------------- 当月用量 ---------------- */

  const usageQuery = useQuery({
    queryKey: ['ai', 'usage'],
    queryFn: () => getAiUsage(),
  });

  const usage = usageQuery.data;
  // 提前把派生值算好：条形图需要一个统一的基准，放在 map 里逐行 Math.max 既慢又容易写成全 0 宽度
  const usageByType = usage?.byType ?? [];
  const maxUsageCount = Math.max(...usageByType.map((row) => row.count), 1);

  /* ---------------- 提交任务 ---------------- */

  const createMutation = useMutation({
    mutationFn: (payload: SubmitPayload) =>
      createAiTask({
        taskType: payload.taskType,
        input: payload.input,
        creatorId: payload.creatorId,
        // 幂等键在 mutationFn 内生成：每次真正发起都用新 key，而同一次调用的网络重试复用同一 key。
        // 后端据此识别"重复请求"并回放首次结果，避免用户连点导致重复计费。
        idempotencyKey: createIdempotencyKey(payload.taskType.toLowerCase()),
      }),
    onSuccess: (task, payload) => {
      setActiveTask(task);
      setActiveTaskId(task.id);
      setLastPayload(payload);
      queryClient.invalidateQueries({ queryKey: ['ai', 'usage'] });
      queryClient.invalidateQueries({ queryKey: ['ai', 'tasks'] });
      toast.success(`已提交「${AI_TASK_TYPE_LABELS[payload.taskType]}」任务，生成中请稍候`);
    },
  });

  /* ---------------- 轮询任务状态 ---------------- */

  // 用 string 而不是 null 作为 queryKey 的一部分，queryFn 里就不需要非空断言
  const taskId = activeTaskId;
  const taskQuery = useQuery({
    queryKey: ['ai', 'task', taskId],
    queryFn: () => getAiTask(taskId),
    enabled: taskId !== '',
    // 只在排队/生成中轮询：任务已终态还继续轮询会白白打后端，也让成本与耗时一闪一闪
    refetchInterval: (query) => (isAiTaskInFlight(query.state.data?.status) ? 2000 : false),
  });

  const currentTask = taskQuery.data ?? activeTask;

  /* ---------------- 反馈 ---------------- */

  const feedbackMutation = useMutation({
    mutationFn: (payload: { id: string; feedback: 1 | -1; note?: string }) =>
      submitAiFeedback(payload.id, { feedback: payload.feedback, note: payload.note }),
    onSuccess: (task) => {
      // 同时写回单个任务缓存与本地 state：否则 currentTask 会优先读到轮询缓存里的旧 humanFeedback
      queryClient.setQueryData(['ai', 'task', task.id], task);
      setActiveTask(task);
      setFeedbackTarget(null);
      setFeedbackNote('');
      queryClient.invalidateQueries({ queryKey: ['ai', 'tasks'] });
      toast.success(`反馈已记录，${AUDIT_WRITTEN_HINT}`);
    },
  });

  /* ---------------- 最近任务 ---------------- */

  const table = useTableQuery<Record<string, unknown>>({
    initialFilters: {},
    initialPageSize: 10,
    initialSort: { sortBy: 'createdAt', sortOrder: 'desc' },
  });

  const listQuery = useQuery({
    queryKey: ['ai', 'tasks', table.query],
    queryFn: () =>
      listAiTasks({
        page: table.query.page,
        pageSize: table.query.pageSize,
        sortBy: table.query.sortBy,
        sortOrder: table.query.sortOrder,
      }),
    placeholderData: keepPreviousData,
  });

  const taskColumns: Array<Column<AiTaskListItem>> = [
    {
      key: 'taskType',
      title: '任务类型',
      sortable: true,
      render: (row) => AI_TASK_TYPE_LABELS[row.taskType],
    },
    {
      key: 'status',
      title: '状态',
      render: (row) => (
        <StatusTag tone={AI_TASK_STATUS_TONES[row.status]} dot size="sm">
          {AI_TASK_STATUS_LABELS[row.status]}
        </StatusTag>
      ),
    },
    { key: 'model', title: '模型', render: (row) => <span className="mono">{row.model}</span> },
    {
      key: 'totalTokens',
      title: 'Tokens',
      align: 'right',
      sortable: true,
      render: (row) => <span className="mono">{formatInteger(row.totalTokens)}</span>,
    },
    {
      key: 'costCents',
      title: '成本',
      align: 'right',
      sortable: true,
      render: (row) => <span className="mono">{formatCents(row.costCents)}</span>,
    },
    {
      key: 'latencyMs',
      title: '耗时',
      align: 'right',
      sortable: true,
      render: (row) => <span className="mono">{formatMs(row.latencyMs)}</span>,
    },
    {
      key: 'humanFeedback',
      title: '反馈',
      render: (row) =>
        row.humanFeedback === null || row.humanFeedback === undefined ? (
          <span className="subtle">—</span>
        ) : (
          <StatusTag tone={row.humanFeedback === 1 ? 'success' : 'danger'} size="sm">
            {HUMAN_FEEDBACK_LABELS[String(row.humanFeedback)]}
          </StatusTag>
        ),
    },
    { key: 'requestedByName', title: '请求人', render: (row) => row.requestedByName },
    {
      key: 'createdAt',
      title: '时间',
      sortable: true,
      render: (row) => formatDateTime(row.createdAt),
    },
  ];

  /* ---------------- 交互 ---------------- */

  function handleTaskTypeChange(next: AiTaskType) {
    setTaskType(next);
    // 字段定义随任务类型变化，旧参数留着只会成为无效输入（后端可能因此报校验错，token 却已经花了）
    setInputValues({});
  }

  function handleSubmit() {
    const input: Record<string, unknown> = {};
    for (const field of fields) {
      const value = (inputValues[field.key] ?? '').trim();
      // 空值不发送：后端对空串会走校验分支，也不该把"没填"表达成"填了空"
      if (value !== '') input[field.key] = value;
    }
    createMutation.mutate({
      taskType,
      input,
      creatorId: creatorId.trim() === '' ? undefined : creatorId.trim(),
    });
  }

  function handleRegenerate() {
    if (!lastPayload || createMutation.isPending) return;
    // 重新生成必须换一个新的幂等键（mutationFn 每次调用都会新生成一个）：
    // 复用旧 key 会被后端判定为重复请求直接回放上一次的失败结果，重试永远不会真正执行。
    createMutation.mutate(lastPayload);
  }

  function handleFeedback(feedback: 1 | -1) {
    if (!currentTask || feedbackMutation.isPending) return;
    feedbackMutation.mutate({
      id: currentTask.id,
      feedback,
      note: feedbackNote.trim() === '' ? undefined : feedbackNote.trim(),
    });
  }

  return (
    <div className="page">
      <PageHeader
        title="AI 工作台"
        subtitle="脚本、标题、达人匹配、合规预检等能力集中入口；每次生成都按 token 计费，请先确认参数再提交"
      />

      {/* ---------------- 当月用量 ---------------- */}
      <div className="card">
        <div className="cardHeader">
          <span className="cardTitle">当月 AI 用量</span>
          <span className="hint">用量与预算用于避免月中就把额度用光，超支需要提前走审批</span>
        </div>
        <div className="cardBody">
          {usageQuery.isLoading && <LoadingSkeleton rows={3} columns={4} />}

          {usageQuery.isError && (
            <ErrorState
              message={resolveErrorMessage(usageQuery.error)}
              onRetry={() => {
                void usageQuery.refetch();
              }}
            />
          )}

          {usage && (
            <>
              <div className="rowBetween">
                <span className="muted">
                  已用 <strong className="mono">{formatYuan(usage.monthCny)}</strong> / 预算{' '}
                  <span className="mono">{formatYuan(usage.budgetCny)}</span>
                </span>
                <span className="mono">{formatPercentValue(usage.usedPercent)}</span>
              </div>

              {/* 进度条：接近预算上限时变红，这是"花超了要写说明"的预警 */}
              <div
                style={{
                  height: 8,
                  marginTop: 'var(--space-2)',
                  background: 'var(--color-bg-subtle)',
                  borderRadius: 'var(--radius-pill)',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${Math.min(100, Math.max(0, usage.usedPercent))}%`,
                    height: '100%',
                    background:
                      usage.usedPercent >= 90 ? 'var(--color-danger)' : 'var(--color-primary-600)',
                  }}
                />
              </div>

              <dl className="descriptions" style={{ marginTop: 'var(--space-4)' }}>
                <DescItem label="任务总数">{formatInteger(usage.totalTasks)}</DescItem>
                <DescItem label="成功 / 失败">
                  <span style={{ color: 'var(--color-money-positive)' }}>
                    {formatInteger(usage.succeeded)}
                  </span>
                  {' / '}
                  <span style={{ color: 'var(--color-danger)' }}>{formatInteger(usage.failed)}</span>
                </DescItem>
                <DescItem label="降级完成">{formatInteger(usage.fallback)}</DescItem>
                <DescItem label="平均耗时">{formatMs(usage.avgLatencyMs)}</DescItem>
                <DescItem label="采纳率">{formatPercentValue(usage.adoptionRate)}</DescItem>
              </dl>

              <div className="divider" />

              <div className="sectionTitle">按任务类型拆分</div>
              {usageByType.length === 0 ? (
                <div className="emptyInline">本月还没有 AI 调用记录</div>
              ) : (
                usageByType.map((item) => (
                  <div
                    key={item.taskType}
                    className="rowBetween"
                    style={{ padding: 'var(--space-1) 0' }}
                  >
                    <span style={{ flex: '0 0 110px' }}>{AI_TASK_TYPE_LABELS[item.taskType]}</span>
                    <span
                      style={{
                        flex: '1 1 auto',
                        height: 6,
                        margin: '0 var(--space-3)',
                        background: 'var(--color-bg-subtle)',
                        borderRadius: 'var(--radius-pill)',
                        overflow: 'hidden',
                      }}
                    >
                      <span
                        style={{
                          display: 'block',
                          width: `${Math.round((item.count / maxUsageCount) * 100)}%`,
                          height: '100%',
                          background: 'var(--color-primary-500)',
                        }}
                      />
                    </span>
                    <span className="muted nowrap" style={{ flex: '0 0 70px' }}>
                      {formatInteger(item.count)} 次
                    </span>
                    <span className="mono nowrap" style={{ flex: '0 0 90px' }}>
                      {formatCents(item.costCents)}
                    </span>
                  </div>
                ))
              )}
            </>
          )}
        </div>
      </div>

      {/* ---------------- 左：参数表单 / 右：结果 ---------------- */}
      <div className="grid gridCols2" style={{ marginTop: 'var(--space-4)' }}>
        <div>
          <div className="card">
            <div className="cardHeader">
              <span className="cardTitle">1. 选择任务类型</span>
            </div>
            <div className="cardBody">
              <div className="chipGroup">
                {AI_TASK_TYPE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`chip ${taskType === option.value ? 'chipActive' : ''}`}
                    aria-pressed={taskType === option.value}
                    onClick={() => handleTaskTypeChange(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="cardHeader">
              <span className="cardTitle">2. 填写参数</span>
              <span className="hint">字段随任务类型自动切换</span>
            </div>
            <div className="cardBody">
              <div className="stack">
                {fields.map((field) => (
                  <div className="field" key={field.key}>
                    <label
                      className={`label ${isOptionalField(field) ? '' : 'labelRequired'}`}
                      htmlFor={`ai-field-${field.key}`}
                    >
                      {field.label}
                    </label>

                    {field.type === 'textarea' && (
                      <textarea
                        id={`ai-field-${field.key}`}
                        className="textarea"
                        rows={4}
                        placeholder={field.placeholder}
                        value={inputValues[field.key] ?? ''}
                        onChange={(event) =>
                          setInputValues((prev) => ({ ...prev, [field.key]: event.target.value }))
                        }
                      />
                    )}

                    {field.type === 'select' && (
                      <select
                        id={`ai-field-${field.key}`}
                        className="select"
                        value={inputValues[field.key] ?? ''}
                        onChange={(event) =>
                          setInputValues((prev) => ({ ...prev, [field.key]: event.target.value }))
                        }
                      >
                        <option value="">请选择</option>
                        {(field.options ?? []).map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    )}

                    {(!field.type || field.type === 'text') && (
                      <input
                        id={`ai-field-${field.key}`}
                        className="input"
                        type="text"
                        placeholder={field.placeholder}
                        value={inputValues[field.key] ?? ''}
                        onChange={(event) =>
                          setInputValues((prev) => ({ ...prev, [field.key]: event.target.value }))
                        }
                      />
                    )}

                    {field.placeholder && <span className="hint">{field.placeholder}</span>}
                  </div>
                ))}

                <div className="field">
                  <label className="label" htmlFor="ai-field-creatorId">
                    关联达人 ID（选填）
                  </label>
                  <input
                    id="ai-field-creatorId"
                    className="input"
                    type="text"
                    placeholder="填写达人 UUID 后，AI 会读取该达人档案作为人设与历史数据参考"
                    value={creatorId}
                    onChange={(event) => setCreatorId(event.target.value)}
                  />
                  <span className="hint">
                    带达人上下文的结果更贴合人设，但会把档案内容一并计入 prompt token，成本略高。
                  </span>
                </div>

                {createMutation.isPending && (
                  <div className="hint">正在提交，请勿重复点击：重复提交会产生额外费用。</div>
                )}

                {!canSubmit && !createMutation.isPending && (
                  <div className="hint">
                    还有 {missingRequired.length} 个必填参数未填写：
                    {missingRequired.map((field) => field.label).join('、')}
                  </div>
                )}

                <button
                  type="button"
                  className="btn btnPrimary btnBlock"
                  // 双保险：按钮禁用挡住"用户连点"，后端幂等键挡住"网络重试/浏览器重放"
                  disabled={createMutation.isPending || !canSubmit}
                  onClick={handleSubmit}
                >
                  {createMutation.isPending && <span className="spinner" aria-hidden="true" />}
                  提交生成
                </button>
              </div>
            </div>
          </div>
        </div>

        <div>
          <div className="card">
            <div className="cardHeader">
              <span className="cardTitle">生成结果</span>
              {currentTask && (
                <StatusTag tone={AI_TASK_STATUS_TONES[currentTask.status]} dot>
                  {AI_TASK_STATUS_LABELS[currentTask.status]}
                </StatusTag>
              )}
            </div>
            <div className="cardBody">
              {taskId === '' && !currentTask && (
                <EmptyState
                  title="还没有生成内容"
                  description="在左侧选择任务类型、填写参数后提交；也可以直接点击下方最近任务回看历史产出。"
                  compact
                />
              )}

              {taskId !== '' && taskQuery.isLoading && !currentTask && (
                <LoadingSkeleton rows={4} columns={2} />
              )}

              {taskQuery.isError && (
                <ErrorState
                  message={resolveErrorMessage(taskQuery.error)}
                  onRetry={() => {
                    void taskQuery.refetch();
                  }}
                />
              )}

              {currentTask && currentTask.status === 'FAILED' && (
                <div
                  style={{
                    marginBottom: 'var(--space-3)',
                    padding: 'var(--space-3)',
                    background: 'var(--color-danger-bg)',
                    border: '1px solid var(--color-danger-border)',
                    borderRadius: 'var(--radius-md)',
                  }}
                >
                  <div className="rowBetween">
                    <span>
                      生成失败：{currentTask.fallbackReason ?? '后端未返回失败原因，可查看审计日志'}
                    </span>
                    {/* 列表接口不回传原始参数，因此只有本次会话提交过的任务能一键重试 */}
                    {lastPayload !== null && (
                      <button
                        type="button"
                        className="btn btnSm"
                        disabled={createMutation.isPending}
                        onClick={handleRegenerate}
                      >
                        {createMutation.isPending && <span className="spinner" aria-hidden="true" />}
                        重新生成
                      </button>
                    )}
                  </div>
                  <div className="hint">
                    {lastPayload === null
                      ? '历史任务不保留原始参数，请回到左侧重新填写后提交。'
                      : '重新生成会创建新任务并重新计费（幂等键已更换，否则后端会回放这次失败结果）。'}
                  </div>
                </div>
              )}

              {currentTask && isAiTaskInFlight(currentTask.status) && (
                <div className="emptyInline">
                  正在生成中，页面每 2 秒自动刷新一次状态，无需手动刷新。
                </div>
              )}

              {currentTask && <TaskOutputView task={currentTask} />}
            </div>
          </div>

          {currentTask && (
            <div className="card">
              <div className="cardHeader">
                <span className="cardTitle">成本与效果</span>
              </div>
              <div className="cardBody">
                <dl className="descriptions">
                  <DescItem label="Prompt tokens">
                    <span className="mono">{formatInteger(currentTask.promptTokens)}</span>
                  </DescItem>
                  <DescItem label="Completion tokens">
                    <span className="mono">{formatInteger(currentTask.completionTokens)}</span>
                  </DescItem>
                  <DescItem label="总 tokens">
                    <span className="mono">{formatInteger(currentTask.totalTokens)}</span>
                  </DescItem>
                  <DescItem label="本次成本">
                    <span className="mono">{formatCents(currentTask.costCents)}</span>
                  </DescItem>
                  <DescItem label="耗时">
                    <span className="mono">{formatMs(currentTask.latencyMs)}</span>
                  </DescItem>
                  <DescItem label="服务商 / 模型">
                    <span className="mono">
                      {currentTask.provider} / {currentTask.model}
                    </span>
                  </DescItem>
                  <DescItem label="重试次数">{formatInteger(currentTask.retryCount)}</DescItem>
                  <DescItem label="降级原因">
                    {currentTask.fallbackReason ?? <span className="subtle">—</span>}
                  </DescItem>
                  <DescItem label="请求人">{currentTask.requestedByName}</DescItem>
                  <DescItem label="创建时间">{formatDateTime(currentTask.createdAt)}</DescItem>
                </dl>
              </div>
            </div>
          )}

          {currentTask && (
            <div className="card">
              <div className="cardHeader">
                <span className="cardTitle">结果反馈</span>
                <span className="hint">反馈进入模型效果评估，用于 Prompt 调优</span>
              </div>
              <div className="cardBody">
                {currentTask.humanFeedback !== null && currentTask.humanFeedback !== undefined && (
                  <div className="row" style={{ marginBottom: 'var(--space-2)' }}>
                    <StatusTag tone={currentTask.humanFeedback === 1 ? 'success' : 'danger'} dot>
                      {HUMAN_FEEDBACK_LABELS[String(currentTask.humanFeedback)]}
                    </StatusTag>
                    <span className="hint">已提交反馈，不能重复提交（避免污染模型效果评估）</span>
                  </div>
                )}
                <PermissionGate permission={P.AI_FEEDBACK}>
                  <div className="row wrap">
                    <button
                      type="button"
                      className="btn btnPrimary"
                      // 已反馈后按钮保留但禁用：保留按钮能让用户知道"这个动作存在过、是我做过的"
                      disabled={
                        feedbackMutation.isPending ||
                        currentTask.humanFeedback !== null ||
                        currentTask.humanFeedback !== undefined
                      }
                      onClick={() => {
                        setFeedbackNote('');
                        setFeedbackTarget(1);
                      }}
                    >
                      采纳
                    </button>
                    <button
                      type="button"
                      className="btn btnDanger"
                      disabled={
                        feedbackMutation.isPending ||
                        currentTask.humanFeedback !== null ||
                        currentTask.humanFeedback !== undefined
                      }
                      onClick={() => {
                        setFeedbackNote('');
                        setFeedbackTarget(-1);
                      }}
                    >
                      拒绝
                    </button>
                    {currentTask.humanFeedback === null && (
                      <span className="hint">
                        拒绝时建议写明原因，便于定位是 Prompt 还是模型能力问题
                      </span>
                    )}
                  </div>
                </PermissionGate>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ---------------- 最近任务 ---------------- */}
      <div style={{ marginTop: 'var(--space-4)' }}>
        <DataTable<AiTaskListItem>
          columns={taskColumns}
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
          // 点击回看历史产出：这样用户不必为了看一眼上周结果再花一次 token
          onRowClick={(row) => {
            setActiveTask(row);
            setActiveTaskId(row.id);
          }}
          page={table.query.page}
          pageSize={table.query.pageSize}
          total={listQuery.data?.total}
          totalPages={listQuery.data?.totalPages}
          onPageChange={table.setPage}
          onPageSizeChange={table.setPageSize}
          pageSizeOptions={table.pageSizeOptions}
          emptyTitle="暂无 AI 任务"
          emptyDescription="在工作台提交一次生成后，这里会保留全部历史任务与成本记录"
          stickyHeader
        />
      </div>

      {/* ---------------- 反馈弹窗 ---------------- */}
      <Modal
        open={feedbackTarget !== null}
        title={feedbackTarget === 1 ? '采纳这条结果' : '拒绝这条结果'}
        description="反馈会与本次 Prompt、模型、成本一起写入审计日志"
        size="sm"
        onClose={() => {
          setFeedbackTarget(null);
          setFeedbackNote('');
        }}
        footer={
          <>
            <button
              type="button"
              className="btn"
              disabled={feedbackMutation.isPending}
              onClick={() => setFeedbackTarget(null)}
            >
              取消
            </button>
            <button
              type="button"
              className={`btn ${feedbackTarget === 1 ? 'btnPrimary' : 'btnDanger'}`}
              disabled={feedbackMutation.isPending}
              onClick={() => {
                if (feedbackTarget !== null) handleFeedback(feedbackTarget);
              }}
            >
              {feedbackMutation.isPending && <span className="spinner" aria-hidden="true" />}
              提交反馈
            </button>
          </>
        }
      >
        <div className="field">
          <label className="label" htmlFor="ai-feedback-note">
            补充说明（选填）
          </label>
          <textarea
            id="ai-feedback-note"
            className="textarea"
            rows={3}
            placeholder="例：分镜节奏偏慢，前 3 秒没有冲突；或标题党过头，客户不会接受"
            value={feedbackNote}
            onChange={(event) => setFeedbackNote(event.target.value)}
          />
          <span className="hint">写得越具体，后续 Prompt 调优越有依据。</span>
        </div>
      </Modal>
    </div>
  );
}
