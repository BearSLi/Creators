import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/PageHeader';
import { DataTable, type Column } from '@/components/DataTable';
import { Modal } from '@/components/Modal';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StatusTag } from '@/components/StatusTag';
import { MoneyText, BpText } from '@/components/MoneyText';
import { DetailSkeleton } from '@/components/LoadingSkeleton';
import { ErrorState } from '@/components/EmptyState';
import { PermissionGate } from '@/components/PermissionGate';
import { useToast, AUDIT_WRITTEN_HINT } from '@/components/Toast';
import {
  adjustSettlement,
  approveSettlement,
  disputeSettlement,
  getSettlement,
  paySettlement,
} from '@/api/settlements';
import type { SettlementItem } from '@/api/types';
import { resolveErrorMessage } from '@/api/client';
import {
  SETTLEMENT_ITEM_TYPE_LABELS,
  SETTLEMENT_STATUS_LABELS,
  SETTLEMENT_STATUS_TONES,
} from '@/utils/constants';
import { formatDate, formatDateTime } from '@/utils/format';
import { P } from '@/utils/permissions';

/**
 * 结算单详情。
 *
 * 这个页面唯一的服务对象是"要签字的人"：财务审批 与 审计复核。
 * 所以它的信息结构是"结论 → 依据 → 链路"，而不是"字段罗列"：
 *   1) 顶部金额概览：净应付用大字，其它金额按链路顺序排列；
 *   2) 明细表：每一行都能回答"这笔钱从哪条内容来、四档比率是多少、什么时候算的"；
 *   3) 计算链路：后端返回的 trace 原文（可展开核对的证据）+ 一段人话版的分步说明。
 *
 * 铁律：分步说明里的数字**全部直接取后端字段**，前端只做字符串拼接。
 * 任何"顺手算一下"的行为都会制造第二个口径——一旦界面上出现了后端没算过的数字，
 * 对账时没人能说清哪个是对的。四档比率的加总校验、代扣税的计算，全部由后端负责。
 *
 * 动作都按**状态 + 权限**双重限制：
 *   DRAFT/DISPUTED → 可调整金额；PENDING_APPROVAL → 可审批；
 *   APPROVED → 可标记打款；任意未终结状态 → 可发起争议。
 * 前端隐藏按钮只是体验优化，真正的拦截在后端状态机。
 */

/** 调整金额表单：amount 保持字符串，避免 JS 浮点把 -1.005 变成 -1.0049999 */
interface AdjustForm {
  amount: string;
  reason: string;
}

/** 金额格式：允许负数与最多两位小数，与后端 decimal(…,2) 对齐 */
const AMOUNT_PATTERN = /^-?\d+(\.\d{1,2})?$/;

