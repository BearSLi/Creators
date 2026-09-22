import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/PageHeader';
import { DetailSkeleton } from '@/components/LoadingSkeleton';
import { ErrorState } from '@/components/EmptyState';
import { AUDIT_WRITTEN_HINT, useToast } from '@/components/Toast';
import { resolveErrorMessage } from '@/api/client';
import { createContract, getContract, updateContract } from '@/api/contracts';
import type { ContractDetail, CreateContractRequest, SettlementMode } from '@/api/types';
import { SETTLEMENT_MODE_OPTIONS } from '@/utils/constants';
import { formatBp } from '@/utils/format';
import { applyServerFieldErrors } from '@/utils/formErrors';

/**
 * 合同新建 / 编辑页。
 *
 * 分润校验是这一页的重点（也是最容易出资金事故的地方）：
 *   1) 金额与比率都是"后端口径"的原始值：fixedFee 是字符串元（两位小数），
 *      四档分成是基点整数，前端只校验格式与自洽性，不做任何金额换算回写；
 *   2) 比率必须自洽：平台费 + 公司分成 ≤ 100%，达人分成 + 代扣 ≤ 100%
 *      （后端另有一条"公司分成 + 达人分成 ≤ 可分配净额 100%"，这里也一并拦住，
 *      否则用户填得出来、提交必 400）；
 *   3) 超限时不仅红字提示，还直接禁用提交：资金类表单让用户"提交后才被拒"是不可接受的；
 *   4) 比例条用两条 100% 口径的横向条分别画"平台侧"和"达人侧"：
 *      四档不是同一个分母（平台费从流水扣、公司/达人在可分配净额上分、代扣在达人所得上扣），
 *      把四条塞进一根条里会画出误导性的比例关系。
 */

type ContractFormState = {
  creatorId: string;
  brandId: string;
  title: string;
  /** 空串 = 未选择（表单校验会给提示）；非空时必须是后端 SettlementMode 的成员 */
  settlementMode: SettlementMode | '';
  currency: string;
  fixedFee: string;
  platformFeeBp: string;
  agencyShareBp: string;
  talentShareBp: string;
  taxWithholdBp: string;
  effectiveFrom: string;
  effectiveTo: string;
  exclusivity: boolean;
  deliverableSpec: string;
  breachClause: string;
  /** 多行文本，一行一个 URL */
  attachmentUrls: string;
};

type RatioSegment = {
  key: string;
  label: string;
  bp: number;
  color: string;
};

type RatioCheck = {
  platform: number;
  agency: number;
  talent: number;
  tax: number;
  issues: string[];
};

/** 固定费用格式：字符串元，最多两位小数（与后端 decimal 列一致） */
const FIXED_FEE_PATTERN = /^\d+(\.\d{1,2})?$/;

/**
 * 默认四档取需求里的示例口径（平台费 10% / 公司 30% / 达人 70% / 代扣 6%）。
 * 四档全 0 的新建表单会让试算结果全是 0，用户往往误以为功能坏了。
 */
const EMPTY_FORM: ContractFormState = {
  creatorId: '',
  brandId: '',
  title: '',
  // 后端 enum SettlementMode 是 FIXED_FEE，不是 FIXED（早期写成 'FIXED' 提交必然 400）
  settlementMode: 'FIXED_FEE',
  currency: 'CNY',
  fixedFee: '',
  platformFeeBp: '1000',
  agencyShareBp: '3000',
  talentShareBp: '7000',
  taxWithholdBp: '600',
  effectiveFrom: '',
  effectiveTo: '',
  exclusivity: false,
  deliverableSpec: '',
  breachClause: '',
  attachmentUrls: '',
};

function optional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** 基点输入 → 整数；空串按 0 处理（不填即不分成） */
function parseBp(value: string): number {
  const trimmed = value.trim();
  if (trimmed === '') return 0;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

/** 单个基点字段的格式校验 */
function bpFieldError(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return '基点必须是整数（1000 = 10%）';
  }
  if (parsed < 0 || parsed > 10_000) return '基点需要在 0 ~ 10000 之间';
  return null;
}

