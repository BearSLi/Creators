import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/PageHeader';
import { DataTable, type Column } from '@/components/DataTable';
import { StatCard } from '@/components/StatCard';
import { StatusTag, TierTag } from '@/components/StatusTag';
import { MoneyText } from '@/components/MoneyText';
import { Modal } from '@/components/Modal';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { PermissionGate } from '@/components/PermissionGate';
import { DetailSkeleton } from '@/components/LoadingSkeleton';
import { ErrorState } from '@/components/EmptyState';
import { AUDIT_WRITTEN_HINT, useToast } from '@/components/Toast';
import { resolveErrorMessage } from '@/api/client';
import {
  assignCreator,
  deleteCreator,
  evaluateCreator,
  getCreator,
  updateCreatorStatus,
} from '@/api/creators';
import { listContents } from '@/api/contents';
import { listContracts } from '@/api/contracts';
import { listSettlements } from '@/api/settlements';
import type {
  ContentListItem,
  ContractListItem,
  CreatorAccount,
  CreatorDetail,
  SettlementListItem,
} from '@/api/types';
import { P } from '@/utils/permissions';
import {
  AGENCY_TYPE_LABELS,
  CONTENT_STATUS_LABELS,
  CONTENT_STATUS_TONES,
  CONTRACT_STATUS_LABELS,
  CONTRACT_STATUS_TONES,
  CREATOR_STATUS_LABELS,
  CREATOR_STATUS_TONES,
  DATA_SOURCE_LABELS,
  DATA_SOURCE_TRUST,
  EVALUATION_DIMENSIONS,
  RISK_LEVEL_LABELS,
  RISK_LEVEL_TONES,
  SETTLEMENT_MODE_LABELS,
  SETTLEMENT_STATUS_LABELS,
  SETTLEMENT_STATUS_TONES,
  availabilityLabel,
  platformLabel,
  sourceChannelLabel,
} from '@/utils/constants';
import {
  formatCount,
  formatDate,
  formatDateTime,
  formatFollowers,
  formatInteger,
  formatPercentValue,
  formatRelative,
  formatScore,
  maskPhone,
} from '@/utils/format';

/**
 * 达人详情页。
 *
 * 关键取舍：
 *   1) 状态流转按钮**只**来自 detail.statusMachine.allowedNext。前端硬编码一份"能流转到哪"
 *      看似省事，但后端一加规则（例如黑名单只能由管理员恢复）就会出现"点了必失败"的按钮，
 *      而且原因字段会漏填导致审计断链；
 *   2) 五个 Tab 的数据按需请求（enabled 取决于当前 Tab）：详情页首屏并发 4 个列表请求
 *      既浪费后端资源，也让首屏变慢，用户多数只看基本信息；
 *   3) 每个 Tab 内都是独立的 loading/空/错误三态，某个 Tab 挂了不影响整页渲染。
 */

type TabKey = 'basic' | 'accounts' | 'contents' | 'contracts' | 'settlements';

type AllowedNext = CreatorDetail['statusMachine']['allowedNext'][number];

type EvaluationScores = {
  contentScore: number;
  commercialScore: number;
  cooperationScore: number;
  dataScore: number;
};

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'basic', label: '基本信息' },
  { key: 'accounts', label: '平台账号矩阵' },
  { key: 'contents', label: '内容表现' },
  { key: 'contracts', label: '合同' },
  { key: 'settlements', label: '结算' },
];

/** 数据来源可信度 → 状态色：结算与对外报表只会引用高可信数据，这里给业务同学一眼判断 */
const TRUST_TONES: Record<'high' | 'medium' | 'low', 'success' | 'warning' | 'neutral'> = {
  high: 'success',
  medium: 'warning',
  low: 'neutral',
};

const TRUST_LABELS: Record<'high' | 'medium' | 'low', string> = {
  high: '高',
  medium: '中',
  low: '低',
};

