import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/PageHeader';
import { DetailSkeleton } from '@/components/LoadingSkeleton';
import { ErrorState } from '@/components/EmptyState';
import { AUDIT_WRITTEN_HINT, useToast } from '@/components/Toast';
import { resolveErrorMessage } from '@/api/client';
import { createCreator, getCreator, updateCreator } from '@/api/creators';
import type {
  AgencyType,
  Availability,
  CreateCreatorRequest,
  CreatorAccount,
  CreatorDetail,
  CreatorStatus,
  CreatorTier,
  DataSource,
  Platform,
} from '@/api/types';
import { applyServerFieldErrors } from '@/utils/formErrors';
import {
  AGENCY_TYPE_OPTIONS,
  AVAILABILITY_OPTIONS,
  CREATOR_STATUS_OPTIONS,
  DATA_SOURCE_OPTIONS,
  EMAIL_PATTERN,
  PHONE_PATTERN,
  PLATFORM_OPTIONS,
  SOURCE_CHANNEL_OPTIONS,
  TIER_OPTIONS,
  VERTICAL_OPTIONS,
} from '@/utils/constants';

/**
 * 达人新建 / 编辑页（同一个文件按路由是否带 id 区分）。
 *
 * 三个关键取舍：
 *   1) 编辑态**不出现**状态字段：达人的状态流转必须走 updateCreatorStatus 状态机接口，
 *      否则审计日志里就没有"为什么变成这个状态"的原因，也无法在后端做流转合法性校验；
 *   2) 平台账号用动态行而不是固定 3 个输入框：达人通常只主做 1~2 个平台，
 *      固定行会逼着用户留一堆空行，提交时还要过滤；
 *   3) 手机号在 blur 时才提示格式错误：边输入边报错在 11 位手机号上体验极差
 *      （输到第 3 位就红一片），失焦校验既拦住无效请求又不打扰输入。
 */

type CreatorFormState = {
  name: string;
  realName: string;
  phone: string;
  wechat: string;
  email: string;
  city: string;
  tier: string;
  verticals: string[];
  /** 逗号分隔文本，提交时转 string[] */
  styleTags: string;
  agencyType: string;
  agencyName: string;
  sourceChannel: string;
  availability: string;
  score: string;
  ownerId: string;
  remark: string;
  /** 仅新建时提交，编辑态不渲染该字段 */
  status: string;
};

type AccountRow = {
  /** 本地行标识：用索引当 key 时删除中间行会让后面所有行的输入内容错位 */
  rowId: string;
  platform: Platform;
  nickname: string;
  platformUid: string;
  profileUrl: string;
  followerCount: string;
  isPrimary: boolean;
  dataSource: DataSource;
};

/** 提交体里没有 status：新建与编辑共用，status 由调用处按场景单独拼 */
type CreatorPayload = Omit<CreateCreatorRequest, 'status'>;

const EMPTY_FORM: CreatorFormState = {
  name: '',
  realName: '',
  phone: '',
  wechat: '',
  email: '',
  city: '',
  tier: '',
  verticals: [],
  styleTags: '',
  agencyType: '',
  agencyName: '',
  sourceChannel: '',
  availability: '',
  score: '',
  ownerId: '',
  remark: '',
  status: '',
};

let accountRowSeed = 0;

function createAccountRow(): AccountRow {
  accountRowSeed += 1;
  return {
    rowId: `account-row-${accountRowSeed}`,
    platform: 'DOUYIN',
    nickname: '',
    platformUid: '',
    profileUrl: '',
    followerCount: '',
    isPrimary: false,
    dataSource: 'MANUAL',
  };
}

function optional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** 逗号/中文逗号分隔 → 去重后的标签数组 */
function parseCommaList(value: string): string[] {
  const items = value
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return Array.from(new Set(items));
}

