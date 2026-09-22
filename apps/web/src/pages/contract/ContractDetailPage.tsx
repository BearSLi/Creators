import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/PageHeader';
import { DataTable, type Column } from '@/components/DataTable';
import { StatusTag } from '@/components/StatusTag';
import { BpText, MoneyText } from '@/components/MoneyText';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { PermissionGate } from '@/components/PermissionGate';
import { DetailSkeleton, LoadingSkeleton } from '@/components/LoadingSkeleton';
import { ErrorState } from '@/components/EmptyState';
import { AUDIT_WRITTEN_HINT, useToast } from '@/components/Toast';
import { resolveErrorMessage } from '@/api/client';
import {
  approveContract,
  getContract,
  previewContractSettlement,
  submitContract,
  terminateContract,
} from '@/api/contracts';
import type {
  ApproveContractRequest,
  ProjectBrief,
  SettlementPreviewItem,
  TieredShare,
} from '@/api/types';
import { P } from '@/utils/permissions';
import {
  CONTRACT_STATUS_LABELS,
  CONTRACT_STATUS_TONES,
  PROJECT_STATUS_LABELS,
  PROJECT_STATUS_TONES,
  SETTLEMENT_MODE_LABELS,
  SHARE_BP_FIELDS,
} from '@/utils/constants';
import { formatBp, formatDate, formatDateTime, previousMonthRange } from '@/utils/format';

/**
 * 交付要求（Json 字段）的键名中文映射。
 *
 * 后端存的是结构化对象，键名是英文（videosPerMonth / platforms）。
 * 没有映射时直接显示原始键名，运营也能看懂，但不如中文直观；
 * 遇到未知键不隐藏而是原样展示 —— 后端新增字段时不会静默消失。
 */
const DELIVERABLE_LABELS: Record<string, string> = {
  videosPerMonth: '每月条数',
  platforms: '发布平台',
  contentTypes: '内容形式',
  durationSec: '单条时长（秒）',
  deliverableCount: '交付数量',
  deadline: '交付截止',
  note: '备注',
};

/**
 * 合同详情页。
 *
 * 关键取舍：
 *   1) 提交审核按钮只按 status 做"前置提示"，真正能不能流转由后端状态机判定：
 *      前端在按钮上多做一层判断是为了减少无意义请求，但绝不把它当成规则来源——
 *      后端返回 409 时，错误提示里会带 allowedNext，用户照样能知道下一步该做什么；
 *   2) 结算试算用 mutation 而不是 query：试算是用户主动发起的动作，
 *      每次点击都应该按当前账期重新请求，不能吃缓存；
 *   3) 试算结果只渲染不重算。金额、四档比率全部来自后端，前端一旦自己乘一遍，
 *      就会出现"页面数字和结算单不一致"的对账事故。
 */