/** 比率自洽性检查：既用于实时红字提示，也用于禁用提交 */
function checkRatios(form: ContractFormState): RatioCheck {
  const platform = parseBp(form.platformFeeBp);
  const agency = parseBp(form.agencyShareBp);
  const talent = parseBp(form.talentShareBp);
  const tax = parseBp(form.taxWithholdBp);
  const issues: string[] = [];

  if (platform + agency > 10_000) {
    issues.push(
      `平台费 ${formatBp(platform)} + 公司分成 ${formatBp(agency)} = ${formatBp(platform + agency)}，超过 100%`,
    );
  }
  if (talent + tax > 10_000) {
    issues.push(
      `达人分成 ${formatBp(talent)} + 代扣 ${formatBp(tax)} = ${formatBp(talent + tax)}，超过 100%`,
    );
  }
  if (agency + talent > 10_000) {
    issues.push(
      `公司分成 ${formatBp(agency)} + 达人分成 ${formatBp(talent)} = ${formatBp(agency + talent)}，` +
        '超过可分配净额的 100%（后端结算口径，先扣平台费再分成的部分）',
    );
  }

  return { platform, agency, talent, tax, issues };
}

/** 多行文本 → URL 数组，过滤空行 */
function parseLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function toFormState(detail: ContractDetail): ContractFormState {
  return {
    creatorId: detail.creatorId,
    brandId: detail.brandId ?? '',
    title: detail.title,
    settlementMode: detail.settlementMode,
    currency: detail.currency,
    // 金额原样回填，不做 Number 转换，避免把 '12800.00' 变成 '12800' 造成对账歧义
    fixedFee: detail.fixedFee,
    platformFeeBp: String(detail.platformFeeBp),
    agencyShareBp: String(detail.agencyShareBp),
    talentShareBp: String(detail.talentShareBp),
    taxWithholdBp: String(detail.taxWithholdBp),
    effectiveFrom: detail.effectiveFrom,
    effectiveTo: detail.effectiveTo ?? '',
    exclusivity: detail.exclusivity,
    deliverableSpec: serializeDeliverableSpec(detail.deliverableSpec),
    breachClause: detail.breachClause ?? '',
    attachmentUrls: detail.attachmentUrls.join('\n'),
  };
}

/**
 * 「交付要求」的输入/输出转换。
 *
 * 后端 `deliverableSpec` 是 Json 对象（如 `{ videosPerMonth: 4, platforms: [...] }`），
 * 而文本框只能给字符串。这里约定一种**运营可手写**的格式，避免让人去写 JSON：
 *
 * ```
 * 每月条数 = 4
 * 发布平台 = 抖音、小红书
 * ```
 *
 * 转换规则：
 *   - 用第一个 `=` 或 `：` 分隔键值（值里含 `=` 不受影响）；
 *   - 多个值用中文顿号/逗号分隔时转成数组（后端模板里 platforms 期望数组）；
 *   - 纯数字值转 number（videosPerMonth 期望数字）；
 *   - 整段留空返回 undefined（表示「不提供该字段」，而不是空对象）。
 *
 * 为什么不让用户填 JSON：这是运营在用的表单，JSON 引号/逗号错一个字符就报错，
 * 而且报错信息（400）不会指出是哪个字段格式不对。
 */