export default function SettlementDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustForm, setAdjustForm] = useState<AdjustForm>({ amount: '', reason: '' });
  const [approveOpen, setApproveOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [payVoucherUrl, setPayVoucherUrl] = useState('');
  const [disputeOpen, setDisputeOpen] = useState(false);

  const settlementQuery = useQuery({
    queryKey: ['settlements', 'detail', id],
    queryFn: () => getSettlement(id),
    enabled: id !== '',
  });

  /** 所有资金动作成功后统一失效 settlements 缓存并提示审计 */
  const afterMutation = (message: string) => {
    queryClient.invalidateQueries({ queryKey: ['settlements'] });
    toast.success(`${message}，${AUDIT_WRITTEN_HINT}`);
  };

  const adjustMutation = useMutation({
    mutationFn: (payload: AdjustForm) =>
      adjustSettlement(id, { amount: payload.amount.trim(), reason: payload.reason.trim() }),
    onSuccess: () => {
      afterMutation('调整金额已提交');
      setAdjustOpen(false);
      setAdjustForm({ amount: '', reason: '' });
    },
  });

  const approveMutation = useMutation({
    mutationFn: () => approveSettlement(id),
    onSuccess: () => {
      afterMutation('结算单已审批通过');
      setApproveOpen(false);
    },
  });

  const payMutation = useMutation({
    mutationFn: (voucherUrl: string) =>
      paySettlement(id, { paymentVoucherUrl: voucherUrl.trim() || undefined }),
    onSuccess: () => {
      afterMutation('已标记为打款');
      setPayOpen(false);
      setPayVoucherUrl('');
    },
  });

  const disputeMutation = useMutation({
    mutationFn: (reason: string) => disputeSettlement(id, { reason }),
    onSuccess: () => {
      afterMutation('已发起争议');
      setDisputeOpen(false);
    },
  });

  if (settlementQuery.isLoading) {
    return (
      <div className="page">
        <PageHeader title="结算单详情" subtitle="加载中…" />
        <DetailSkeleton />
      </div>
    );
  }

  if (settlementQuery.isError || !settlementQuery.data) {
    return (
      <div className="page">
        <PageHeader title="结算单详情" />
        <div className="card">
          <ErrorState
            message={resolveErrorMessage(settlementQuery.error)}
            onRetry={() => void settlementQuery.refetch()}
          />
        </div>
      </div>
    );
  }

  const settlement = settlementQuery.data;
  const canAdjust = settlement.status === 'DRAFT' || settlement.status === 'DISPUTED';
  const amountValid = AMOUNT_PATTERN.test(adjustForm.amount.trim());
  const reasonValid = adjustForm.reason.trim().length >= 5;

  const itemColumns: Column<SettlementItem>[] = [
    {
      key: 'itemType',
      title: '类型',
      width: 100,
      render: (row) => SETTLEMENT_ITEM_TYPE_LABELS[row.itemType],
    },
    {
      key: 'description',
      title: '说明',
      minWidth: 200,
      render: (row) => row.description,
    },
    {
      key: 'grossAmount',
      title: '流水金额',
      width: 124,
      align: 'right',
      render: (row) => <MoneyText value={row.grossAmount} variant="plain" />,
    },
    {
      key: 'platformFee',
      title: '平台费',
      width: 116,
      align: 'right',
      render: (row) => <MoneyText value={row.platformFee} variant="plain" muted />,
    },
    {
      key: 'talentGross',
      title: '达人应得',
      width: 120,
      align: 'right',
      render: (row) => <MoneyText value={row.talentGross} variant="plain" />,
    },
    {
      key: 'taxWithheld',
      title: '代扣税',
      width: 112,
      align: 'right',
      render: (row) => <MoneyText value={row.taxWithheld} variant="plain" muted />,
    },
    {
      key: 'netPayable',
      title: '净额',
      width: 124,
      align: 'right',
      render: (row) => <MoneyText value={row.netPayable} variant="plain" />,
    },
    {
      key: 'platformFeeBp',
      title: '平台费%',
      width: 92,
      align: 'right',
      tooltip: '基点整数，1000 = 10%',
      render: (row) => <BpText bp={row.platformFeeBp} />,
    },
    {
      key: 'agencyShareBp',
      title: '公司分成%',
      width: 100,
      align: 'right',
      render: (row) => <BpText bp={row.agencyShareBp} />,
    },
    {
      key: 'talentShareBp',
      title: '达人分成%',
      width: 100,
      align: 'right',
      render: (row) => <BpText bp={row.talentShareBp} />,
    },
    {
      key: 'taxWithholdBp',
      title: '代扣税%',
      width: 92,
      align: 'right',
      render: (row) => <BpText bp={row.taxWithholdBp} />,
    },
    {
      key: 'contentId',
      title: '关联内容',
      width: 110,
      render: (row) =>
        row.contentId ? (
          <button
            type="button"
            className="btnLink"
            onClick={(event) => {
              event.stopPropagation();
              navigate(`/contents/${row.contentId}`);
            }}
          >
            查看内容
          </button>
        ) : (
          <span className="subtle">—</span>
        ),
    },
    {
      key: 'contractCode',
      title: '合同编号',
      width: 132,
      render: (row) => (row.contractCode ? <span className="mono">{row.contractCode}</span> : '—'),
    },
    {
      key: 'calculatedAt',
      title: '计算时间',
      width: 156,
      render: (row) => <span className="nowrap">{formatDateTime(row.calculatedAt)}</span>,
    },
  ];

  /** 当前页明细净额合计：只算这一页，跨页合计以后端为准（见页尾说明） */
  const pageItemNetTotal = settlement.items.reduce(
    (sum, item) => sum + (Number(item.netPayable) || 0),
    0,
  );

  return (
    <div className="page">
      <PageHeader
        title={
          <span className="row" style={{ gap: 'var(--space-2)' }}>
            <span className="mono">{settlement.code}</span>
            <StatusTag tone={SETTLEMENT_STATUS_TONES[settlement.status]}>
              {SETTLEMENT_STATUS_LABELS[settlement.status]}
            </StatusTag>
          </span>
        }
        subtitle={
          <span className="row wrap" style={{ gap: 'var(--space-2)' }}>
            <span>{settlement.creatorName}</span>
            <span>·</span>
            <span>
              账期 {formatDate(settlement.periodStart)} ~ {formatDate(settlement.periodEnd)}
            </span>
            <span>·</span>
            <span>共 {settlement.itemCount} 条明细</span>
          </span>
        }
        actions={
          <>
            {canAdjust && (
              <PermissionGate permission={P.SETTLEMENT_EDIT}>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setAdjustForm({ amount: '', reason: '' });
                    setAdjustOpen(true);
                  }}
                >
                  调整金额
                </button>
              </PermissionGate>
            )}
            {settlement.status === 'PENDING_APPROVAL' && (
              <PermissionGate permission={P.SETTLEMENT_APPROVE}>
                <button type="button" className="btn btnPrimary" onClick={() => setApproveOpen(true)}>
                  审批通过
                </button>
              </PermissionGate>
            )}
            {settlement.status === 'APPROVED' && (
              <PermissionGate permission={P.SETTLEMENT_PAY}>
                <button
                  type="button"
                  className="btn btnPrimary"
                  onClick={() => {
                    setPayVoucherUrl(settlement.paymentVoucherUrl ?? '');
                    setPayOpen(true);
                  }}
                >
                  标记已打款
                </button>
              </PermissionGate>
            )}
            {settlement.status !== 'PAID' && settlement.status !== 'VOID' && (
              <PermissionGate permission={P.SETTLEMENT_EDIT}>
                <button type="button" className="btn btnDanger" onClick={() => setDisputeOpen(true)}>
                  发起争议
                </button>
              </PermissionGate>
            )}
          </>
        }
      />

      {/* ---------------- 金额概览 ---------------- */}
      <section className="card">
        <div className="cardBody">
          <div className="rowBetween wrap" style={{ gap: 'var(--space-4)' }}>
            <div>
              <div className="muted" style={{ fontSize: 'var(--font-size-sm)' }}>
                净应付（达人实收）
              </div>
              <div style={{ fontSize: 'var(--font-size-3xl)', fontWeight: 'var(--font-weight-semibold)' }}>
                <MoneyText value={settlement.netPayable} />
              </div>
              <div className="subtle" style={{ fontSize: 'var(--font-size-xs)' }}>
                已包含人工调整 <MoneyText value={settlement.adjustmentAmount} variant="plain" signed />
                ；金额由后端计算，前端仅展示
              </div>
            </div>
            <div className="row wrap" style={{ gap: 'var(--space-5)' }}>
              <div>
                <div className="muted" style={{ fontSize: 'var(--font-size-xs)' }}>
                  流水总额
                </div>
                <MoneyText value={settlement.grossAmount} variant="plain" />
              </div>
              <div>
                <div className="muted" style={{ fontSize: 'var(--font-size-xs)' }}>
                  平台费
                </div>
                <MoneyText value={settlement.platformFee} variant="plain" muted />
              </div>
              <div>
                <div className="muted" style={{ fontSize: 'var(--font-size-xs)' }}>
                  公司分成
                </div>
                <MoneyText value={settlement.agencyShare} variant="plain" muted />
              </div>
              <div>
                <div className="muted" style={{ fontSize: 'var(--font-size-xs)' }}>
                  达人应得
                </div>
                <MoneyText value={settlement.talentGross} variant="plain" />
              </div>
              <div>
                <div className="muted" style={{ fontSize: 'var(--font-size-xs)' }}>
                  代扣税
                </div>
                <MoneyText value={settlement.taxWithheld} variant="plain" muted />
              </div>
              <div>
                <div className="muted" style={{ fontSize: 'var(--font-size-xs)' }}>
                  调整金额
                </div>
                <MoneyText value={settlement.adjustmentAmount} variant="plain" signed />
              </div>
            </div>
          </div>

          <dl className="descriptions" style={{ marginTop: 'var(--space-5)' }}>
            <div className="descriptionsItem">
              <dt>结算单号</dt>
              <dd className="mono">{settlement.code}</dd>
            </div>
            <div className="descriptionsItem">
              <dt>状态</dt>
              <dd>
                <StatusTag tone={SETTLEMENT_STATUS_TONES[settlement.status]}>
                  {SETTLEMENT_STATUS_LABELS[settlement.status]}
                </StatusTag>
              </dd>
            </div>
            <div className="descriptionsItem">
              <dt>应付款日</dt>
              <dd>{formatDate(settlement.dueDate)}</dd>
            </div>
            <div className="descriptionsItem">
              <dt>创建时间</dt>
              <dd>{formatDateTime(settlement.createdAt)}</dd>
            </div>
            <div className="descriptionsItem">
              <dt>审批人</dt>
              <dd>{settlement.approvedBy?.name ?? '尚未审批'}</dd>
            </div>
            <div className="descriptionsItem">
              <dt>审批时间</dt>
              <dd>{formatDateTime(settlement.approvedAt)}</dd>
            </div>
            <div className="descriptionsItem">
              <dt>打款时间</dt>
              <dd>{formatDateTime(settlement.paidAt)}</dd>
            </div>
            <div className="descriptionsItem">
              <dt>打款凭证</dt>
              <dd>
                {settlement.paymentVoucherUrl ? (
                  <a href={settlement.paymentVoucherUrl} target="_blank" rel="noreferrer noopener">
                    查看凭证
                  </a>
                ) : (
                  <span className="subtle">未上传</span>
                )}
              </dd>
            </div>
            <div className="descriptionsItem" style={{ gridColumn: '1 / -1' }}>
              <dt>争议原因</dt>
              <dd style={{ whiteSpace: 'pre-wrap', color: settlement.disputeReason ? 'var(--color-danger)' : undefined }}>
                {settlement.disputeReason ?? '—'}
              </dd>
            </div>
            <div className="descriptionsItem" style={{ gridColumn: '1 / -1' }}>
              <dt>备注</dt>
              <dd style={{ whiteSpace: 'pre-wrap' }}>{settlement.remark ?? '—'}</dd>
            </div>
          </dl>
        </div>
      </section>

      {/* ---------------- 计算链路 ---------------- */}
      <section className="card">
        <div className="cardHeader">
          <span className="cardTitle">计算链路</span>
          <span className="subtle" style={{ fontSize: 'var(--font-size-xs)' }}>
            数字全部来自后端返回字段，前端只做拼接展示
          </span>
        </div>
        <div className="cardBody">
          <div className="stack">
            <div className="row wrap" style={{ gap: 'var(--space-3)' }}>
              <span className="muted">① 流水总额</span>
              <MoneyText value={settlement.grossAmount} variant="plain" />
              <span className="muted">− ② 平台费</span>
              <MoneyText value={settlement.platformFee} variant="plain" />
              <span className="muted">= ③ 达人分成基数（达人应得）</span>
              <MoneyText value={settlement.talentGross} variant="plain" />
            </div>
            <div className="row wrap" style={{ gap: 'var(--space-3)' }}>
              <span className="muted">③ 达人分成基数</span>
              <MoneyText value={settlement.talentGross} variant="plain" />
              <span className="muted">− ④ 代扣税</span>
              <MoneyText value={settlement.taxWithheld} variant="plain" />
              <span className="muted">= ⑤ 净应付</span>
              <MoneyText value={settlement.netPayable} />
            </div>
            <div className="row wrap" style={{ gap: 'var(--space-3)' }}>
              <span className="muted">公司分成</span>
              <MoneyText value={settlement.agencyShare} variant="plain" muted />
              <span className="muted">人工调整</span>
              <MoneyText value={settlement.adjustmentAmount} variant="plain" signed />
            </div>
            <p className="subtle" style={{ fontSize: 'var(--font-size-xs)', margin: 0 }}>
              上述数字按结算单维度取后端字段；明细层面的四档比率与逐条金额见下表，
              前端不复算、不校验合计差额，若发现不一致请以「计算链路」原文与后端对账为准。
            </p>
          </div>

          <div style={{ marginTop: 'var(--space-4)' }}>
            <div className="sectionTitle">后端计算链路原文（calculationTrace）</div>
            {settlement.calculationTrace ? (
              <pre className="codeBlock">{JSON.stringify(settlement.calculationTrace, null, 2)}</pre>
            ) : (
              <div className="emptyInline">后端未返回计算链路（旧单据或按固定费用结算）</div>
            )}
          </div>
        </div>
      </section>

      {/* ---------------- 明细 ---------------- */}
      <section style={{ marginTop: 'var(--space-5)' }}>
        <h2 className="sectionTitle">结算明细（{settlement.items.length} 条）</h2>
        <DataTable<SettlementItem>
          columns={itemColumns}
          rows={settlement.items}
          rowKey={(row) => row.id}
          emptyTitle="该结算单没有明细"
          emptyDescription="按流水生成的结算单至少应有一条内容分成明细，请联系后端核查"
          stickyHeader
          footer={
            <div className="row wrap" style={{ gap: 'var(--space-3)' }}>
              <span className="muted" style={{ fontSize: 'var(--font-size-sm)' }}>
                当前页明细合计（净额）
              </span>
              <MoneyText value={pageItemNetTotal.toFixed(2)} />
              <span className="subtle" style={{ fontSize: 'var(--font-size-xs)' }}>
                仅当前页合计；整单净额以上方「净应付」字段为准，前端不做全量加总
              </span>
            </div>
          }
        />
      </section>

      {/* ---------------- 调整金额 ---------------- */}
      <Modal
        open={adjustOpen}
        title="调整结算金额"
        description="金额可正可负，提交后由后端重新计算净应付；原因会写入审计日志"
        onClose={adjustMutation.isPending ? () => undefined : () => setAdjustOpen(false)}
        footer={
          <>
            <button
              type="button"
              className="btn"
              onClick={() => setAdjustOpen(false)}
              disabled={adjustMutation.isPending}
            >
              取消
            </button>
            <button
              type="button"
              className="btn btnPrimary"
              disabled={adjustMutation.isPending || !amountValid || !reasonValid}
              onClick={() => adjustMutation.mutate(adjustForm)}
            >
              {adjustMutation.isPending && <span className="spinner" aria-hidden="true" />}
              提交调整
            </button>
          </>
        }
      >
        <div className="formGrid">
          <div className="field">
            <label className="label labelRequired" htmlFor="adjust-amount">
              调整金额（元）
            </label>
            <input
              id="adjust-amount"
              className="input"
              inputMode="decimal"
              value={adjustForm.amount}
              placeholder="例：-500 或 1200.50"
              onChange={(event) => setAdjustForm({ ...adjustForm, amount: event.target.value })}
            />
            {/* 金额以字符串提交并做格式校验：用 number 输入会让 -1.005 变成 -1.0049999 */}
            {adjustForm.amount.trim() !== '' && !amountValid ? (
              <span className="errorText">格式需为最多两位小数的数字，可带负号，如 -500 / 1200.50</span>
            ) : (
              <span className="hint">支持负数（扣减）；提交的是字符串，前端不做任何运算</span>
            )}
          </div>
          <div className="field fieldFull">
            <label className="label labelRequired" htmlFor="adjust-reason">
              调整原因
            </label>
            <textarea
              id="adjust-reason"
              className="textarea"
              rows={3}
              value={adjustForm.reason}
              placeholder="例：6 月 12 日视频因平台限流未达保底播放量，按合同扣减 500 元"
              onChange={(event) => setAdjustForm({ ...adjustForm, reason: event.target.value })}
            />
            <span className={reasonValid ? 'hint' : 'errorText'}>
              原因至少 5 个字，当前 {adjustForm.reason.trim().length} 字；会写入审计日志
            </span>
          </div>
        </div>
      </Modal>

      {/* ---------------- 审批通过 ---------------- */}
      <ConfirmDialog
        open={approveOpen}
        title="审批通过结算单"
        confirmText="确认审批通过"
        loading={approveMutation.isPending}
        message={
          <>
            审批通过后结算单进入「已审批」，金额与明细将被锁定，不能再用「调整金额」自行修改
            （如需变更只能作废后重新生成）。
            <br />
            本次审批将记录审批人与审批时间，并写入审计日志。
          </>
        }
        onCancel={() => setApproveOpen(false)}
        onConfirm={() => approveMutation.mutate()}
      />

      {/* ---------------- 标记打款 ---------------- */}
      <Modal
        open={payOpen}
        title="标记已打款"
        description={`确认已向 ${settlement.creatorName} 支付净应付金额`}
        onClose={payMutation.isPending ? () => undefined : () => setPayOpen(false)}
        footer={
          <>
            <button
              type="button"
              className="btn"
              onClick={() => setPayOpen(false)}
              disabled={payMutation.isPending}
            >
              取消
            </button>
            <button
              type="button"
              className="btn btnPrimary"
              disabled={payMutation.isPending}
              onClick={() => payMutation.mutate(payVoucherUrl)}
            >
              {payMutation.isPending && <span className="spinner" aria-hidden="true" />}
              确认已打款
            </button>
          </>
        }
      >
        <div className="rowBetween" style={{ marginBottom: 'var(--space-3)' }}>
          <span className="muted">本次打款金额</span>
          <MoneyText value={settlement.netPayable} />
        </div>
        <div className="field">
          <label className="label" htmlFor="pay-voucher">
            打款凭证链接（选填）
          </label>
          <input
            id="pay-voucher"
            className="input"
            value={payVoucherUrl}
            placeholder="银行回单/内部付款单的链接"
            onChange={(event) => setPayVoucherUrl(event.target.value)}
          />
          <span className="hint">
            留空表示暂未上传凭证；凭证是审计复核的关键证据，建议尽量补齐
          </span>
        </div>
      </Modal>

      {/* ---------------- 发起争议 ---------------- */}
      <ConfirmDialog
        open={disputeOpen}
        title="发起争议"
        danger
        confirmText="发起争议"
        loading={disputeMutation.isPending}
        requireReason
        reasonLabel="争议原因"
        reasonPlaceholder="例：达人反馈 6 月 5 日视频未计入流水，需核对平台后台数据"
        message={
          <>
            发起争议后结算单进入「争议中」，可继续用「调整金额」修正，但不能再提交审批，
            直到争议解决。
            <br />
            原因会同步给相关同事并写入审计日志，请写清具体差异点。
          </>
        }
        onCancel={() => setDisputeOpen(false)}
        onConfirm={(reason) => {
          if (reason) disputeMutation.mutate(reason);
        }}
      />
    </div>
  );
}