function toFormState(detail: CreatorDetail): CreatorFormState {
  return {
    name: detail.name,
    realName: detail.realName ?? '',
    phone: detail.phone ?? '',
    wechat: detail.wechat ?? '',
    email: detail.email ?? '',
    city: detail.city ?? '',
    tier: detail.tier,
    verticals: [...detail.verticals],
    styleTags: detail.styleTags.join('，'),
    agencyType: detail.agencyType ?? '',
    agencyName: detail.agencyName ?? '',
    sourceChannel: detail.sourceChannel ?? '',
    // availability 后端是 Json 对象，只把 commitment 这一个字段回填到下拉
    availability: detail.availability?.commitment ?? '',
    score: String(detail.score),
    ownerId: detail.owner?.id ?? '',
    remark: detail.remark ?? '',
    // 编辑态不使用该字段，留空即可；不预填是为了避免"顺手提交了 status"
    status: '',
  };
}

function toAccountRows(accounts: CreatorAccount[]): AccountRow[] {
  return accounts.map((account) => ({
    ...createAccountRow(),
    platform: account.platform,
    nickname: account.nickname,
    platformUid: account.platformUid,
    profileUrl: account.profileUrl ?? '',
    followerCount: String(account.followerCount),
    isPrimary: account.isPrimary,
    dataSource: account.dataSource,
  }));
}

function buildPayload(form: CreatorFormState, accountRows: AccountRow[]): CreatorPayload {
  return {
    name: form.name.trim(),
    realName: optional(form.realName),
    phone: optional(form.phone),
    wechat: optional(form.wechat),
    email: optional(form.email),
    city: optional(form.city),
    tier: (form.tier || undefined) as CreatorTier | undefined,
    verticals: form.verticals,
    styleTags: parseCommaList(form.styleTags),
    agencyType: (form.agencyType || undefined) as AgencyType | undefined,
    agencyName: optional(form.agencyName),
    // sourceChannel 后端是自由文本（无 @IsIn 白名单），直接透传字符串即可
    sourceChannel: optional(form.sourceChannel),
    /*
     * availability 后端列是 Json，必须提交**对象**。
     * 早期这里提交的是裸字符串 'FULL_TIME'，写进 jsonb 的就是 `"FULL_TIME"`，
     * 不是对象 —— 类型上当时声明成字符串所以编译不出错，但语义已经错了。
     */
    availability:
      form.availability === ''
        ? undefined
        : ({ commitment: form.availability } as Availability),
    score: form.score.trim() === '' ? undefined : Number(form.score),
    ownerId: optional(form.ownerId),
    remark: optional(form.remark),
    accounts: accountRows.map((row) => ({
      platform: row.platform,
      nickname: row.nickname.trim(),
      platformUid: row.platformUid.trim(),
      profileUrl: optional(row.profileUrl),
      followerCount: row.followerCount.trim() === '' ? undefined : Number(row.followerCount),
      isPrimary: row.isPrimary,
      dataSource: row.dataSource,
    })),
  };
}

/** 错误按字段名收集，便于输入框用 inputError + errorText 就近提示 */
function validate(form: CreatorFormState, accountRows: AccountRow[]): Record<string, string> {
  const errors: Record<string, string> = {};

  if (form.name.trim() === '') errors.name = '达人昵称必填';
  if (form.phone.trim() !== '' && !PHONE_PATTERN.test(form.phone.trim())) {
    errors.phone = '手机号格式不正确（11 位、1 开头）';
  }
  if (form.email.trim() !== '' && !EMAIL_PATTERN.test(form.email.trim())) {
    errors.email = '邮箱格式不正确';
  }
  if (form.score.trim() !== '') {
    const score = Number(form.score);
    if (!Number.isFinite(score) || score < 0 || score > 100) {
      errors.score = '评分需要在 0~100 之间';
    }
  }

  // 同平台同 UID 视为同一个账号：重复录入会让"达人粉丝量"取到两个主账号而失真
  const seenIdentity = new Map<string, number>();
  accountRows.forEach((row, index) => {
    if (row.nickname.trim() === '') {
      errors[`${row.rowId}-nickname`] = '账号昵称必填';
    }
    const uid = row.platformUid.trim();
    if (uid === '') {
      errors[`${row.rowId}-uid`] = '平台 UID 必填';
      return;
    }
    const identity = `${row.platform}|${uid.toLowerCase()}`;
    const duplicated = seenIdentity.get(identity);
    if (duplicated !== undefined) {
      errors[`${row.rowId}-uid`] = `与第 ${duplicated + 1} 行重复（同平台同 UID）`;
      return;
    }
    seenIdentity.set(identity, index);
  });

  return errors;
}