/** 评价输入是自由文本，统一夹到 0~25 的整数，避免用户输入 999 把总分算爆 */
function clampScore(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(25, Math.max(0, Math.round(parsed)));
}

export default function CreatorDetailPage() {
  const { id } = useParams<{ id: string }>();
  const creatorId = id ?? '';
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [tab, setTab] = useState<TabKey>('basic');
  const [pendingTransition, setPendingTransition] = useState<AllowedNext | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [ownerId, setOwnerId] = useState('');
  const [assignNote, setAssignNote] = useState('');
  const [evaluateOpen, setEvaluateOpen] = useState(false);
  const [scores, setScores] = useState<EvaluationScores>({
    contentScore: 20,
    commercialScore: 20,
    cooperationScore: 20,
    dataScore: 20,
  });
  const [evaluateRemark, setEvaluateRemark] = useState('');

  const detailQuery = useQuery({
    queryKey: ['creators', 'detail', creatorId],
    queryFn: () => getCreator(creatorId),
    enabled: creatorId !== '',
  });

  const contentsQuery = useQuery({
    queryKey: ['creators', 'detail', creatorId, 'contents'],
    queryFn: () => listContents({ creatorId, pageSize: 10 }),
    enabled: creatorId !== '' && tab === 'contents',
  });

  const contractsQuery = useQuery({
    queryKey: ['creators', 'detail', creatorId, 'contracts'],
    queryFn: () => listContracts({ creatorId, pageSize: 10 }),
    enabled: creatorId !== '' && tab === 'contracts',
  });

  const settlementsQuery = useQuery({
    queryKey: ['creators', 'detail', creatorId, 'settlements'],
    queryFn: () => listSettlements({ creatorId, pageSize: 10 }),
    enabled: creatorId !== '' && tab === 'settlements',
  });

  /** 状态流转：requiresReason 的流转必须走 ConfirmDialog 收原因，否则后端会拒（REASON_REQUIRED） */
  const statusMutation = useMutation({
    mutationFn: (payload: { status: AllowedNext['value']; reason?: string }) =>
      updateCreatorStatus(creatorId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['creators', 'detail', creatorId] });
      queryClient.invalidateQueries({ queryKey: ['creators'] });
      toast.success(`达人状态已更新，${AUDIT_WRITTEN_HINT}`);
      setPendingTransition(null);
    },
  });

  const assignMutation = useMutation({
    mutationFn: () =>
      assignCreator(creatorId, {
        ownerId: ownerId.trim(),
        note: assignNote.trim() || undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['creators', 'detail', creatorId] });
      queryClient.invalidateQueries({ queryKey: ['creators'] });
      toast.success(`负责人已更新，${AUDIT_WRITTEN_HINT}`);
      setAssignOpen(false);
      setOwnerId('');
      setAssignNote('');
    },
  });

  const evaluateMutation = useMutation({
    mutationFn: () =>
      evaluateCreator(creatorId, {
        contentScore: scores.contentScore,
        commercialScore: scores.commercialScore,
        cooperationScore: scores.cooperationScore,
        dataScore: scores.dataScore,
        remark: evaluateRemark.trim() || undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['creators', 'detail', creatorId] });
      queryClient.invalidateQueries({ queryKey: ['creators'] });
      toast.success(`合作评价已保存，${AUDIT_WRITTEN_HINT}`);
      setEvaluateOpen(false);
      setEvaluateRemark('');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteCreator(creatorId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['creators'] });
      toast.success(`达人已删除，${AUDIT_WRITTEN_HINT}`);
      setDeleteOpen(false);
      navigate('/creators');
    },
  });

  /** 评价总分：与后端口径一致（四项等权相加），后端改加权时这里必须同步改 */
  const totalScore = EVALUATION_DIMENSIONS.reduce((sum, dimension) => sum + scores[dimension.key], 0);

  const updateScore = (key: string, value: number) => {
    setScores((prev) => {
      const next: EvaluationScores = { ...prev };
      // key 来自 EVALUATION_DIMENSIONS（受控联合类型），显式收窄避免写错字段名时静默失败
      if (
        key === 'contentScore' ||
        key === 'commercialScore' ||
        key === 'cooperationScore' ||
        key === 'dataScore'
      ) {
        next[key] = value;
      }
      return next;
    });
  };

  if (detailQuery.isLoading) {
    return (
      <div className="page">
        <PageHeader title="达人详情" subtitle="正在加载达人主数据…" />
        <DetailSkeleton />
      </div>
    );
  }

  const detail = detailQuery.data;
  if (detailQuery.isError || !detail) {
    return (
      <div className="page">
        <PageHeader title="达人详情" />
        <div className="card">
          <ErrorState
            message={
              detailQuery.error ? resolveErrorMessage(detailQuery.error) : '未找到该达人，可能已被删除'
            }
            onRetry={() => void detailQuery.refetch()}
          />
        </div>
      </div>
    );
  }

  const allowedNext = detail.statusMachine.allowedNext;

  const accountColumns: Array<Column<CreatorAccount>> = [
    { key: 'platform', title: '平台', width: 96, render: (row) => platformLabel(row.platform) },
    {
      key: 'nickname',
      title: '昵称',
      minWidth: 150,
      render: (row) =>
        row.profileUrl ? (
          <a href={row.profileUrl} target="_blank" rel="noreferrer">
            {row.nickname}
          </a>
        ) : (
          row.nickname
        ),
    },
    {
      key: 'platformUid',
      title: 'UID',
      width: 140,
      render: (row) => <span className="mono">{row.platformUid}</span>,
    },
    {
      key: 'followerCount',
      title: '粉丝数',
      width: 96,
      align: 'right',
      render: (row) => <span className="mono">{formatFollowers(row.followerCount)}</span>,
    },
    {
      key: 'totalLikes',
      title: '总点赞',
      width: 96,
      align: 'right',
      tooltip: '后端以字符串下发，避免大 V 数据超过 JS 安全整数范围',
      render: (row) => <span className="mono">{formatCount(row.totalLikes)}</span>,
    },
    {
      key: 'totalWorks',
      title: '作品数',
      width: 84,
      align: 'right',
      render: (row) => <span className="mono">{formatInteger(row.totalWorks)}</span>,
    },
    {
      key: 'avgPlayCount',
      title: '平均播放',
      width: 100,
      align: 'right',
      render: (row) => <span className="mono">{formatCount(row.avgPlayCount)}</span>,
    },
    {
      key: 'engagementRate',
      title: '互动率',
      width: 84,
      align: 'right',
      render: (row) => (
        <span className="mono">{formatPercentValue(row.engagementRate)}</span>
      ),
    },
    {
      key: 'dataSource',
      title: '数据来源',
      width: 150,
      render: (row) => {
        const trust = DATA_SOURCE_TRUST[row.dataSource];
        return (
          <span className="row" style={{ gap: 'var(--space-1)' }}>
            <span className="nowrap">{DATA_SOURCE_LABELS[row.dataSource]}</span>
            <StatusTag tone={TRUST_TONES[trust]} size="sm" title="可信度：官方接口 > 第三方 > 人工录入">
              可信度 {TRUST_LABELS[trust]}
            </StatusTag>
          </span>
        );
      },
    },
    {
      key: 'lastSyncedAt',
      title: '同步时间',
      width: 110,
      render: (row) => (
        <span className="nowrap" title={formatDateTime(row.lastSyncedAt)}>
          {formatRelative(row.lastSyncedAt)}
        </span>
      ),
    },
    {
      key: 'isPrimary',
      title: '主账号',
      width: 88,
      render: (row) =>
        row.isPrimary ? (
          <StatusTag tone="primary" size="sm">
            主账号
          </StatusTag>
        ) : (
          <span className="subtle">—</span>
        ),
    },
    {
      key: 'syncError',
      title: '采集异常',
      minWidth: 160,
      render: (row) =>
        row.syncError ? (
          <span className="errorText">{row.syncError}</span>
        ) : (
          <span className="subtle">正常</span>
        ),
    },
  ];

  const contentColumns: Array<Column<ContentListItem>> = [
    { key: 'title', title: '标题', minWidth: 200, ellipsis: true, render: (row) => row.title },
    { key: 'platform', title: '平台', width: 96, render: (row) => platformLabel(row.platform) },
    {
      key: 'status',
      title: '状态',
      width: 92,
      render: (row) => (
        <StatusTag tone={CONTENT_STATUS_TONES[row.status]}>
          {CONTENT_STATUS_LABELS[row.status]}
        </StatusTag>
      ),
    },
    {
      key: 'publishedAt',
      title: '发布日',
      width: 110,
      render: (row) => <span className="nowrap mono">{formatDate(row.publishedAt)}</span>,
    },
    {
      key: 'viewCount',
      title: '播放',
      width: 96,
      align: 'right',
      render: (row) => <span className="mono">{formatCount(row.viewCount)}</span>,
    },
    {
      key: 'engagement',
      title: '互动（赞/评/转）',
      width: 160,
      align: 'right',
      render: (row) => (
        <span className="mono nowrap">
          {formatCount(row.likeCount)} / {formatCount(row.commentCount)} /{' '}
          {formatCount(row.shareCount)}
        </span>
      ),
    },
    {
      key: 'revenueYuan',
      title: '营收',
      width: 120,
      align: 'right',
      render: (row) => <MoneyText value={row.revenueYuan} variant="plain" />,
    },
  ];

  const contractColumns: Array<Column<ContractListItem>> = [
    {
      key: 'code',
      title: '合同编号',
      width: 150,
      render: (row) => <span className="mono">{row.code}</span>,
    },
    { key: 'title', title: '标题', minWidth: 200, ellipsis: true, render: (row) => row.title },
    {
      key: 'status',
      title: '状态',
      width: 92,
      render: (row) => (
        <StatusTag tone={CONTRACT_STATUS_TONES[row.status]}>
          {CONTRACT_STATUS_LABELS[row.status]}
        </StatusTag>
      ),
    },
    {
      key: 'settlementMode',
      title: '结算方式',
      width: 110,
      render: (row) => SETTLEMENT_MODE_LABELS[row.settlementMode],
    },
    {
      key: 'fixedFee',
      title: '固定费用',
      width: 120,
      align: 'right',
      render: (row) => <MoneyText value={row.fixedFee} variant="plain" />,
    },
    {
      key: 'effective',
      title: '生效期',
      width: 200,
      render: (row) => (
        <span className="nowrap mono">
          {formatDate(row.effectiveFrom)} ~ {formatDate(row.effectiveTo)}
        </span>
      ),
    },
  ];

  const settlementColumns: Array<Column<SettlementListItem>> = [
    {
      key: 'code',
      title: '结算编号',
      width: 150,
      render: (row) => <span className="mono">{row.code}</span>,
    },
    {
      key: 'period',
      title: '账期',
      width: 200,
      render: (row) => (
        <span className="nowrap mono">
          {formatDate(row.periodStart)} ~ {formatDate(row.periodEnd)}
        </span>
      ),
    },
    {
      key: 'status',
      title: '状态',
      width: 92,
      render: (row) => (
        <StatusTag tone={SETTLEMENT_STATUS_TONES[row.status]}>
          {SETTLEMENT_STATUS_LABELS[row.status]}
        </StatusTag>
      ),
    },
    {
      key: 'netPayable',
      title: '净额',
      width: 130,
      align: 'right',
      render: (row) => <MoneyText value={row.netPayable} variant="plain" />,
    },
    {
      key: 'dueDate',
      title: '到期日',
      width: 110,
      render: (row) => <span className="nowrap mono">{formatDate(row.dueDate)}</span>,
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title={
          <span className="row wrap" style={{ gap: 'var(--space-2)' }}>
            {detail.name}
            <StatusTag tone={CREATOR_STATUS_TONES[detail.status]} dot>
              {CREATOR_STATUS_LABELS[detail.status]}
            </StatusTag>
            <TierTag tier={detail.tier} />
            <StatusTag tone={RISK_LEVEL_TONES[detail.riskLevel]}>
              风险 {RISK_LEVEL_LABELS[detail.riskLevel]}
            </StatusTag>
          </span>
        }
        subtitle={
          <span>
            <span className="mono">{detail.code}</span>
            {detail.city ? ` · ${detail.city}` : ''}
            {detail.owner ? ` · 负责人 ${detail.owner.name}` : ' · 未分配负责人'}
          </span>
        }
        actions={
          <>
            <PermissionGate permission={P.CREATOR_WRITE}>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setScores({
                    contentScore: 20,
                    commercialScore: 20,
                    cooperationScore: 20,
                    dataScore: 20,
                  });
                  setEvaluateOpen(true);
                }}
              >
                合作评价
              </button>
            </PermissionGate>
            <PermissionGate permission={P.CREATOR_WRITE}>
              <button type="button" className="btn" onClick={() => navigate(`/creators/${creatorId}/edit`)}>
                编辑
              </button>
            </PermissionGate>
            <PermissionGate permission={P.CREATOR_ASSIGN}>
              <button type="button" className="btn" onClick={() => setAssignOpen(true)}>
                分配负责人
              </button>
            </PermissionGate>
            <PermissionGate permission={P.CREATOR_DELETE}>
              <button type="button" className="btn btnDanger" onClick={() => setDeleteOpen(true)}>
                删除
              </button>
            </PermissionGate>
          </>
        }
      />

      {/* 状态流转：动作集合完全由后端状态机下发 */}
      <div className="card">
        <div className="cardBody">
          <div className="rowBetween wrap">
            <div className="row wrap" style={{ gap: 'var(--space-2)' }}>
              <span className="sectionTitle" style={{ marginBottom: 0 }}>
                状态流转
              </span>
              <span className="hint">可选动作由后端状态机下发，前端不硬编码流转规则</span>
            </div>
            <span className="muted">
              当前状态：{detail.statusMachine.current.label}
            </span>
          </div>

          <div className="row wrap" style={{ gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}>
            {allowedNext.length > 0 ? (
              allowedNext.map((next) => (
                <button
                  key={next.value}
                  type="button"
                  className="btn"
                  disabled={statusMutation.isPending}
                  onClick={() => {
                    // 需要原因的流转先弹窗收集原因，原因是审计链的一部分，不能由前端编造
                    if (next.requiresReason) {
                      setPendingTransition(next);
                      return;
                    }
                    statusMutation.mutate({ status: next.value });
                  }}
                >
                  {statusMutation.isPending && <span className="spinner" aria-hidden="true" />}
                  流转为「{next.label}」
                  {next.requiresReason && <span className="subtle">（需填原因）</span>}
                </button>
              ))
            ) : (
              <span className="hint">当前状态没有可执行的流转</span>
            )}
          </div>
        </div>
      </div>

      <div className="grid gridCols4" style={{ marginTop: 'var(--space-4)' }}>
        <StatCard label="生效合同数" value={formatInteger(detail.stats.activeContracts)} unit="份" />
        <StatCard
          label="内容总数"
          value={formatInteger(detail.stats.totalContents)}
          unit="条"
          hint={`已发布 ${formatInteger(detail.stats.publishedContents)} 条`}
          accent="info"
        />
        <StatCard
          label="已发布内容"
          value={formatInteger(detail.stats.publishedContents)}
          unit="条"
          accent="success"
        />
        <StatCard
          label="累计营收"
          value={<MoneyText value={detail.stats.totalRevenueYuan} variant="compact" />}
          accent="primary"
        />
        <StatCard
          label="待结算"
          value={<MoneyText value={detail.stats.pendingSettlementYuan} variant="compact" />}
          accent="warning"
          hint="含已审批未打款"
        />
      </div>

      <div className="card" style={{ marginTop: 'var(--space-4)' }}>
        <div className="tabs">
          {TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`tab ${tab === item.key ? 'tabActive' : ''}`}
              onClick={() => setTab(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="cardBody">
          {tab === 'basic' && (
            <dl className="descriptions">
              <div className="descriptionsItem">
                <dt>真实姓名</dt>
                <dd>{detail.realName ?? '—'}</dd>
              </div>
              <div className="descriptionsItem">
                <dt>手机号</dt>
                <dd>
                  <PermissionGate permission={P.CREATOR_SENSITIVE_READ} fallback="lock" lockText="已脱敏">
                    {/* 后端标记 masked 时再套一层 maskPhone：数据源本身只有脱敏值时避免展示成完整号码 */}
                    <span className="mono">
                      {detail.masked ? maskPhone(detail.phone) : (detail.phone ?? '—')}
                    </span>
                  </PermissionGate>
                </dd>
              </div>
              <div className="descriptionsItem">
                <dt>微信</dt>
                <dd>
                  <PermissionGate permission={P.CREATOR_SENSITIVE_READ} fallback="lock" lockText="已脱敏">
                    {detail.wechat ?? '—'}
                  </PermissionGate>
                </dd>
              </div>
              <div className="descriptionsItem">
                <dt>邮箱</dt>
                <dd>{detail.email ?? '—'}</dd>
              </div>
              <div className="descriptionsItem">
                <dt>城市</dt>
                <dd>{detail.city ?? '—'}</dd>
              </div>
              <div className="descriptionsItem">
                <dt>机构类型</dt>
                <dd>{detail.agencyType ? AGENCY_TYPE_LABELS[detail.agencyType] : '—'}</dd>
              </div>
              <div className="descriptionsItem">
                <dt>机构名称</dt>
                <dd>{detail.agencyName ?? '—'}</dd>
              </div>
              <div className="descriptionsItem">
                <dt>来源渠道</dt>
                <dd>{sourceChannelLabel(detail.sourceChannel)}</dd>
              </div>
              <div className="descriptionsItem">
                <dt>可用性</dt>
                <dd>{availabilityLabel(detail.availability)}</dd>
              </div>
              <div className="descriptionsItem">
                <dt>证件号</dt>
                <dd>
                  <PermissionGate permission={P.CREATOR_SENSITIVE_READ} fallback="lock" lockText="已脱敏">
                    <span className="mono">{detail.idCardMasked ?? '—'}</span>
                  </PermissionGate>
                </dd>
              </div>
              <div className="descriptionsItem">
                <dt>内部评分</dt>
                <dd className="mono">{formatScore(detail.score)}</dd>
              </div>
              <div className="descriptionsItem">
                <dt>负责人</dt>
                <dd>{detail.owner?.name ?? '未分配'}</dd>
              </div>
              <div className="descriptionsItem">
                <dt>创建时间</dt>
                <dd className="mono">{formatDateTime(detail.createdAt)}</dd>
              </div>
              <div className="descriptionsItem">
                <dt>更新时间</dt>
                <dd className="mono">{formatDateTime(detail.updatedAt)}</dd>
              </div>
              <div className="descriptionsItem" style={{ gridColumn: '1 / -1' }}>
                <dt>备注</dt>
                <dd>{detail.remark ?? '—'}</dd>
              </div>
            </dl>
          )}

          {tab === 'accounts' && (
            <div className="stack">
              <div className="rowBetween wrap">
                <span className="hint">
                  采集数据只用于展示与试算，实际结算金额以后端计算链路为准
                </span>
                <PermissionGate permission={P.METRICS_SYNC}>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      // 后端目前只有内容级 sync-metrics，没有账号级手动采集端点。
                      // 这里不伪造一个"采集成功"，只重取最新同步结果并如实说明。
                      queryClient.invalidateQueries({ queryKey: ['creators', 'detail', creatorId] });
                      toast.info('账号级手动采集接口尚未开放：平台数据由后端定时任务采集，已重新拉取最新结果');
                    }}
                  >
                    手动触发采集
                  </button>
                </PermissionGate>
              </div>
              <DataTable
                columns={accountColumns}
                rows={detail.accounts}
                rowKey={(row) => row.id}
                emptyTitle="尚未录入平台账号"
                emptyDescription="在编辑页可以补充各平台账号、粉丝数与数据来源"
                skeletonRows={4}
              />
            </div>
          )}

          {tab === 'contents' && (
            <DataTable
              columns={contentColumns}
              rows={contentsQuery.data?.items ?? []}
              rowKey={(row) => row.id}
              loading={contentsQuery.isLoading}
              error={contentsQuery.error ? resolveErrorMessage(contentsQuery.error) : null}
              onRetry={() => void contentsQuery.refetch()}
              emptyTitle="该达人暂无内容记录"
              emptyDescription="内容产生后会自动汇总到这里，用于评估内容表现"
              onRowClick={(row) => navigate(`/contents/${row.id}`)}
              skeletonRows={5}
            />
          )}

          {tab === 'contracts' && (
            <DataTable
              columns={contractColumns}
              rows={contractsQuery.data?.items ?? []}
              rowKey={(row) => row.id}
              loading={contractsQuery.isLoading}
              error={contractsQuery.error ? resolveErrorMessage(contractsQuery.error) : null}
              onRetry={() => void contractsQuery.refetch()}
              emptyTitle="暂无合同"
              emptyDescription="合同签订后会在这里按生效时间倒序列出"
              onRowClick={(row) => navigate(`/contracts/${row.id}`)}
              skeletonRows={5}
            />
          )}

          {tab === 'settlements' && (
            <DataTable
              columns={settlementColumns}
              rows={settlementsQuery.data?.items ?? []}
              rowKey={(row) => row.id}
              loading={settlementsQuery.isLoading}
              error={settlementsQuery.error ? resolveErrorMessage(settlementsQuery.error) : null}
              onRetry={() => void settlementsQuery.refetch()}
              emptyTitle="暂无结算单"
              emptyDescription="结算按账期生成，生成后会出现在这里"
              onRowClick={(row) => navigate(`/settlements/${row.id}`)}
              skeletonRows={5}
            />
          )}
        </div>
      </div>

      {/* 需要原因的流转：原因必填且会写入审计日志 */}
      <ConfirmDialog
        open={pendingTransition !== null}
        title={`确认流转为「${pendingTransition?.label ?? ''}」？`}
        message="该流转需要填写原因，原因会写入审计日志并通知达人负责人，请写清业务依据。"
        confirmText="确认流转"
        danger={pendingTransition?.value === 'TERMINATED' || pendingTransition?.value === 'BLACKLIST'}
        requireReason
        reasonLabel="流转原因"
        loading={statusMutation.isPending}
        onCancel={() => setPendingTransition(null)}
        onConfirm={(reason) => {
          if (pendingTransition) {
            statusMutation.mutate({ status: pendingTransition.value, reason });
          }
        }}
      />

      <ConfirmDialog
        open={deleteOpen}
        title="删除达人"
        message={`确认删除「${detail.name}」？历史合同与结算单会保留，账号与标签关联将被解除。`}
        confirmText="确认删除"
        danger
        loading={deleteMutation.isPending}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => deleteMutation.mutate()}
      />

      <Modal
        open={assignOpen}
        title="分配负责人"
        description="负责人决定该达人的数据归属、待办提醒与后续跟进"
        onClose={() => setAssignOpen(false)}
        footer={
          <>
            <button
              type="button"
              className="btn"
              disabled={assignMutation.isPending}
              onClick={() => setAssignOpen(false)}
            >
              取消
            </button>
            <button
              type="button"
              className="btn btnPrimary"
              disabled={assignMutation.isPending || ownerId.trim() === ''}
              onClick={() => assignMutation.mutate()}
            >
              {assignMutation.isPending && <span className="spinner" aria-hidden="true" />}
              确认分配
            </button>
          </>
        }
      >
        <div className="field">
          <label className="label labelRequired" htmlFor="assign-owner">
            负责人用户 ID
          </label>
          <input
            id="assign-owner"
            className="input mono"
            value={ownerId}
            placeholder="员工 UUID"
            onChange={(event) => setOwnerId(event.target.value)}
          />
          <span className="hint">
            需要填写员工 UUID：后端没有提供「员工下拉」接口（listUsers 只对有 user:read 权限的账号开放），
            不做假的候选列表。ID 可在「系统管理 → 员工」列表里复制。
          </span>
        </div>

        <div className="field" style={{ marginTop: 'var(--space-3)' }}>
          <label className="label" htmlFor="assign-note">
            交接备注
          </label>
          <textarea
            id="assign-note"
            className="textarea"
            rows={3}
            value={assignNote}
            placeholder="交接背景、跟进重点等，会写入审计日志"
            onChange={(event) => setAssignNote(event.target.value)}
          />
        </div>
      </Modal>

      <Modal
        open={evaluateOpen}
        title="合作评价"
        description="四个维度各 0~25 分，用于达人分级与后续匹配推荐"
        onClose={() => setEvaluateOpen(false)}
        footer={
          <>
            <button
              type="button"
              className="btn"
              disabled={evaluateMutation.isPending}
              onClick={() => setEvaluateOpen(false)}
            >
              取消
            </button>
            <button
              type="button"
              className="btn btnPrimary"
              disabled={evaluateMutation.isPending}
              onClick={() => evaluateMutation.mutate()}
            >
              {evaluateMutation.isPending && <span className="spinner" aria-hidden="true" />}
              提交评价
            </button>
          </>
        }
      >
        {EVALUATION_DIMENSIONS.map((dimension) => (
          <div className="field" key={dimension.key} style={{ marginBottom: 'var(--space-3)' }}>
            <label className="label" htmlFor={`evaluate-${dimension.key}`}>
              {dimension.label}
              <span className="subtle">（0~25 分）</span>
            </label>
            <input
              id={`evaluate-${dimension.key}`}
              type="number"
              min={0}
              max={25}
              className="input"
              value={scores[dimension.key]}
              onChange={(event) => updateScore(dimension.key, clampScore(event.target.value))}
            />
            <span className="hint">{dimension.hint}</span>
          </div>
        ))}

        <div className="field" style={{ marginBottom: 'var(--space-3)' }}>
          <label className="label" htmlFor="evaluate-remark">
            评价说明
          </label>
          <textarea
            id="evaluate-remark"
            className="textarea"
            rows={3}
            value={evaluateRemark}
            placeholder="选填：具体案例、风险提示等"
            onChange={(event) => setEvaluateRemark(event.target.value)}
          />
        </div>

        <div className="rowBetween" style={{ marginTop: 'var(--space-3)' }}>
          <span className="muted">
            总分（四项相加，仅用于展示；若后端改为加权口径需同步调整）
          </span>
          <strong className="mono" style={{ fontSize: 'var(--font-size-lg)' }}>
            {totalScore} / 100
          </strong>
        </div>
      </Modal>
    </div>
  );
}