export default function ContractDetailPage() {
  const { id } = useParams<{ id: string }>();
  const contractId = id ?? '';
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [approveOpen, setApproveOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [terminateOpen, setTerminateOpen] = useState(false);
  // 财务一般在次月结算上月流水，所以默认账期取上个月
  // 注意 previousMonthRange() 返回的是 { start, end }，接口参数叫 periodStart/periodEnd，这里做一次显式映射
  const [period, setPeriod] = useState(() => {
    const range = previousMonthRange();
    return { periodStart: range.start, periodEnd: range.end };
  });

  const detailQuery = useQuery({
    queryKey: ['contracts', 'detail', contractId],
    queryFn: () => getContract(contractId),
    enabled: contractId !== '',
  });

  /** 状态类操作都会改变合同状态与列表排序，两个 key 一起失效 */
  const invalidateContract = () => {
    queryClient.invalidateQueries({ queryKey: ['contracts', 'detail', contractId] });
    queryClient.invalidateQueries({ queryKey: ['contracts'] });
  };

  const submitMutation = useMutation({
    mutationFn: () => submitContract(contractId),
    onSuccess: () => {
      invalidateContract();
      toast.success(`合同已提交审核，${AUDIT_WRITTEN_HINT}`);
    },
  });

  const reviewMutation = useMutation({
    mutationFn: (body: ApproveContractRequest) => approveContract(contractId, body),
    onSuccess: (_detail, variables) => {
      invalidateContract();
      toast.success(
        `${variables.approved ? '合同已审批通过' : '合同已驳回'}，${AUDIT_WRITTEN_HINT}`,
      );
      setApproveOpen(false);
      setRejectOpen(false);
    },
  });

  const terminateMutation = useMutation({
    mutationFn: (reason: string) => terminateContract(contractId, { reason }),
    onSuccess: () => {
      invalidateContract();
      toast.success(`合同已终止，${AUDIT_WRITTEN_HINT}`);
      setTerminateOpen(false);
    },
  });

  const previewMutation = useMutation({
    mutationFn: (range: { periodStart: string; periodEnd: string }) =>
      previewContractSettlement(contractId, range),
  });

  if (detailQuery.isLoading) {
    return (
      <div className="page">
        <PageHeader title="合同详情" subtitle="正在加载合同信息…" />
        <DetailSkeleton />
      </div>
    );
  }

  const detail = detailQuery.data;
  if (detailQuery.isError || !detail) {
    return (
      <div className="page">
        <PageHeader title="合同详情" />
        <div className="card">
          <ErrorState
            message={
              detailQuery.error ? resolveErrorMessage(detailQuery.error) : '未找到该合同，可能已被删除'
            }
            onRetry={() => void detailQuery.refetch()}
          />
        </div>
      </div>
    );
  }

  /*
   * 驳回后合同会回到 DRAFT（见 contract.service.approve：approved=false 时
   * 写 status: 'DRAFT' + reviewNote），所以「可提交审核」只有 DRAFT 一种情况。
   * 早期这里还判了 `=== 'REJECTED'` —— 那是个不存在的合同状态，
   * 判断恒为 false 但不会报错（前端类型里当时自己声明了 REJECTED）。
   */
  const canSubmit = detail.status === 'DRAFT';
  const canReview = detail.status === 'PENDING_REVIEW';
  const canTerminate = detail.status !== 'TERMINATED' && detail.status !== 'EXPIRED';
  const preview = previewMutation.data;

  const tieredShareColumns: Array<Column<TieredShare>> = [
    {
      key: 'fromYuan',
      title: '区间下限（元）',
      align: 'right',
      render: (row) => <MoneyText value={row.fromYuan} variant="plain" />,
    },
    {
      key: 'toYuan',
      title: '区间上限（元）',
      align: 'right',
      render: (row) =>
        row.toYuan === null ? (
          <span className="muted">不限</span>
        ) : (
          <MoneyText value={row.toYuan} variant="plain" />
        ),
    },
    {
      key: 'talentShareBp',
      title: '达人分成',
      align: 'right',
      render: (row) => <BpText bp={row.talentShareBp} />,
    },
  ];

  const previewColumns: Array<Column<SettlementPreviewItem>> = [
    {
      key: 'contentId',
      title: '内容 ID',
      width: 150,
      render: (row) => <span className="mono">{row.contentId}</span>,
    },
    { key: 'title', title: '标题', minWidth: 180, ellipsis: true, render: (row) => row.title },
    {
      key: 'publishedAt',
      title: '发布日',
      width: 110,
      render: (row) => <span className="nowrap mono">{formatDate(row.publishedAt)}</span>,
    },
    {
      key: 'grossYuan',
      title: '流水',
      width: 110,
      align: 'right',
      render: (row) => <MoneyText value={row.grossYuan} variant="plain" />,
    },
    {
      key: 'platformFeeYuan',
      title: '平台费',
      width: 110,
      align: 'right',
      render: (row) => <MoneyText value={row.platformFeeYuan} variant="plain" />,
    },
    {
      key: 'talentGrossYuan',
      title: '达人分成（税前）',
      width: 140,
      align: 'right',
      render: (row) => <MoneyText value={row.talentGrossYuan} variant="plain" />,
    },
    {
      key: 'taxYuan',
      title: '代扣税',
      width: 110,
      align: 'right',
      render: (row) => <MoneyText value={row.taxYuan} variant="plain" />,
    },
    {
      key: 'netYuan',
      title: '达人实付',
      width: 120,
      align: 'right',
      render: (row) => <MoneyText value={row.netYuan} variant="plain" />,
    },
  ];

  const projectColumns: Array<Column<ProjectBrief>> = [
    {
      key: 'code',
      title: '项目编号',
      width: 150,
      render: (row) => <span className="mono">{row.code}</span>,
    },
    { key: 'name', title: '项目名称', minWidth: 200, ellipsis: true, render: (row) => row.name },
    {
      key: 'status',
      title: '状态',
      width: 100,
      render: (row) => (
        <StatusTag tone={PROJECT_STATUS_TONES[row.status]}>
          {PROJECT_STATUS_LABELS[row.status]}
        </StatusTag>
      ),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title={
          <span className="row wrap" style={{ gap: 'var(--space-2)' }}>
            {detail.title}
            <StatusTag tone={CONTRACT_STATUS_TONES[detail.status]} dot>
              {CONTRACT_STATUS_LABELS[detail.status]}
            </StatusTag>
            {detail.exclusivity && (
              <StatusTag tone="danger" size="sm">
                独家
              </StatusTag>
            )}
          </span>
        }
        subtitle={<span className="mono">{detail.code}</span>}
        actions={
          <>
            <Link className="btn" to="/contracts">
              返回列表
            </Link>
            <PermissionGate permission={P.CONTRACT_WRITE}>
              <button
                type="button"
                className="btn"
                onClick={() => navigate(`/contracts/${contractId}/edit`)}
              >
                编辑
              </button>
            </PermissionGate>
            {canSubmit && (
              <PermissionGate permission={P.CONTRACT_SUBMIT}>
                <button
                  type="button"
                  className="btn"
                  disabled={submitMutation.isPending}
                  onClick={() => submitMutation.mutate()}
                >
                  {submitMutation.isPending && <span className="spinner" aria-hidden="true" />}
                  提交审核
                </button>
              </PermissionGate>
            )}
            {canReview && (
              <PermissionGate permission={P.CONTRACT_APPROVE}>
                <button
                  type="button"
                  className="btn btnPrimary"
                  disabled={reviewMutation.isPending}
                  onClick={() => setApproveOpen(true)}
                >
                  审批通过
                </button>
              </PermissionGate>
            )}
            {canReview && (
              <PermissionGate permission={P.CONTRACT_APPROVE}>
                <button
                  type="button"
                  className="btn btnDanger"
                  disabled={reviewMutation.isPending}
                  onClick={() => setRejectOpen(true)}
                >
                  驳回
                </button>
              </PermissionGate>
            )}
            {canTerminate && (
              <PermissionGate permission={P.CONTRACT_TERMINATE}>
                <button
                  type="button"
                  className="btn btnDanger"
                  disabled={terminateMutation.isPending}
                  onClick={() => setTerminateOpen(true)}
                >
                  终止合同
                </button>
              </PermissionGate>
            )}
          </>
        }
      />

      <div className="card">
        <div className="cardBody">
          <dl className="descriptions">
            <div className="descriptionsItem">
              <dt>达人</dt>
              <dd>
                <Link to={`/creators/${detail.creatorId}`}>{detail.creatorName}</Link>
              </dd>
            </div>
            <div className="descriptionsItem">
              <dt>品牌</dt>
              <dd>{detail.brandName ?? '—'}</dd>
            </div>
            <div className="descriptionsItem">
              <dt>结算方式</dt>
              <dd>{SETTLEMENT_MODE_LABELS[detail.settlementMode]}</dd>
            </div>
            <div className="descriptionsItem">
              <dt>币种</dt>
              <dd className="mono">{detail.currency}</dd>
            </div>
            <div className="descriptionsItem">
              <dt>固定费用</dt>
              <dd>
                <MoneyText value={detail.fixedFee} />
              </dd>
            </div>
            <div className="descriptionsItem">
              <dt>生效期</dt>
              <dd className="mono">
                {formatDate(detail.effectiveFrom)} ~{' '}
                {detail.effectiveTo ? formatDate(detail.effectiveTo) : '长期'}
              </dd>
            </div>
            <div className="descriptionsItem">
              <dt>签署时间</dt>
              <dd className="mono">{formatDateTime(detail.signedAt)}</dd>
            </div>
            <div className="descriptionsItem">
              <dt>审批人</dt>
              <dd>
                {detail.reviewedBy ? detail.reviewedBy.name : '—'}
                {detail.reviewedAt ? ` · ${formatDateTime(detail.reviewedAt)}` : ''}
              </dd>
            </div>
            <div className="descriptionsItem" style={{ gridColumn: '1 / -1' }}>
              <dt>审批意见</dt>
              <dd>{detail.reviewNote ?? '—'}</dd>
            </div>
          </dl>
          <p className="hint" style={{ marginTop: 'var(--space-3)' }}>
            状态校验以后端为准：若当前状态不允许该操作，后端会返回 409 并在提示里带上可执行的下一步。
          </p>
        </div>
      </div>

      <div className="card">
        <div className="cardHeader">
          <span className="cardTitle">分润规则</span>
          <span className="hint">基点整数：1000 = 10%</span>
        </div>
        <div className="cardBody">
          <div className="grid gridCols4">
            {SHARE_BP_FIELDS.map((field) => (
              <div className="field" key={field.key}>
                <span className="label">{field.label}</span>
                <BpText bp={detail[field.key]} />
              </div>
            ))}
          </div>

          <p className="muted" style={{ marginTop: 'var(--space-4)' }}>
            平台费 {formatBp(detail.platformFeeBp)} / 公司 {formatBp(detail.agencyShareBp)} / 达人{' '}
            {formatBp(detail.talentShareBp)} / 代扣 {formatBp(detail.taxWithholdBp)}
          </p>

          {detail.tieredShares && detail.tieredShares.length > 0 && (
            <div style={{ marginTop: 'var(--space-4)' }}>
              <div className="sectionTitle">阶梯分成（按流水区间提高达人分成）</div>
              <DataTable
                columns={tieredShareColumns}
                rows={detail.tieredShares}
                rowKey={(row) => `${row.fromYuan}-${row.toYuan ?? 'inf'}`}
                skeletonRows={3}
              />
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="cardHeader">
          <span className="cardTitle">结算试算</span>
          <span className="hint">只做预览，不会生成结算单</span>
        </div>
        <div className="cardBody">
          <div className="row wrap" style={{ gap: 'var(--space-3)', alignItems: 'flex-end' }}>
            <div className="field" style={{ width: 180 }}>
              <label className="label" htmlFor="preview-period-start">
                账期开始
              </label>
              <input
                id="preview-period-start"
                type="date"
                className="input"
                value={period.periodStart}
                onChange={(event) =>
                  setPeriod((prev) => ({ ...prev, periodStart: event.target.value }))
                }
              />
            </div>
            <div className="field" style={{ width: 180 }}>
              <label className="label" htmlFor="preview-period-end">
                账期结束
              </label>
              <input
                id="preview-period-end"
                type="date"
                className="input"
                value={period.periodEnd}
                onChange={(event) =>
                  setPeriod((prev) => ({ ...prev, periodEnd: event.target.value }))
                }
              />
            </div>
            <button
              type="button"
              className="btn btnPrimary"
              disabled={
                previewMutation.isPending || period.periodStart === '' || period.periodEnd === ''
              }
              onClick={() => previewMutation.mutate(period)}
            >
              {previewMutation.isPending && <span className="spinner" aria-hidden="true" />}
              试算
            </button>
          </div>

          <div style={{ marginTop: 'var(--space-4)' }}>
            {previewMutation.isPending && <LoadingSkeleton rows={4} columns={6} />}

            {previewMutation.isError && (
              <ErrorState
                message={resolveErrorMessage(previewMutation.error)}
                onRetry={() => previewMutation.mutate(period)}
              />
            )}

            {!previewMutation.isPending && !previewMutation.isError && preview && (
              <>
                <DataTable
                  columns={previewColumns}
                  rows={preview.items}
                  rowKey={(row) => row.contentId}
                  emptyTitle="该账期没有可结算内容"
                  emptyDescription="换个账期，或确认这段时间内容是否已发布并回传流水"
                  skeletonRows={4}
                />
                <dl className="descriptions" style={{ marginTop: 'var(--space-4)' }}>
                  <div className="descriptionsItem">
                    <dt>流水合计</dt>
                    <dd>
                      <MoneyText value={preview.summary.grossYuan} />
                    </dd>
                  </div>
                  <div className="descriptionsItem">
                    <dt>平台费合计</dt>
                    <dd>
                      <MoneyText value={preview.summary.platformFeeYuan} />
                    </dd>
                  </div>
                  <div className="descriptionsItem">
                    <dt>公司分成</dt>
                    <dd>
                      <MoneyText value={preview.summary.agencyShareYuan} />
                    </dd>
                  </div>
                  <div className="descriptionsItem">
                    <dt>达人分成（税前）</dt>
                    <dd>
                      <MoneyText value={preview.summary.talentGrossYuan} />
                    </dd>
                  </div>
                  <div className="descriptionsItem">
                    <dt>代扣税</dt>
                    <dd>
                      <MoneyText value={preview.summary.taxYuan} />
                    </dd>
                  </div>
                  <div className="descriptionsItem">
                    <dt>达人实付</dt>
                    <dd>
                      <MoneyText value={preview.summary.netYuan} />
                    </dd>
                  </div>
                </dl>
              </>
            )}

            {!previewMutation.isPending && !previewMutation.isError && !preview && (
              <div className="emptyInline">
                选择账期后点击「试算」：结果只用于签前核对分润规则，正式结算仍需在结算模块生成。
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="cardHeader">
          <span className="cardTitle">关联项目</span>
          <span className="hint">共 {detail.projects.length} 个</span>
        </div>
        <div className="cardBody">
          <DataTable
            columns={projectColumns}
            rows={detail.projects}
            rowKey={(row) => row.id}
            emptyTitle="暂无关联项目"
            emptyDescription="内容生产通常挂在项目下，创建项目时可关联本合同的达人"
            onRowClick={(row) => navigate(`/projects/${row.id}`)}
            skeletonRows={3}
          />
        </div>
      </div>

      <div className="card">
        <div className="cardHeader">
          <span className="cardTitle">交付与条款</span>
        </div>
        <div className="cardBody">
          <div className="sectionTitle">交付要求</div>
          {detail.deliverableSpec ? (
            /**
             * `deliverableSpec` 后端是 Json 字段（如 { videosPerMonth: 4, platforms: [...] }），
             * 不是字符串，**不能直接渲染** —— React 会抛
             * 「Objects are not valid as a React child」把整个页面打崩。
             *
             * 这里渲染成键值对而不是 JSON.stringify 原始串：运营看的是
             * 「每月 4 条 / 抖音、小红书」，不是一段带引号的花括号。
             */
            <dl className="kvList">
              {Object.entries(detail.deliverableSpec as Record<string, unknown>).map(
                ([key, value]) => (
                  <div className="kvRow" key={key}>
                    <dt className="kvKey">{DELIVERABLE_LABELS[key] ?? key}</dt>
                    <dd className="kvValue">
                      {Array.isArray(value)
                        ? value.join('、')
                        : typeof value === 'object' && value !== null
                          ? JSON.stringify(value)
                          : String(value)}
                    </dd>
                  </div>
                ),
              )}
            </dl>
          ) : (
            <div className="emptyInline">未填写交付要求</div>
          )}

          <div className="divider" />

          <div className="sectionTitle">违约条款</div>
          {detail.breachClause ? (
            <pre className="codeBlock">{detail.breachClause}</pre>
          ) : (
            <div className="emptyInline">未填写违约条款</div>
          )}

          <div className="divider" />

          <div className="sectionTitle">附件</div>
          {detail.attachmentUrls.length > 0 ? (
            <ul className="stack">
              {detail.attachmentUrls.map((url) => (
                <li key={url}>
                  {/* 附件由后端存对象存储，前端只渲染链接；rel=noreferrer 防止 target=_blank 后的 referrer 泄漏 */}
                  <a href={url} target="_blank" rel="noreferrer" className="ellipsis">
                    {url}
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <div className="emptyInline">暂无附件</div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={approveOpen}
        title="审批通过"
        message="通过后合同进入「已通过」状态，可以开始排期与内容生产。审批动作会写入审计日志。"
        confirmText="确认通过"
        loading={reviewMutation.isPending}
        onCancel={() => setApproveOpen(false)}
        onConfirm={() => reviewMutation.mutate({ approved: true })}
      />

      <ConfirmDialog
        open={rejectOpen}
        title="驳回合同"
        message="驳回后合同回到可修改状态，达人负责人会收到通知。请写清驳回理由，理由会展示给拟定人。"
        confirmText="确认驳回"
        danger
        requireReason
        reasonLabel="驳回意见"
        loading={reviewMutation.isPending}
        onCancel={() => setRejectOpen(false)}
        onConfirm={(reason) => reviewMutation.mutate({ approved: false, note: reason })}
      />

      <ConfirmDialog
        open={terminateOpen}
        title="终止合同"
        message="终止后合同不再产生新的结算，已生成的结算单不受影响。该动作不可撤销，请写清终止依据。"
        confirmText="确认终止"
        danger
        requireReason
        reasonLabel="终止原因"
        loading={terminateMutation.isPending}
        onCancel={() => setTerminateOpen(false)}
        onConfirm={(reason) => {
          // requireReason 已保证原因非空，这里再挡一次是为了类型与防御（terminate 接口 reason 必填）
          if (reason) terminateMutation.mutate(reason);
        }}
      />
    </div>
  );
}