export default function CreatorFormPage() {
  const { id } = useParams<{ id: string }>();
  const creatorId = id ?? '';
  const isEdit = creatorId !== '';
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [form, setForm] = useState<CreatorFormState>(EMPTY_FORM);
  const [accountRows, setAccountRows] = useState<AccountRow[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const detailQuery = useQuery({
    queryKey: ['creators', 'detail', creatorId],
    queryFn: () => getCreator(creatorId),
    enabled: isEdit,
  });

  /** 只回填一次：react-query 重新取数会给出新对象，若每次 data 变化都回填会覆盖用户正在编辑的内容 */
  const hydratedRef = useRef<string | null>(null);
  useEffect(() => {
    const detail = detailQuery.data;
    if (!detail || hydratedRef.current === detail.id) return;
    hydratedRef.current = detail.id;
    setForm(toFormState(detail));
    setAccountRows(toAccountRows(detail.accounts));
  }, [detailQuery.data]);

  const saveMutation = useMutation({
    mutationFn: (payload: CreatorPayload) => {
      if (!isEdit) {
        // 新建时允许指定初始状态；编辑时状态只能走状态机接口
        return createCreator({
          ...payload,
          status: (form.status || undefined) as CreatorStatus | undefined,
        });
      }
      return updateCreator(creatorId, payload);
    },
    onSuccess: (detail) => {
      queryClient.invalidateQueries({ queryKey: ['creators'] });
      queryClient.invalidateQueries({ queryKey: ['creators', 'detail', detail.id] });
      toast.success(`${isEdit ? '达人信息已更新' : '达人已创建'}，${AUDIT_WRITTEN_HINT}`);
      navigate(`/creators/${detail.id}`);
    },
    /**
     * 后端校验失败时把 fieldErrors 落到对应输入框。
     * 本页的 errors 键名与 CreateCreatorDto 的属性名一致，因此可直接合并；
     * 嵌套的平台账号行会以 `accounts.0.platform` 形式给出，暂不逐行标红，
     * 但会通过下面的兜底提示把原因说出来（不再出现「提示看红字段却没有红字段」）。
     */
    onError: (error) => {
      const marked = applyServerFieldErrors(error, setErrors);
      if (marked.length === 0) toast.error(resolveErrorMessage(error));
    },
  });

  const updateField = (patch: Partial<CreatorFormState>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  };

  const updateAccountRow = (rowId: string, patch: Partial<AccountRow>) => {
    setAccountRows((prev) =>
      prev.map((row) => (row.rowId === rowId ? { ...row, ...patch } : row)),
    );
  };

  /** 主账号单选：设置某行时把其余行全部置 false，保证"达人粉丝量"取值唯一 */
  const setPrimaryRow = (rowId: string) => {
    setAccountRows((prev) => prev.map((row) => ({ ...row, isPrimary: row.rowId === rowId })));
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors = validate(form, accountRows);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      toast.warning('还有未通过校验的字段，请检查标红项');
      return;
    }
    saveMutation.mutate(buildPayload(form, accountRows));
  };

  if (isEdit && detailQuery.isLoading) {
    return (
      <div className="page">
        <PageHeader title="编辑达人" subtitle="正在加载达人信息…" />
        <DetailSkeleton />
      </div>
    );
  }

  if (isEdit && detailQuery.isError) {
    return (
      <div className="page">
        <PageHeader title="编辑达人" />
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
        title={isEdit ? `编辑达人 · ${form.name || '未命名'}` : '新建达人'}
        subtitle="达人主数据是合同、内容与结算的基础，昵称与平台账号请核对准确"
        actions={
          <Link className="btn" to={isEdit ? `/creators/${creatorId}` : '/creators'}>
            返回
          </Link>
        }
      />

      <form onSubmit={handleSubmit}>
        <div className="card">
          <div className="cardHeader">
            <span className="cardTitle">基础信息</span>
          </div>
          <div className="cardBody">
            <div className="formGrid">
              <div className="field">
                <label className="label labelRequired" htmlFor="creator-name">
                  达人昵称
                </label>
                <input
                  id="creator-name"
                  className={`input ${errors.name ? 'inputError' : ''}`}
                  value={form.name}
                  placeholder="平台对外展示的昵称"
                  onChange={(event) => updateField({ name: event.target.value })}
                />
                {errors.name && <span className="errorText">{errors.name}</span>}
              </div>

              <div className="field">
                <label className="label" htmlFor="creator-real-name">
                  真实姓名
                </label>
                <input
                  id="creator-real-name"
                  className="input"
                  value={form.realName}
                  onChange={(event) => updateField({ realName: event.target.value })}
                />
              </div>

              <div className="field">
                <label className="label" htmlFor="creator-phone">
                  手机号
                </label>
                <input
                  id="creator-phone"
                  className={`input mono ${errors.phone ? 'inputError' : ''}`}
                  value={form.phone}
                  placeholder="11 位手机号"
                  onChange={(event) => {
                    updateField({ phone: event.target.value });
                    // 输入过程中清掉旧错误，避免"改对了还红着"
                    if (errors.phone) setErrors((prev) => ({ ...prev, phone: '' }));
                  }}
                  onBlur={() => {
                    const phone = form.phone.trim();
                    if (phone !== '' && !PHONE_PATTERN.test(phone)) {
                      setErrors((prev) => ({ ...prev, phone: '手机号格式不正确（11 位、1 开头）' }));
                    }
                  }}
                />
                {errors.phone && <span className="errorText">{errors.phone}</span>}
              </div>

              <div className="field">
                <label className="label" htmlFor="creator-wechat">
                  微信
                </label>
                <input
                  id="creator-wechat"
                  className="input"
                  value={form.wechat}
                  onChange={(event) => updateField({ wechat: event.target.value })}
                />
              </div>

              <div className="field">
                <label className="label" htmlFor="creator-email">
                  邮箱
                </label>
                <input
                  id="creator-email"
                  className={`input ${errors.email ? 'inputError' : ''}`}
                  value={form.email}
                  placeholder="用于寄送合同与结算单"
                  onChange={(event) => {
                    updateField({ email: event.target.value });
                    if (errors.email) setErrors((prev) => ({ ...prev, email: '' }));
                  }}
                  onBlur={() => {
                    const email = form.email.trim();
                    if (email !== '' && !EMAIL_PATTERN.test(email)) {
                      setErrors((prev) => ({ ...prev, email: '邮箱格式不正确' }));
                    }
                  }}
                />
                {errors.email && <span className="errorText">{errors.email}</span>}
              </div>

              <div className="field">
                <label className="label" htmlFor="creator-city">
                  城市
                </label>
                <input
                  id="creator-city"
                  className="input"
                  value={form.city}
                  onChange={(event) => updateField({ city: event.target.value })}
                />
              </div>

              <div className="field">
                <label className="label" htmlFor="creator-tier">
                  分级
                </label>
                <select
                  id="creator-tier"
                  className="select"
                  value={form.tier}
                  onChange={(event) => updateField({ tier: event.target.value })}
                >
                  <option value="">暂不评级</option>
                  {TIER_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              {!isEdit && (
                <div className="field">
                  <label className="label" htmlFor="creator-status">
                    初始状态
                  </label>
                  <select
                    id="creator-status"
                    className="select"
                    value={form.status}
                    onChange={(event) => updateField({ status: event.target.value })}
                  >
                    <option value="">由后端默认状态决定</option>
                    {CREATOR_STATUS_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <span className="hint">
                    仅新建时可选；创建之后状态流转必须走状态机接口，以便记录流转原因
                  </span>
                </div>
              )}

              <div className="field">
                <label className="label" htmlFor="creator-score">
                  内部评分
                </label>
                <input
                  id="creator-score"
                  type="number"
                  min={0}
                  max={100}
                  className={`input mono ${errors.score ? 'inputError' : ''}`}
                  value={form.score}
                  onChange={(event) => updateField({ score: event.target.value })}
                />
                {errors.score ? (
                  <span className="errorText">{errors.score}</span>
                ) : (
                  <span className="hint">0~100，可与合作评价结果对齐</span>
                )}
              </div>

              <div className="field">
                <label className="label" htmlFor="creator-agency-type">
                  机构类型
                </label>
                <select
                  id="creator-agency-type"
                  className="select"
                  value={form.agencyType}
                  onChange={(event) => updateField({ agencyType: event.target.value })}
                >
                  <option value="">未填写</option>
                  {AGENCY_TYPE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label className="label" htmlFor="creator-agency-name">
                  机构名称
                </label>
                <input
                  id="creator-agency-name"
                  className="input"
                  value={form.agencyName}
                  onChange={(event) => updateField({ agencyName: event.target.value })}
                />
              </div>

              <div className="field">
                <label className="label" htmlFor="creator-source">
                  来源渠道
                </label>
                <select
                  id="creator-source"
                  className="select"
                  value={form.sourceChannel}
                  onChange={(event) => updateField({ sourceChannel: event.target.value })}
                >
                  <option value="">未填写</option>
                  {SOURCE_CHANNEL_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label className="label" htmlFor="creator-availability">
                  可用性
                </label>
                <select
                  id="creator-availability"
                  className="select"
                  value={form.availability}
                  onChange={(event) => updateField({ availability: event.target.value })}
                >
                  <option value="">未填写</option>
                  {AVAILABILITY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label className="label" htmlFor="creator-owner">
                  负责人用户 ID
                </label>
                <input
                  id="creator-owner"
                  className="input mono"
                  value={form.ownerId}
                  placeholder="员工 UUID，选填"
                  onChange={(event) => updateField({ ownerId: event.target.value })}
                />
                <span className="hint">
                  后端未提供员工下拉接口（跨模块调用会放大权限面），因此按 UUID 录入
                </span>
              </div>

              <div className="field fieldFull">
                <span className="label">垂类</span>
                <div className="chipGroup">
                  {VERTICAL_OPTIONS.map((option) => {
                    const active = form.verticals.includes(option.value);
                    return (
                      <button
                        key={option.value}
                        type="button"
                        className={`chip ${active ? 'chipActive' : ''}`}
                        aria-pressed={active}
                        onClick={() =>
                          updateField({
                            verticals: active
                              ? form.verticals.filter((item) => item !== option.value)
                              : [...form.verticals, option.value],
                          })
                        }
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="field fieldFull">
                <label className="label" htmlFor="creator-style-tags">
                  风格标签
                </label>
                <input
                  id="creator-style-tags"
                  className="input"
                  value={form.styleTags}
                  placeholder="用逗号分隔，例如：口播，测评，vlog"
                  onChange={(event) => updateField({ styleTags: event.target.value })}
                />
                <span className="hint">提交时会按逗号/中文逗号拆分并去重</span>
              </div>

              <div className="field fieldFull">
                <label className="label" htmlFor="creator-remark">
                  备注
                </label>
                <textarea
                  id="creator-remark"
                  className="textarea"
                  rows={3}
                  value={form.remark}
                  placeholder="合作偏好、报价区间、注意事项等内部信息"
                  onChange={(event) => updateField({ remark: event.target.value })}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="cardHeader">
            <span className="cardTitle">平台账号矩阵</span>
            <button
              type="button"
              className="btn btnSm"
              onClick={() => setAccountRows((prev) => [...prev, createAccountRow()])}
            >
              添加账号
            </button>
          </div>
          <div className="cardBody">
            {accountRows.length === 0 ? (
              <div className="emptyInline">
                还没有平台账号。添加上账号后，粉丝量与互动数据会用于达人筛选与合同试算。
              </div>
            ) : (
              <div className="tableWrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ minWidth: 120 }}>平台</th>
                      <th style={{ minWidth: 160 }}>昵称</th>
                      <th style={{ minWidth: 160 }}>平台 UID</th>
                      <th style={{ minWidth: 180 }}>主页链接</th>
                      <th style={{ minWidth: 120 }}>粉丝数</th>
                      <th style={{ minWidth: 90 }}>主账号</th>
                      <th style={{ minWidth: 130 }}>数据来源</th>
                      <th style={{ minWidth: 80 }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accountRows.map((row) => (
                      <tr key={row.rowId}>
                        <td>
                          <select
                            className="select"
                            value={row.platform}
                            aria-label="平台"
                            onChange={(event) =>
                              updateAccountRow(row.rowId, {
                                platform: event.target.value as Platform,
                              })
                            }
                          >
                            {PLATFORM_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input
                            className={`input ${errors[`${row.rowId}-nickname`] ? 'inputError' : ''}`}
                            value={row.nickname}
                            aria-label="账号昵称"
                            onChange={(event) =>
                              updateAccountRow(row.rowId, { nickname: event.target.value })
                            }
                          />
                          {errors[`${row.rowId}-nickname`] && (
                            <span className="errorText">{errors[`${row.rowId}-nickname`]}</span>
                          )}
                        </td>
                        <td>
                          <input
                            className={`input mono ${errors[`${row.rowId}-uid`] ? 'inputError' : ''}`}
                            value={row.platformUid}
                            aria-label="平台 UID"
                            onChange={(event) =>
                              updateAccountRow(row.rowId, { platformUid: event.target.value })
                            }
                          />
                          {errors[`${row.rowId}-uid`] && (
                            <span className="errorText">{errors[`${row.rowId}-uid`]}</span>
                          )}
                        </td>
                        <td>
                          <input
                            className="input"
                            value={row.profileUrl}
                            placeholder="https://"
                            aria-label="主页链接"
                            onChange={(event) =>
                              updateAccountRow(row.rowId, { profileUrl: event.target.value })
                            }
                          />
                        </td>
                        <td>
                          <input
                            type="number"
                            min={0}
                            className="input mono"
                            value={row.followerCount}
                            aria-label="粉丝数"
                            onChange={(event) =>
                              updateAccountRow(row.rowId, { followerCount: event.target.value })
                            }
                          />
                        </td>
                        <td>
                          {/* radio 而非 checkbox：主账号全局唯一，列表里的粉丝量取主账号 */}
                          <input
                            type="radio"
                            name="primary-account"
                            checked={row.isPrimary}
                            aria-label="设为主账号"
                            onChange={() => setPrimaryRow(row.rowId)}
                          />
                        </td>
                        <td>
                          <select
                            className="select"
                            value={row.dataSource}
                            aria-label="数据来源"
                            onChange={(event) =>
                              updateAccountRow(row.rowId, {
                                dataSource: event.target.value as DataSource,
                              })
                            }
                          >
                            {DATA_SOURCE_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="btnLink btnLinkDanger"
                            onClick={() =>
                              setAccountRows((prev) =>
                                prev.filter((item) => item.rowId !== row.rowId),
                              )
                            }
                          >
                            删除该行
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="hint" style={{ marginTop: 'var(--space-3)' }}>
              账号昵称与平台 UID 为必填；同平台同 UID 会判定为重复账号并阻止提交。
            </p>
          </div>
        </div>

        <div className="row" style={{ marginTop: 'var(--space-4)', justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="btn"
            disabled={saveMutation.isPending}
            onClick={() => navigate(isEdit ? `/creators/${creatorId}` : '/creators')}
          >
            取消
          </button>
          <button type="submit" className="btn btnPrimary" disabled={saveMutation.isPending}>
            {saveMutation.isPending && <span className="spinner" aria-hidden="true" />}
            {isEdit ? '保存修改' : '创建达人'}
          </button>
        </div>
      </form>
    </div>
  );
}
