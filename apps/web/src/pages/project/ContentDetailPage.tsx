import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/PageHeader';
import { StatCard } from '@/components/StatCard';
import { Modal } from '@/components/Modal';
import { StatusTag } from '@/components/StatusTag';
import { MoneyText } from '@/components/MoneyText';
import { DetailSkeleton } from '@/components/LoadingSkeleton';
import { ErrorState } from '@/components/EmptyState';
import { PermissionGate } from '@/components/PermissionGate';
import { useToast, AUDIT_WRITTEN_HINT } from '@/components/Toast';
import { getContent, publishContent, reviewContent, syncContentMetrics } from '@/api/contents';
import { createAiTask, getAiTask, submitAiFeedback } from '@/api/ai';
import type {
  AiTaskListItem,
  ComplianceCheckOutput,
  ComplianceFlag,
  ComplianceLevel,
  ScriptOutput,
} from '@/api/types';
import { isAiTaskInFlight } from '@/api/types';
import { resolveErrorMessage } from '@/api/client';
import {
  AI_TASK_STATUS_LABELS,
  AI_TASK_STATUS_TONES,
  COMPLIANCE_LEVEL_LABELS,
  COMPLIANCE_LEVEL_TONES,
  CONTENT_STATUS_LABELS,
  CONTENT_STATUS_TONES,
  PLATFORM_LABELS,
  VERTICAL_OPTIONS,
} from '@/utils/constants';
import {
  createIdempotencyKey,
  formatCents,
  formatCount,
  formatDateTime,
  formatMs,
  formatPercentValue,
} from '@/utils/format';
import { P } from '@/utils/permissions';

/**
 * 内容详情：内容审核的"一站式"页面。
 *
 * 这里承担三件事，且顺序就是审核员的真实工作流：
 *   1) 看清这条内容是什么、数据表现如何（基础信息 + 数据表现）；
 *   2) 用 AI 生成/优化脚本，并把 token 成本摊在明面上（AI 脚本生成）；
 *   3) 上线前做合规预检，把风险句、原因、改法逐条列出来（合规预检）；
 *   4) 最后才是审核与发布动作。
 *
 * 三个关键取舍：
 *   - AI 调用带 idempotencyKey：网络抖动重试、用户连点都不会重复计费；
 *     重试（FAILED 后）**必须换新的 key**——同 key 会被后端判定为同一次请求，
 *     直接返回上次的失败结果，用户会觉得"点了重试没反应"；
 *   - 调用按钮 disabled + spinner：AI 是按 token 计费的，重复点击就是重复花钱；
 *   - 脚本展示用时间轴卡片而不是 JSON：审核员要看的是"第几秒说什么"，
 *     JSON 只能证明接口通了，不能帮人改稿。
 */

/** AI 脚本生成的输入表单：字段与后端 SCRIPT_GENERATE 的 input 约定一致 */
interface ScriptBriefForm {
  brief: string;
  vertical: string;
  platform: string;
  duration: string;
  tone: string;
  creatorName: string;
}