function parseDeliverableSpec(input: string): Record<string, unknown> | undefined {
  const text = input.trim();
  if (text === '') return undefined;

  const result: Record<string, unknown> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;

    // 兼容全角冒号与等号两种写法
    const separatorIndex = Math.min(
      ...[line.indexOf('='), line.indexOf('：')].filter((index) => index >= 0).concat([Number.MAX_SAFE_INTEGER]),
    );
    if (separatorIndex === Number.MAX_SAFE_INTEGER) {
      // 没有分隔符：按「说明文本」处理，避免整行被丢掉
      result.note = result.note ? `${result.note}\n${line}` : line;
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1).trim();
    if (key === '') continue;

    const parts = rawValue.split(/[、,，]/).map((part) => part.trim()).filter((part) => part !== '');
    if (parts.length > 1) {
      result[key] = parts;
    } else if (parts.length === 1 && /^\d+$/.test(parts[0])) {
      result[key] = Number.parseInt(parts[0], 10);
    } else {
      result[key] = parts[0] ?? '';
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/** 对象 → 文本（编辑态回填），与 parseDeliverableSpec 互逆 */
function serializeDeliverableSpec(spec: Record<string, unknown> | null | undefined): string {
  if (!spec) return '';
  return Object.entries(spec)
    .map(([key, value]) => {
      const rendered = Array.isArray(value) ? value.join('、') : String(value ?? '');
      return `${key} = ${rendered}`;
    })
    .join('\n');
}

function buildPayload(form: ContractFormState): CreateContractRequest {
  const ratios = checkRatios(form);
  return {
    creatorId: form.creatorId.trim(),
    brandId: optional(form.brandId),
    title: form.title.trim(),
    // 校验已保证非空，这里用断言收口；类型收紧后写错枚举值会直接编译失败
    settlementMode: form.settlementMode as SettlementMode,
    currency: form.currency.trim() || 'CNY',
    fixedFee: form.fixedFee.trim(),
    platformFeeBp: ratios.platform,
    agencyShareBp: ratios.agency,
    talentShareBp: ratios.talent,
    taxWithholdBp: ratios.tax,
    effectiveFrom: form.effectiveFrom,
    effectiveTo: optional(form.effectiveTo),
    exclusivity: form.exclusivity,
    // 必须转成对象：后端 deliverableSpec 是 Json 字段，传字符串会被 400 拒绝
    deliverableSpec: parseDeliverableSpec(form.deliverableSpec),
    breachClause: optional(form.breachClause),
    attachmentUrls: parseLines(form.attachmentUrls),
  };
}

function validate(form: ContractFormState): Record<string, string> {
  const errors: Record<string, string> = {};

  if (form.creatorId.trim() === '') errors.creatorId = '达人 ID 必填';
  if (form.title.trim() === '') errors.title = '合同标题必填';
  if (form.settlementMode === '') errors.settlementMode = '请选择结算方式';

  const fixedFee = form.fixedFee.trim();
  if (fixedFee === '') {
    errors.fixedFee = '固定费用必填，无固定费用请填 0';
  } else if (!FIXED_FEE_PATTERN.test(fixedFee)) {
    errors.fixedFee = '金额格式不正确（最多两位小数，例如 12800.00）';
  }

  if (form.effectiveFrom === '') errors.effectiveFrom = '生效开始日期必填';
  if (
    form.effectiveFrom !== '' &&
    form.effectiveTo !== '' &&
    form.effectiveTo < form.effectiveFrom
  ) {
    errors.effectiveTo = '结束日期不能早于开始日期';
  }

  (['platformFeeBp', 'agencyShareBp', 'talentShareBp', 'taxWithholdBp'] as const).forEach((key) => {
    const message = bpFieldError(form[key]);
    if (message) errors[key] = message;
  });

  const ratios = checkRatios(form);
  if (ratios.issues.length > 0) {
    // 具体原因在比率区实时展示，这里只负责让提交被拦住
    errors.ratios = ratios.issues[0];
  }

  const invalidUrls = parseLines(form.attachmentUrls).filter((url) => !/^https?:\/\//i.test(url));
  if (invalidUrls.length > 0) {
    errors.attachmentUrls = `附件链接需要以 http(s):// 开头：${invalidUrls[0]}`;
  }

  return errors;
}

/** 横向占比条：纯 div 宽度百分比 + CSS 变量配色，容器 overflow 兜底超限的情况 */
function RatioBar({
  title,
  hint,
  segments,
  over,
}: {
  title: string;
  hint: string;
  segments: RatioSegment[];
  over: boolean;
}) {
  const filled = segments.reduce((sum, item) => sum + Math.max(0, item.bp), 0);
  const remainder = Math.max(0, 10_000 - filled);

  return (
    <div className="stack" style={{ gap: 'var(--space-1)' }}>
      <div className="rowBetween wrap">
        <span className="label">{title}</span>
        <span className="hint">{hint}</span>
      </div>
      <div
        style={{
          display: 'flex',
          height: 12,
          borderRadius: 'var(--radius-pill)',
          overflow: 'hidden',
          background: 'var(--color-bg-subtle)',
          border: `1px solid ${over ? 'var(--color-danger)' : 'var(--color-border)'}`,
        }}
      >
        {segments.map((item) => (
          <div
            key={item.key}
            title={`${item.label} ${formatBp(item.bp)}`}
            style={{ width: `${Math.max(0, item.bp) / 100}%`, background: item.color }}
          />
        ))}
        {remainder > 0 && <div style={{ width: `${remainder / 100}%` }} />}
      </div>
      <div className="row wrap" style={{ gap: 'var(--space-3)' }}>
        {segments.map((item) => (
          <span key={item.key} className="row" style={{ gap: 'var(--space-1)' }}>
            <span
              aria-hidden="true"
              style={{
                display: 'inline-block',
                width: 10,
                height: 10,
                borderRadius: 'var(--radius-xs)',
                background: item.color,
              }}
            />
            <span className="hint">
              {item.label} {formatBp(item.bp)}
            </span>
          </span>
        ))}
        <span className="hint">未分配 {formatBp(remainder)}</span>
      </div>
    </div>
  );
}

export default function ContractFormPage() {
  const { id } = useParams<{ id: string }>();
  const contractId = id ?? '';
  const isEdit = contractId !== '';
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [form, setForm] = useState<ContractFormState>(EMPTY_FORM);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const detailQuery = useQuery({
    queryKey: ['contracts', 'detail', contractId],
    queryFn: () => getContract(contractId),
    enabled: isEdit,
  });

  /** 只回填一次，避免 react-query 重新取数把用户正在编辑的比率覆盖掉 */
  const hydratedRef = useRef<string | null>(null);
  useEffect(() => {
    const detail = detailQuery.data;
    if (!detail || hydratedRef.current === detail.id) return;
    hydratedRef.current = detail.id;
    setForm(toFormState(detail));
  }, [detailQuery.data]);

  const saveMutation = useMutation({
    mutationFn: (payload: CreateContractRequest) =>
      isEdit ? updateContract(contractId, payload) : createContract(payload),
    onSuccess: (detail) => {
      queryClient.invalidateQueries({ queryKey: ['contracts'] });
      queryClient.invalidateQueries({ queryKey: ['contracts', 'detail', detail.id] });
      toast.success(`${isEdit ? '合同已更新' : '合同已创建'}，${AUDIT_WRITTEN_HINT}`);
      navigate(`/contracts/${detail.id}`);
    },
    /**
     * 后端校验失败时把 fieldErrors 落到对应输入框上。
     *
     * 前端本地 validate() 拦不住的情况（DTO 与本地规则不一致、新增约束）过去只有一个
     * 全局 toast，且提示「请检查标红字段」却从不标红。现在字段名直接对应，
     * 用户能立刻看到是哪一项不合格。
     */
    onError: (error) => {
      const marked = applyServerFieldErrors(error, setErrors);
      // 字段已标红时不再补通用提示，避免同一条原因说两遍
      if (marked.length === 0) toast.error(resolveErrorMessage(error));
    },
  });

  const updateField = (patch: Partial<ContractFormState>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  };

  const ratio = checkRatios(form);
  const ratioBlocked = ratio.issues.length > 0;

  const platformSegments: RatioSegment[] = [
    { key: 'platformFeeBp', label: '平台费', bp: ratio.platform, color: 'var(--color-primary-500)' },
    { key: 'agencyShareBp', label: '公司分成', bp: ratio.agency, color: 'var(--color-info)' },
  ];
  const talentSegments: RatioSegment[] = [
    { key: 'talentShareBp', label: '达人分成', bp: ratio.talent, color: 'var(--color-success)' },
    { key: 'taxWithholdBp', label: '代扣税', bp: ratio.tax, color: 'var(--color-warning)' },
  ];

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors = validate(form);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      toast.warning('还有未通过校验的字段，请检查标红项');
      return;
    }
    saveMutation.mutate(buildPayload(form));
  };

  if (isEdit && detailQuery.isLoading) {
    return (
      <div className="page">
        <PageHeader title="编辑合同" subtitle="正在加载合同信息…" />
        <DetailSkeleton />
      </div>
    );
  }

  if (isEdit && detailQuery.isError) {
    return (
      <div className="page">
        <PageHeader title="编辑合同" />
        <div className="card">
          <ErrorState
            message={resolveErrorMessage(detailQuery.error)}
            onRetry={() => void detailQuery.refetch()}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title={isEdit ? `编辑合同 · ${form.title || '未命名'}` : '拟定合同'}
        subtitle="金额为字符串元、比率为基点整数（1000 = 10%）；提交后仍需走审批流程"
        actions={
          <Link className="btn" to={isEdit ? `/contracts/${contractId}` : '/contracts'}>
            返回
          </Link>
        }
      />

      <form onSubmit={handleSubmit}>
        <div className="card">
          <div className="cardHeader">
            <span className="cardTitle">基本信息</span>
          </div>
          <div className="cardBody">
            <div className="formGrid">
              <div className="field">
                <label className="label labelRequired" htmlFor="contract-creator">
                  达人 ID
                </label>
                <input
                  id="contract-creator"
                  className={`input mono ${errors.creatorId ? 'inputError' : ''}`}
                  value={form.creatorId}
                  placeholder="达人 UUID"
                  onChange={(event) => updateField({ creatorId: event.target.value })}
                />
                {errors.creatorId ? (
                  <span className="errorText">{errors.creatorId}</span>
                ) : (
                  <span className="hint">
                    后端未提供达人下拉接口，请从达人详情页地址栏复制 UUID
                  </span>
                )}
              </div>

              <div className="field">
                <label className="label" htmlFor="contract-brand">
                  品牌 ID
                </label>
                <input
                  id="contract-brand"
                  className="input mono"
                  value={form.brandId}
                  placeholder="品牌 UUID，选填"
                  onChange={(event) => updateField({ brandId: event.target.value })}
                />
                <span className="hint">无需品牌时留空（例如纯自营内容合作）</span>
              </div>

              <div className="field fieldFull">
                <label className="label labelRequired" htmlFor="contract-title">
                  合同标题
                </label>
                <input
                  id="contract-title"
                  className={`input ${errors.title ? 'inputError' : ''}`}
                  value={form.title}
                  placeholder="例如：2024 年 6 月 美丽雅洗碗布 抖音种草合作"
                  onChange={(event) => updateField({ title: event.target.value })}
                />
                {errors.title && <span className="errorText">{errors.title}</span>}
              </div>

              <div className="field">
                <label className="label labelRequired" htmlFor="contract-mode">
                  结算方式
                </label>
                <select
                  id="contract-mode"
                  className={`select ${errors.settlementMode ? 'inputError' : ''}`}
                  value={form.settlementMode}
                  onChange={(event) =>
                    updateField({ settlementMode: event.target.value as SettlementMode })
                  }
                >
                  {SETTLEMENT_MODE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                {errors.settlementMode && <span className="errorText">{errors.settlementMode}</span>}
              </div>

              <div className="field">
                <label className="label" htmlFor="contract-currency">
                  币种
                </label>
                <input
                  id="contract-currency"
                  className="input mono"
                  value={form.currency}
                  onChange={(event) => updateField({ currency: event.target.value })}
                />
                <span className="hint">默认 CNY，跨境合作可改为 USD 等</span>
              </div>

              <div className="field">
                <label className="label labelRequired" htmlFor="contract-fixed-fee">
                  固定费用（元）
                </label>
                <input
                  id="contract-fixed-fee"
                  className={`input mono ${errors.fixedFee ? 'inputError' : ''}`}
                  value={form.fixedFee}
                  placeholder="例如 12800.00"
                  onChange={(event) => updateField({ fixedFee: event.target.value })}
                />
                {errors.fixedFee ? (
                  <span className="errorText">{errors.fixedFee}</span>
                ) : (
                  <span className="hint">字符串元，最多两位小数；纯分成合作填 0</span>
                )}
              </div>

              <div className="field">
                <label className="label labelRequired" htmlFor="contract-effective-from">
                  生效开始
                </label>
                <input
                  id="contract-effective-from"
                  type="date"
                  className={`input ${errors.effectiveFrom ? 'inputError' : ''}`}
                  value={form.effectiveFrom}
                  onChange={(event) => updateField({ effectiveFrom: event.target.value })}
                />
                {errors.effectiveFrom && <span className="errorText">{errors.effectiveFrom}</span>}
              </div>

              <div className="field">
                <label className="label" htmlFor="contract-effective-to">
                  生效结束
                </label>
                <input
                  id="contract-effective-to"
                  type="date"
                  className={`input ${errors.effectiveTo ? 'inputError' : ''}`}
                  value={form.effectiveTo}
                  min={form.effectiveFrom || undefined}
                  onChange={(event) => updateField({ effectiveTo: event.target.value })}
                />
                {errors.effectiveTo ? (
                  <span className="errorText">{errors.effectiveTo}</span>
                ) : (
                  <span className="hint">留空表示长期有效</span>
                )}
              </div>

              <div className="field fieldFull">
                <label className="checkboxRow" htmlFor="contract-exclusivity">
                  <input
                    id="contract-exclusivity"
                    type="checkbox"
                    checked={form.exclusivity}
                    onChange={(event) => updateField({ exclusivity: event.target.checked })}
                  />
                  独家合作（合同期内不得接同类竞品）
                </label>
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="cardHeader">
            <span className="cardTitle">分润比率</span>
            <span className="hint">基点整数：1000 = 10%</span>
          </div>
          <div className="cardBody">
            <div className="formGrid">
              <div className="field">
                <label className="label" htmlFor="contract-platform-fee">
                  平台费（bp）
                </label>
                <input
                  id="contract-platform-fee"
                  type="number"
                  min={0}
                  max={10000}
                  className={`input mono ${errors.platformFeeBp ? 'inputError' : ''}`}
                  value={form.platformFeeBp}
                  onChange={(event) => updateField({ platformFeeBp: event.target.value })}
                />
                {errors.platformFeeBp ? (
                  <span className="errorText">{errors.platformFeeBp}</span>
                ) : (
                  <span className="hint">当前 {formatBp(ratio.platform)}</span>
                )}
              </div>

              <div className="field">
                <label className="label" htmlFor="contract-agency-share">
                  公司分成（bp）
                </label>
                <input
                  id="contract-agency-share"
                  type="number"
                  min={0}
                  max={10000}
                  className={`input mono ${errors.agencyShareBp ? 'inputError' : ''}`}
                  value={form.agencyShareBp}
                  onChange={(event) => updateField({ agencyShareBp: event.target.value })}
                />
                {errors.agencyShareBp ? (
                  <span className="errorText">{errors.agencyShareBp}</span>
                ) : (
                  <span className="hint">当前 {formatBp(ratio.agency)}</span>
                )}
              </div>

              <div className="field">
                <label className="label" htmlFor="contract-talent-share">
                  达人分成（bp）
                </label>
                <input
                  id="contract-talent-share"
                  type="number"
                  min={0}
                  max={10000}
                  className={`input mono ${errors.talentShareBp ? 'inputError' : ''}`}
                  value={form.talentShareBp}
                  onChange={(event) => updateField({ talentShareBp: event.target.value })}
                />
                {errors.talentShareBp ? (
                  <span className="errorText">{errors.talentShareBp}</span>
                ) : (
                  <span className="hint">当前 {formatBp(ratio.talent)}</span>
                )}
              </div>

              <div className="field">
                <label className="label" htmlFor="contract-tax-withhold">
                  代扣税（bp）
                </label>
                <input
                  id="contract-tax-withhold"
                  type="number"
                  min={0}
                  max={10000}
                  className={`input mono ${errors.taxWithholdBp ? 'inputError' : ''}`}
                  value={form.taxWithholdBp}
                  onChange={(event) => updateField({ taxWithholdBp: event.target.value })}
                />
                {errors.taxWithholdBp ? (
                  <span className="errorText">{errors.taxWithholdBp}</span>
                ) : (
                  <span className="hint">当前 {formatBp(ratio.tax)}</span>
                )}
              </div>
            </div>

            <div className="divider" />

            {/* 实时换算预览：让用户用"百分比"而不是"基点"理解自己填了什么 */}
            <p className="muted">
              平台费 {formatBp(ratio.platform)} / 公司 {formatBp(ratio.agency)} / 达人{' '}
              {formatBp(ratio.talent)} / 代扣 {formatBp(ratio.tax)}
            </p>

            <div className="stack" style={{ marginTop: 'var(--space-4)' }}>
              <RatioBar
                title="平台侧：平台费 + 公司分成"
                hint="两项合计不得超过 100%"
                segments={platformSegments}
                over={ratio.platform + ratio.agency > 10_000}
              />
              <RatioBar
                title="达人侧：达人分成 + 代扣"
                hint="两项合计不得超过 100%"
                segments={talentSegments}
                over={ratio.talent + ratio.tax > 10_000}
              />
            </div>

            {ratioBlocked && (
              <div className="stack" style={{ marginTop: 'var(--space-3)', gap: 'var(--space-1)' }}>
                {ratio.issues.map((issue) => (
                  <span className="errorText" key={issue}>
                    {issue}
                  </span>
                ))}
                <span className="errorText">比率不自洽，已禁用提交；请调整后再保存。</span>
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="cardHeader">
            <span className="cardTitle">交付与条款</span>
          </div>
          <div className="cardBody">
            <div className="formGrid">
              <div className="field fieldFull">
                <label className="label" htmlFor="contract-deliverable">
                  交付要求
                </label>
                <textarea
                  id="contract-deliverable"
                  className="textarea"
                  rows={4}
                  value={form.deliverableSpec}
                  placeholder={'每行一条，格式「字段 = 值」，例如：\n每月条数 = 4\n发布平台 = 抖音、小红书'}
                  onChange={(event) => updateField({ deliverableSpec: event.target.value })}
                />
                <p className="fieldHint">
                  用「字段 = 值」逐行填写；多个值用顿号分隔会自动存为数组。留空表示未约定。
                </p>
              </div>

              <div className="field fieldFull">
                <label className="label" htmlFor="contract-breach">
                  违约条款
                </label>
                <textarea
                  id="contract-breach"
                  className="textarea"
                  rows={4}
                  value={form.breachClause}
                  placeholder="延期发布、数据造假、私下接竞品等情形下的处理方式"
                  onChange={(event) => updateField({ breachClause: event.target.value })}
                />
              </div>

              <div className="field fieldFull">
                <label className="label" htmlFor="contract-attachments">
                  附件链接
                </label>
                <textarea
                  id="contract-attachments"
                  className={`textarea ${errors.attachmentUrls ? 'inputError' : ''}`}
                  rows={3}
                  value={form.attachmentUrls}
                  placeholder="一行一个 URL，例如 https://oss.example.com/contract/xxx.pdf"
                  onChange={(event) => updateField({ attachmentUrls: event.target.value })}
                />
                {errors.attachmentUrls ? (
                  <span className="errorText">{errors.attachmentUrls}</span>
                ) : (
                  <span className="hint">每行一个链接，保存时会拆成数组提交</span>
                )}
              </div>
            </div>
          </div>
        </div>

        <div
          className="row"
          style={{ marginTop: 'var(--space-4)', justifyContent: 'flex-end' }}
        >
          <button
            type="button"
            className="btn"
            disabled={saveMutation.isPending}
            onClick={() => navigate(isEdit ? `/contracts/${contractId}` : '/contracts')}
          >
            取消
          </button>
          <button
            type="submit"
            className="btn btnPrimary"
            disabled={saveMutation.isPending || ratioBlocked}
            title={ratioBlocked ? '分润比率不自洽，请先修正' : undefined}
          >
            {saveMutation.isPending && <span className="spinner" aria-hidden="true" />}
            {isEdit ? '保存修改' : '创建合同'}
          </button>
        </div>
      </form>
    </div>
  );
}