export default function ContentDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [briefForm, setBriefForm] = useState<ScriptBriefForm>({
    brief: '',
    vertical: '',
    platform: '',
    duration: '60s',
    tone: '',
    creatorName: '',
  });

  /** 只存 taskId，任务详情交给 react-query 轮询；存整个对象会在轮询时产生两份状态 */
  const [scriptTaskId, setScriptTaskId] = useState<string | null>(null);
  const [complianceTaskId, setComplianceTaskId] = useState<string | null>(null);

  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewApproved, setReviewApproved] = useState(true);
  const [reviewNote, setReviewNote] = useState('');
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishForm, setPublishForm] = useState({ publishedUrl: '', platformContentId: '' });

  const contentQuery = useQuery({
    queryKey: ['contents', 'detail', id],
    queryFn: () => getContent(id),
    enabled: id !== '',
  });

  /**
   * AI 任务轮询。
   * react-query v5 的 refetchInterval 支持 (query) => number | false，
   * 用它按"任务是否还在跑"决定要不要继续轮询：任务落地后自动停，
   * 否则列表切走再切回会一直空转打接口。
   */
  const scriptTaskQuery = useQuery({
    queryKey: ['ai', 'task', scriptTaskId],
    queryFn: () => getAiTask(scriptTaskId ?? ''),
    enabled: scriptTaskId !== null,
    refetchInterval: (query) => (isAiTaskInFlight(query.state.data?.status) ? 2000 : false),
  });

  const complianceTaskQuery = useQuery({
    queryKey: ['ai', 'task', complianceTaskId],
    queryFn: () => getAiTask(complianceTaskId ?? ''),
    enabled: complianceTaskId !== null,
    refetchInterval: (query) => (isAiTaskInFlight(query.state.data?.status) ? 2000 : false),
  });

  const scriptMutation = useMutation({
    mutationFn: (input: ScriptBriefForm) =>
      createAiTask({
        taskType: 'SCRIPT_GENERATE',
        creatorId: id,
        input: { ...input },
        // 幂等键前缀区分任务类型：便于后端按前缀排查"哪类任务被重复提交"
        idempotencyKey: createIdempotencyKey('script'),
      }),
    onSuccess: (task) => {
      setScriptTaskId(task.id);
      queryClient.invalidateQueries({ queryKey: ['ai', 'tasks'] });
      toast.success('脚本生成任务已提交，完成后会在这里展示');
    },
  });

  const complianceMutation = useMutation({
    mutationFn: (payload: { text: string; platform: string }) =>
      createAiTask({
        taskType: 'COMPLIANCE_CHECK',
        creatorId: id,
        input: { text: payload.text, platform: payload.platform },
        idempotencyKey: createIdempotencyKey('compliance'),
      }),
    onSuccess: (task) => {
      setComplianceTaskId(task.id);
      queryClient.invalidateQueries({ queryKey: ['ai', 'tasks'] });
      toast.success('合规预检任务已提交，完成后会在这里展示');
    },
  });

  /** 采纳 / 拒绝：反馈会进模型评估，缺少它就无法判断 AI 到底有没有用 */
  const feedbackMutation = useMutation({
    mutationFn: (payload: { taskId: string; feedback: 1 | -1 }) =>
      submitAiFeedback(payload.taskId, { feedback: payload.feedback }),
    onSuccess: (task) => {
      // 反馈改变了任务的 humanFeedback，刷新对应查询让按钮状态立刻更新
      queryClient.invalidateQueries({ queryKey: ['ai', 'task', task.id] });
      toast.success(`已记录${task.humanFeedback === 1 ? '采纳' : '拒绝'}反馈，${AUDIT_WRITTEN_HINT}`);
    },
  });

  const syncMutation = useMutation({
    mutationFn: () => syncContentMetrics(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contents'] });
      toast.success('数据同步已提交，稍后刷新即可看到最新互动数据');
    },
    // 同步接口可能被上游限流（后端返回 RATE_LIMITED），这里单独提示"稍后再试"而不是通用报错
    onError: (error) => {
      toast.warning(`${resolveErrorMessage(error)}（数据同步受上游限流影响，请稍后再试）`);
    },
  });

  const reviewMutation = useMutation({
    mutationFn: (payload: { approved: boolean; note: string }) =>
      reviewContent(id, {
        approved: payload.approved,
        note: payload.approved ? payload.note.trim() || undefined : undefined,
        rejectReason: payload.approved ? undefined : payload.note.trim(),
      }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['contents'] });
      toast.success(`内容已${variables.approved ? '通过审核' : '驳回'}，${AUDIT_WRITTEN_HINT}`);
      setReviewOpen(false);
    },
  });

  const publishMutation = useMutation({
    mutationFn: (payload: { publishedUrl: string; platformContentId: string }) =>
      publishContent(id, {
        publishedUrl: payload.publishedUrl.trim() || undefined,
        platformContentId: payload.platformContentId.trim() || undefined,
        publishedAt: new Date().toISOString(),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contents'] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast.success(`内容已标记发布，${AUDIT_WRITTEN_HINT}`);
      setPublishOpen(false);
    },
  });

  if (contentQuery.isLoading) {
    return (
      <div className="page">
        <PageHeader title="内容详情" subtitle="加载中…" />
        <DetailSkeleton />
      </div>
    );
  }

  if (contentQuery.isError || !contentQuery.data) {
    return (
      <div className="page">
        <PageHeader title="内容详情" />
        <div className="card">
          <ErrorState
            message={resolveErrorMessage(contentQuery.error)}
            onRetry={() => void contentQuery.refetch()}
          />
        </div>
      </div>
    );
  }

  const content = contentQuery.data;

  /** 合规预检的待检文本：标题 + 脚本正文（口播逐句拼），后端按整段做风险识别 */
  const complianceText = [
    content.title,
    content.script?.hook ?? '',
    ...(content.script?.scenes ?? []).map((scene) => `${scene.timeRange} ${scene.voiceover}`),
  ]
    .filter((line) => line.trim() !== '')
    .join('\n');

  return (
    <div className="page">
      <PageHeader
        title={
          <span className="row" style={{ gap: 'var(--space-2)' }}>
            {content.title}
            <StatusTag tone={CONTENT_STATUS_TONES[content.status]}>
              {CONTENT_STATUS_LABELS[content.status]}
            </StatusTag>
          </span>
        }
        subtitle={
          <span className="row wrap" style={{ gap: 'var(--space-2)' }}>
            <span>{content.creatorName}</span>
            <span>·</span>
            <span>{PLATFORM_LABELS[content.platform]}</span>
            {content.projectName && (
              <>
                <span>·</span>
                <span>{content.projectName}</span>
              </>
            )}
          </span>
        }
        actions={
          <>
            <PermissionGate permission={P.CONTENT_WRITE}>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setReviewNote('');
                  setReviewApproved(true);
                  setReviewOpen(true);
                }}
              >
                审核
              </button>
            </PermissionGate>
            <PermissionGate permission={P.CONTENT_PUBLISH}>
              <button
                type="button"
                className="btn btnPrimary"
                disabled={content.status === 'PUBLISHED'}
                onClick={() => {
                  setPublishForm({ publishedUrl: content.publishedUrl ?? '', platformContentId: '' });
                  setPublishOpen(true);
                }}
              >
                {content.status === 'PUBLISHED' ? '已发布' : '标记发布'}
              </button>
            </PermissionGate>
            {content.projectId && (
              <button
                type="button"
                className="btn btnGhost"
                onClick={() => navigate(`/projects/${content.projectId}`)}
              >
                查看项目
              </button>
            )}
          </>
        }
      />

      {/* ---------------- 基础信息 ---------------- */}
      <section className="card">
        <div className="cardHeader">
          <span className="cardTitle">基础信息</span>
        </div>
        <div className="cardBody">
          <dl className="descriptions">
            <div className="descriptionsItem">
              <dt>标题</dt>
              <dd>{content.title}</dd>
            </div>
            <div className="descriptionsItem">
              <dt>达人</dt>
              <dd>{content.creatorName}</dd>
            </div>
            <div className="descriptionsItem">
              <dt>所属项目</dt>
              <dd>{content.projectName ?? '未归属项目'}</dd>
            </div>
            <div className="descriptionsItem">
              <dt>平台</dt>
              <dd>{PLATFORM_LABELS[content.platform]}</dd>
            </div>
            <div className="descriptionsItem">
              <dt>状态</dt>
              <dd>
                <StatusTag tone={CONTENT_STATUS_TONES[content.status]}>
                  {CONTENT_STATUS_LABELS[content.status]}
                </StatusTag>
              </dd>
            </div>
            <div className="descriptionsItem">
              <dt>排期时间</dt>
              <dd>{formatDateTime(content.scheduledAt)}</dd>
            </div>
            <div className="descriptionsItem">
              <dt>发布时间</dt>
              <dd>{formatDateTime(content.publishedAt)}</dd>
            </div>
            <div className="descriptionsItem">
              <dt>作品链接</dt>
              <dd>
                {content.publishedUrl ? (
                  <a href={content.publishedUrl} target="_blank" rel="noreferrer noopener">
                    {content.publishedUrl}
                  </a>
                ) : (
                  '—'
                )}
              </dd>
            </div>
            <div className="descriptionsItem">
              <dt>创建时间</dt>
              <dd>{formatDateTime(content.createdAt)}</dd>
            </div>
            <div className="descriptionsItem">
              <dt>更新时间</dt>
              <dd>{formatDateTime(content.updatedAt)}</dd>
            </div>
            <div className="descriptionsItem">
              <dt>审核人</dt>
              <dd>{content.reviewedBy?.name ?? '尚未审核'}</dd>
            </div>
            <div className="descriptionsItem">
              <dt>审核时间</dt>
              <dd>{formatDateTime(content.reviewedAt)}</dd>
            </div>
            <div className="descriptionsItem" style={{ gridColumn: '1 / -1' }}>
              <dt>审核意见</dt>
              <dd style={{ whiteSpace: 'pre-wrap' }}>{content.reviewNote ?? '—'}</dd>
            </div>
          </dl>
        </div>
      </section>

      {/* ---------------- 数据表现 ---------------- */}
      <section style={{ marginTop: 'var(--space-5)' }}>
        <div className="rowBetween" style={{ marginBottom: 'var(--space-3)' }}>
          <h2 className="sectionTitle" style={{ margin: 0 }}>
            数据表现
          </h2>
          <PermissionGate permission={P.METRICS_SYNC}>
            <button
              type="button"
              className="btn btnSm"
              disabled={syncMutation.isPending}
              onClick={() => syncMutation.mutate()}
            >
              {syncMutation.isPending && <span className="spinner" aria-hidden="true" />}
              同步数据
            </button>
          </PermissionGate>
        </div>

        <div className="grid gridCols4">
          {/* 互动数据字段是字符串：大 V 单条播放量可能超出 JS 安全整数范围 */}
          <StatCard label="播放量" value={formatCount(content.viewCount)} accent="primary" />
          <StatCard label="点赞" value={formatCount(content.likeCount)} accent="info" />
          <StatCard label="评论" value={formatCount(content.commentCount)} accent="warning" />
          <StatCard label="转发" value={formatCount(content.shareCount)} accent="info" />
        </div>

        <div className="grid gridCols4" style={{ marginTop: 'var(--space-4)' }}>
          <StatCard
            label="完播率"
            value={formatPercentValue(content.completionRate)}
            accent="success"
            hint="后端直接下发百分数"
          />
          <StatCard label="转化数" value={formatCount(content.conversions)} accent="warning" />
          <StatCard
            label="营收"
            value={<MoneyText value={content.revenueYuan} variant="compact" />}
            accent="success"
            hint="按内容归因"
          />
          <StatCard
            label="合规分"
            value={content.complianceScore === null ? '未检测' : content.complianceScore}
            accent="danger"
            hint="由合规预检或后端巡检写入"
          />
        </div>
      </section>

      {/* ---------------- AI 脚本生成 ---------------- */}
      <section className="card" style={{ marginTop: 'var(--space-5)' }}>
        <div className="cardHeader">
          <span className="cardTitle">AI 脚本生成</span>
          <span className="subtle" style={{ fontSize: 'var(--font-size-xs)' }}>
            每次调用都计 token 成本，结果会展示耗时与费用
          </span>
        </div>
        <div className="cardBody">
          <PermissionGate
            permission={P.AI_RUN}
            fallback={<div className="emptyInline">你没有「使用 AI 能力」权限，可联系系统管理员开通</div>}
          >
            <div className="formGrid">
              <div className="field fieldFull">
                <label className="label labelRequired" htmlFor="ai-brief">
                  创作 Brief
                </label>
                <textarea
                  id="ai-brief"
                  className="textarea"
                  rows={3}
                  value={briefForm.brief}
                  placeholder="例：为美丽雅洗碗布做一条 60 秒种草短视频，突出吸油不沾手，结尾引导点击小黄车"
                  onChange={(event) => setBriefForm({ ...briefForm, brief: event.target.value })}
                />
              </div>
              <div className="field">
                <label className="label" htmlFor="ai-vertical">
                  垂类
                </label>
                <select
                  id="ai-vertical"
                  className="select"
                  value={briefForm.vertical}
                  onChange={(event) => setBriefForm({ ...briefForm, vertical: event.target.value })}
                >
                  <option value="">沿用内容设定</option>
                  {VERTICAL_OPTIONS.map((option) => (
                    <option key={option.value} value={option.label}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="label" htmlFor="ai-platform">
                  平台
                </label>
                <input
                  id="ai-platform"
                  className="input"
                  value={briefForm.platform || PLATFORM_LABELS[content.platform]}
                  onChange={(event) => setBriefForm({ ...briefForm, platform: event.target.value })}
                />
              </div>
              <div className="field">
                <label className="label" htmlFor="ai-duration">
                  时长
                </label>
                <input
                  id="ai-duration"
                  className="input"
                  value={briefForm.duration}
                  placeholder="例：60s"
                  onChange={(event) => setBriefForm({ ...briefForm, duration: event.target.value })}
                />
              </div>
              <div className="field">
                <label className="label" htmlFor="ai-tone">
                  语气风格
                </label>
                <input
                  id="ai-tone"
                  className="input"
                  value={briefForm.tone}
                  placeholder="例：轻松口语化 / 专业测评"
                  onChange={(event) => setBriefForm({ ...briefForm, tone: event.target.value })}
                />
              </div>
              <div className="field">
                <label className="label" htmlFor="ai-creator">
                  达人昵称
                </label>
                <input
                  id="ai-creator"
                  className="input"
                  value={briefForm.creatorName || content.creatorName}
                  onChange={(event) => setBriefForm({ ...briefForm, creatorName: event.target.value })}
                />
                <span className="hint">用于匹配人设口吻，默认取当前内容的达人</span>
              </div>
            </div>

            <div className="row" style={{ marginTop: 'var(--space-4)' }}>
              <button
                type="button"
                className="btn btnPrimary"
                // disabled + spinner 双保险：AI 是按 token 计费的，连点就是重复花钱
                disabled={scriptMutation.isPending || briefForm.brief.trim() === ''}
                onClick={() =>
                  scriptMutation.mutate({
                    ...briefForm,
                    platform: briefForm.platform || PLATFORM_LABELS[content.platform],
                    creatorName: briefForm.creatorName || content.creatorName,
                  })
                }
              >
                {scriptMutation.isPending && <span className="spinner" aria-hidden="true" />}
                AI 生成脚本
              </button>
              {briefForm.brief.trim() === '' && <span className="hint">先填创作 Brief 再调用</span>}
            </div>
          </PermissionGate>

          {scriptTaskQuery.data && (
            <div style={{ marginTop: 'var(--space-4)' }}>
              <AiTaskMeta
                task={scriptTaskQuery.data}
                onAdopt={() => feedbackMutation.mutate({ taskId: scriptTaskQuery.data!.id, feedback: 1 })}
                onReject={() => feedbackMutation.mutate({ taskId: scriptTaskQuery.data!.id, feedback: -1 })}
                feedbackPending={feedbackMutation.isPending}
                onRetry={() =>
                  scriptMutation.mutate({
                    ...briefForm,
                    platform: briefForm.platform || PLATFORM_LABELS[content.platform],
                    creatorName: briefForm.creatorName || content.creatorName,
                  })
                }
                retryPending={scriptMutation.isPending}
              />
              <ScriptTimeline task={scriptTaskQuery.data} />
            </div>
          )}
        </div>
      </section>

      {/* ---------------- 合规预检 ---------------- */}
      <section className="card" style={{ marginTop: 'var(--space-5)' }}>
        <div className="cardHeader">
          <span className="cardTitle">合规预检</span>
          <span className="subtle" style={{ fontSize: 'var(--font-size-xs)' }}>
            上线前扫一遍极限词 / 医疗宣称 / 竞品对比
          </span>
        </div>
        <div className="cardBody">
          <div className="card" style={{ background: 'var(--color-bg-subtle)', marginBottom: 'var(--space-4)' }}>
            <div className="cardBody">
              <div className="sectionTitle">后端已存检测结果</div>
              <div className="row wrap" style={{ gap: 'var(--space-3)' }}>
                <span className="row" style={{ gap: 'var(--space-2)' }}>
                  <span className="muted">合规分</span>
                  <strong>{content.complianceScore === null ? '未检测' : content.complianceScore}</strong>
                </span>
                {content.complianceFlags && content.complianceFlags.length > 0 ? (
                  <StatusTag tone="warning" size="sm">
                    {content.complianceFlags.length} 条风险
                  </StatusTag>
                ) : (
                  <StatusTag tone="success" size="sm">
                    无风险标记
                  </StatusTag>
                )}
              </div>
              {content.complianceFlags && content.complianceFlags.length > 0 && (
                <div style={{ marginTop: 'var(--space-3)' }}>
                  <FlagList flags={content.complianceFlags} />
                </div>
              )}
            </div>
          </div>

          <PermissionGate
            permission={P.AI_RUN}
            fallback={<div className="emptyInline">你没有「使用 AI 能力」权限，无法发起合规预检</div>}
          >
            <div className="row">
              <button
                type="button"
                className="btn"
                disabled={complianceMutation.isPending || complianceText.trim() === ''}
                onClick={() =>
                  complianceMutation.mutate({
                    // 标题 + 脚本正文一起送检：风险往往藏在口播的某一句里
                    text: complianceText,
                    platform: PLATFORM_LABELS[content.platform],
                  })
                }
              >
                {complianceMutation.isPending && <span className="spinner" aria-hidden="true" />}
                AI 合规预检
              </button>
              <span className="hint">送检文本：标题 + 脚本口播（共 {complianceText.length} 字）</span>
            </div>
          </PermissionGate>

          {complianceTaskQuery.data && (
            <div style={{ marginTop: 'var(--space-4)' }}>
              <AiTaskMeta
                task={complianceTaskQuery.data}
                onAdopt={() =>
                  feedbackMutation.mutate({ taskId: complianceTaskQuery.data!.id, feedback: 1 })
                }
                onReject={() =>
                  feedbackMutation.mutate({ taskId: complianceTaskQuery.data!.id, feedback: -1 })
                }
                feedbackPending={feedbackMutation.isPending}
                onRetry={() =>
                  complianceMutation.mutate({
                    text: complianceText,
                    platform: PLATFORM_LABELS[content.platform],
                  })
                }
                retryPending={complianceMutation.isPending}
              />
              <ComplianceResult task={complianceTaskQuery.data} />
            </div>
          )}
        </div>
      </section>

      {/* ---------------- 审核 ---------------- */}
      <Modal
        open={reviewOpen}
        title={reviewApproved ? '通过审核' : '驳回内容'}
        description={content.title}
        onClose={reviewMutation.isPending ? () => undefined : () => setReviewOpen(false)}
        footer={
          <>
            <button
              type="button"
              className="btn"
              onClick={() => setReviewOpen(false)}
              disabled={reviewMutation.isPending}
            >
              取消
            </button>
            <button
              type="button"
              className={`btn ${reviewApproved ? 'btnPrimary' : 'btnDanger'}`}
              disabled={
                reviewMutation.isPending || (!reviewApproved && reviewNote.trim().length < 5)
              }
              onClick={() => reviewMutation.mutate({ approved: reviewApproved, note: reviewNote })}
            >
              {reviewMutation.isPending && <span className="spinner" aria-hidden="true" />}
              {reviewApproved ? '确认通过' : '确认驳回'}
            </button>
          </>
        }
      >
        <div className="row" style={{ gap: 'var(--space-2)', marginBottom: 'var(--space-3)' }}>
          <button
            type="button"
            className={`btn btnSm ${reviewApproved ? 'btnPrimary' : ''}`}
            onClick={() => setReviewApproved(true)}
          >
            通过
          </button>
          <button
            type="button"
            className={`btn btnSm ${!reviewApproved ? 'btnDanger' : ''}`}
            onClick={() => setReviewApproved(false)}
          >
            驳回
          </button>
        </div>
        <div className="field">
          <label className={reviewApproved ? 'label' : 'label labelRequired'} htmlFor="detail-review-note">
            {reviewApproved ? '审核备注（选填）' : '驳回原因'}
          </label>
          <textarea
            id="detail-review-note"
            className="textarea"
            rows={4}
            value={reviewNote}
            placeholder={reviewApproved ? '例：口播无违规表述，可排期' : '例：出现"治疗""根治"等医疗宣称，请改写'}
            onChange={(event) => setReviewNote(event.target.value)}
          />
          <span className={!reviewApproved && reviewNote.trim().length < 5 ? 'errorText' : 'hint'}>
            {reviewApproved
              ? '备注会随审核记录一起留痕'
              : `驳回原因至少 5 个字，当前 ${reviewNote.trim().length} 字`}
          </span>
        </div>
      </Modal>

      {/* ---------------- 发布 ---------------- */}
      <Modal
        open={publishOpen}
        title="标记为已发布"
        description={content.title}
        onClose={publishMutation.isPending ? () => undefined : () => setPublishOpen(false)}
        footer={
          <>
            <button
              type="button"
              className="btn"
              onClick={() => setPublishOpen(false)}
              disabled={publishMutation.isPending}
            >
              取消
            </button>
            <button
              type="button"
              className="btn btnPrimary"
              disabled={publishMutation.isPending}
              onClick={() => publishMutation.mutate(publishForm)}
            >
              {publishMutation.isPending && <span className="spinner" aria-hidden="true" />}
              确认发布
            </button>
          </>
        }
      >
        <div className="formGrid">
          <div className="field fieldFull">
            <label className="label" htmlFor="detail-publish-url">
              作品链接
            </label>
            <input
              id="detail-publish-url"
              className="input"
              value={publishForm.publishedUrl}
              placeholder="https://..."
              onChange={(event) => setPublishForm({ ...publishForm, publishedUrl: event.target.value })}
            />
          </div>
          <div className="field fieldFull">
            <label className="label" htmlFor="detail-publish-platform-id">
              平台作品 ID
            </label>
            <input
              id="detail-publish-platform-id"
              className="input"
              value={publishForm.platformContentId}
              placeholder="平台侧作品 id，用于精确采集数据"
              onChange={(event) =>
                setPublishForm({ ...publishForm, platformContentId: event.target.value })
              }
            />
          </div>
        </div>
      </Modal>

    </div>
  );
}

/* ============================================================
   AI 任务公共片段
   ============================================================ */

interface AiTaskMetaProps {
  task: AiTaskListItem;
  onAdopt: () => void;
  onReject: () => void;
  feedbackPending: boolean;
  onRetry: () => void;
  retryPending: boolean;
}

/** 任务元信息条：状态、耗时、token、成本、模型，外加采纳/拒绝与失败重试 */
function AiTaskMeta({
  task,
  onAdopt,
  onReject,
  feedbackPending,
  onRetry,
  retryPending,
}: AiTaskMetaProps) {
  const running = isAiTaskInFlight(task.status);

  return (
    <div
      className="card"
      style={{ background: 'var(--color-bg-subtle)', borderColor: 'var(--color-border)' }}
    >
      <div className="cardBody">
        <div className="rowBetween wrap">
          <div className="row wrap" style={{ gap: 'var(--space-3)' }}>
            {/*
              状态标签改走 constants.ts 里的统一映射：这里原本是就地写死的一串三元表达式，
              值取自前端的 AiTaskStatus，所以 `'FALLBACK'` 这种后端根本不存在的值
              也能"编译通过"——只有把映射收敛到唯一来源，漂移才无处藏身。
            */}
            <StatusTag tone={AI_TASK_STATUS_TONES[task.status]} size="sm" dot>
              {AI_TASK_STATUS_LABELS[task.status]}
            </StatusTag>
            {running && <span className="spinner" aria-hidden="true" />}
            <span className="muted" style={{ fontSize: 'var(--font-size-xs)' }}>
              模型 {task.provider} / {task.model}
            </span>
            <span className="muted" style={{ fontSize: 'var(--font-size-xs)' }}>
              token {formatCount(task.totalTokens)}（提示 {formatCount(task.promptTokens)} + 生成{' '}
              {formatCount(task.completionTokens)}）
            </span>
            <span className="muted" style={{ fontSize: 'var(--font-size-xs)' }}>
              成本 {formatCents(task.costCents)}
            </span>
            <span className="muted" style={{ fontSize: 'var(--font-size-xs)' }}>
              耗时 {formatMs(task.latencyMs)}
            </span>
            {task.retryCount > 0 && (
              <span className="muted" style={{ fontSize: 'var(--font-size-xs)' }}>
                重试 {task.retryCount} 次
              </span>
            )}
          </div>

          <div className="row" style={{ gap: 'var(--space-2)' }}>
            <PermissionGate permission={P.AI_FEEDBACK}>
              {task.humanFeedback === 1 ? (
                <StatusTag tone="success" size="sm">
                  已采纳
                </StatusTag>
              ) : task.humanFeedback === -1 ? (
                <StatusTag tone="danger" size="sm">
                  已拒绝
                </StatusTag>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn btnSm"
                    disabled={feedbackPending || running}
                    onClick={onAdopt}
                  >
                    采纳
                  </button>
                  <button
                    type="button"
                    className="btn btnSm"
                    disabled={feedbackPending || running}
                    onClick={onReject}
                  >
                    拒绝
                  </button>
                </>
              )}
            </PermissionGate>
          </div>
        </div>

        {task.status === 'FAILED' && (
          <div
            className="rowBetween wrap"
            style={{ marginTop: 'var(--space-3)', gap: 'var(--space-3)' }}
          >
            <span className="errorText">失败原因：{task.fallbackReason ?? '上游未返回具体原因'}</span>
            <button
              type="button"
              className="btn btnSm"
              disabled={retryPending}
              onClick={onRetry}
              // 重试会生成新的 idempotencyKey（在 mutationFn 里做的）：
              // 沿用旧 key 会被后端判定为同一次请求，直接返回上次的失败结果
              title="重试会以新的幂等键重新提交，避免命中上次的失败结果"
            >
              {retryPending && <span className="spinner" aria-hidden="true" />}
              重试
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** 脚本时间轴：审核员关心"第几秒说什么"，所以按 scene 渲染成时间轴而不是 JSON */
function ScriptTimeline({ task }: { task: AiTaskListItem }) {
  const script = task.output as ScriptOutput | null;

  if (isAiTaskInFlight(task.status)) {
    return <div className="emptyInline" style={{ marginTop: 'var(--space-3)' }}>脚本生成中，完成后自动展示…</div>;
  }
  if (!script || !script.scenes) {
    return (
      <div className="emptyInline" style={{ marginTop: 'var(--space-3)' }}>
        本次任务没有返回可解析的脚本结构，可在 AI 工作台查看原始输出
      </div>
    );
  }

  return (
    <div style={{ marginTop: 'var(--space-3)' }}>
      <div className="sectionTitle">生成结果</div>
      <h3 style={{ fontSize: 'var(--font-size-lg)', fontWeight: 'var(--font-weight-semibold)' }}>
        {script.title}
      </h3>
      <p className="muted" style={{ marginTop: 'var(--space-1)' }}>
        <strong>钩子：</strong>
        {script.hook}
      </p>

      <ol className="stack" style={{ listStyle: 'none', padding: 0, marginTop: 'var(--space-3)' }}>
        {script.scenes.map((scene) => (
          <li
            key={scene.index}
            className="row"
            style={{
              alignItems: 'flex-start',
              gap: 'var(--space-3)',
              paddingBottom: 'var(--space-3)',
              borderBottom: '1px solid var(--color-border)',
            }}
          >
            <span
              className="mono nowrap"
              style={{ width: 92, color: 'var(--color-primary-600)', fontSize: 'var(--font-size-xs)' }}
            >
              {scene.timeRange}
            </span>
            <div className="grow">
              <div style={{ fontWeight: 'var(--font-weight-medium)' }}>{scene.shot}</div>
              <div className="muted" style={{ marginTop: 'var(--space-1)' }}>
                口播：{scene.voiceover}
              </div>
              {scene.note && (
                <div className="subtle" style={{ marginTop: 'var(--space-1)', fontSize: 'var(--font-size-xs)' }}>
                  备注：{scene.note}
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>

      {script.hashtags.length > 0 && (
        <div style={{ marginTop: 'var(--space-3)' }}>
          <div className="sectionTitle">话题标签</div>
          <div className="chipGroup">
            {script.hashtags.map((tag) => (
              <span key={tag} className="chip">
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}

      {script.risks.length > 0 && (
        <div style={{ marginTop: 'var(--space-3)' }}>
          <div className="sectionTitle" style={{ color: 'var(--color-danger)' }}>
            风险提示
          </div>
          <ul style={{ margin: 0, paddingLeft: 'var(--space-5)', color: 'var(--color-danger)' }}>
            {script.risks.map((risk) => (
              <li key={risk}>{risk}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** 合规预检结果：大号分数 + 等级 + 逐条风险，每条都给"原因 + 改法" */
function ComplianceResult({ task }: { task: AiTaskListItem }) {
  const result = task.output as ComplianceCheckOutput | null;

  if (isAiTaskInFlight(task.status)) {
    return (
      <div className="emptyInline" style={{ marginTop: 'var(--space-3)' }}>
        合规预检进行中，完成后自动展示…
      </div>
    );
  }
  if (!result || typeof result.score !== 'number') {
    return (
      <div className="emptyInline" style={{ marginTop: 'var(--space-3)' }}>
        本次任务没有返回可解析的合规结果
      </div>
    );
  }

  return (
    <div style={{ marginTop: 'var(--space-3)' }}>
      <div className="row" style={{ gap: 'var(--space-4)' }}>
        <div>
          <div className="muted" style={{ fontSize: 'var(--font-size-xs)' }}>
            合规得分
          </div>
          <div style={{ fontSize: 'var(--font-size-3xl)', fontWeight: 'var(--font-weight-semibold)' }}>
            {result.score}
          </div>
        </div>
        <StatusTag tone={COMPLIANCE_LEVEL_TONES[result.level as ComplianceLevel]} size="md">
          {COMPLIANCE_LEVEL_LABELS[result.level as ComplianceLevel] ?? result.level}
        </StatusTag>
      </div>

      <div style={{ marginTop: 'var(--space-3)' }}>
        {result.flags.length === 0 ? (
          <div className="emptyInline">未发现合规风险，可以进入审核流程</div>
        ) : (
          <FlagList flags={result.flags} />
        )}
      </div>
    </div>
  );
}

/** 风险条目列表：后端预存结果与 AI 预检结果共用同一套渲染 */
function FlagList({ flags }: { flags: ComplianceFlag[] }) {
  return (
    <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {flags.map((flag, index) => (
        <li
          key={`${flag.category}-${index}`}
          className="card"
          style={{
            // 按风险等级着色左边框：一屏内扫一眼就能分出"必须改"和"建议改"
            borderLeft: `3px solid ${
              flag.level === 'REJECT'
                ? 'var(--color-danger)'
                : flag.level === 'WARN'
                  ? 'var(--color-warning)'
                  : 'var(--color-success)'
            }`,
          }}
        >
          <div className="cardBody">
            <div className="row wrap" style={{ gap: 'var(--space-2)' }}>
              <StatusTag tone={COMPLIANCE_LEVEL_TONES[flag.level]} size="sm">
                {COMPLIANCE_LEVEL_LABELS[flag.level]}
              </StatusTag>
              <span>{flag.category}</span>
            </div>
            <div className="codeBlock" style={{ marginTop: 'var(--space-2)' }}>
              {flag.snippet}
            </div>
            <div className="muted" style={{ marginTop: 'var(--space-2)' }}>
              原因：{flag.reason}
            </div>
            <div style={{ marginTop: 'var(--space-1)' }}>建议：{flag.suggestion}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}
