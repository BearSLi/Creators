import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/PageHeader';
import { DataTable, type Column } from '@/components/DataTable';
import { FilterBar, type FilterField } from '@/components/FilterBar';
import { Modal } from '@/components/Modal';
import { StatusTag } from '@/components/StatusTag';
import { MoneyText } from '@/components/MoneyText';
import { PermissionGate } from '@/components/PermissionGate';
import { useToast, AUDIT_WRITTEN_HINT } from '@/components/Toast';
import { useTableQuery } from '@/hooks/useTableQuery';
import {
  exportSettlements,
  generateSettlements,
  listSettlements,
} from '@/api/settlements';
import type {
  GenerateSettlementRequest,
  GenerateSettlementResult,
  SettlementListItem,
  SettlementStatus,
} from '@/api/types';
import { resolveErrorMessage } from '@/api/client';
import {
  SETTLEMENT_STATUS_LABELS,
  SETTLEMENT_STATUS_OPTIONS,
  SETTLEMENT_STATUS_TONES,
} from '@/utils/constants';
import {
  currentMonthRange,
  downloadBlob,
  formatDate,
  overdueDays,
  parseFilename,
  previousMonthRange,
} from '@/utils/format';
import { P } from '@/utils/permissions';

/**
 * 结算单列表。
 *
 * 这是财务每天要用的页面，所以三条规则是硬性的：
 *
 *   1) **账期是筛选的核心**，默认上月：财务在次月结算上月流水，一进页面就该是上月的账期。
 *      两个快捷按钮（本月 / 上月）解决"月底月初来回切月份"的高频操作；
 *   2) **金额列一律右对齐 + 等宽**：只有等宽字体才能纵向比对"位数对不对"，
 *      右对齐才能让小数点排成一条线——财务扫一眼就能发现异常单据；
 *   3) **前端不做任何金额运算**：所有金额都是后端下发的字符串元，页面只负责格式化与高亮。
 *      表格底部的"当前页合计"是唯一一处前端求和，且刻意只算当前页并标注清楚：
 *      跨页总额以后端返回的 total 与后端汇总接口为准，前端全量加总会出现
 *      "前端 99,999.99 / 后端 100,000.00"这种对账事故（分页边界、币种、四舍五入口径都可能不同）。
 *
 * 导出走**文件流**而不是 JSON：exportSettlements 内部用 responseType:'blob' 绕过了信封解包，
 * 因此这里拿到的是 AxiosResponse<Blob>，必须自己解析 content-disposition 再触发下载。
 * 绝不能写成 <a href="/api/settlements/export?...">：那样浏览器不会带 Authorization 头，后端直接 401。
 */

interface SettlementFilters extends Record<string, unknown> {
  keyword: string;
  status: SettlementStatus[];
  creatorId: string;
  periodStart: string;
  periodEnd: string;
}

/** 上月账期：财务在次月结算上月，所以默认值必须是上月而不是"本月至今" */
const DEFAULT_RANGE = previousMonthRange();

const EMPTY_FILTERS: SettlementFilters = {
  keyword: '',
  status: [],
  creatorId: '',
  periodStart: DEFAULT_RANGE.start,
  periodEnd: DEFAULT_RANGE.end,
};

export default function SettlementListPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { query, setPage, setPageSize, setFilters, reset, setSort, pageSizeOptions } =
    useTableQuery<SettlementFilters>({ initialFilters: EMPTY_FILTERS, initialPageSize: 20 });

  const [generateOpen, setGenerateOpen] = useState(false);
  const [generateForm, setGenerateForm] = useState({
    periodStart: DEFAULT_RANGE.start,
    periodEnd: DEFAULT_RANGE.end,
    /** 多行文本，每行一个达人 id；留空表示全量生成 */
    creatorIdsText: '',
  });
  /** 生成结果要留在页面上：财务需要核对"生成了几张、跳过了几张、总额多少" */
  const [generateResult, setGenerateResult] = useState<GenerateSettlementResult | null>(null);

  const { keyword, status, creatorId, periodStart, periodEnd } = query.filters;

  const { data, isLoading, isError, error, refetch } = useQuery({
    // 账期与筛选全部进 key：账期一变就重取，避免"看到的是上月数据却以为在看本月"
    queryKey: [
      'settlements',
      'list',
      query.page,
      query.pageSize,
      query.sortBy,
      query.sortOrder,
      keyword,
      status,
      creatorId,
      periodStart,
      periodEnd,
    ],
    queryFn: () =>
      listSettlements({
        page: query.page,
        pageSize: query.pageSize,
        sortBy: query.sortBy,
        sortOrder: query.sortOrder,
        keyword: keyword || undefined,
        status,
        creatorId: creatorId || undefined,
        periodStart: periodStart || undefined,
        periodEnd: periodEnd || undefined,
      }),
    placeholderData: keepPreviousData,
  });

  const generateMutation = useMutation({
    // 直接透传 payload：GenerateSettlementRequest 支持 month（按月）或
    // periodStart/periodEnd（自定义区间）两种形状，这里不该再手工挑字段，
    // 否则新增入参时又要在两处同步（契约漂移的典型来源）
    mutationFn: (payload: GenerateSettlementRequest) => generateSettlements(payload),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['settlements'] });
      setGenerateResult(result);
      toast.success(
        `已生成 ${result.generated} 张结算单，跳过 ${result.skipped} 张，${AUDIT_WRITTEN_HINT}`,
      );
    },
  });

  const exportMutation = useMutation({
    mutationFn: async () => {
      // 导出是"读操作 + 审计"，带上当前筛选条件，导出的内容必须与页面看到的一致
      const response = await exportSettlements({
        periodStart: periodStart || undefined,
        periodEnd: periodEnd || undefined,
        creatorId: creatorId || undefined,
      });
      const filename = parseFilename(
        response.headers['content-disposition'] as string | undefined,
        `结算单_${periodStart || '全部'}_${periodEnd || '全部'}.csv`,
      );
      downloadBlob(response.data, filename);
      return { filename };
    },
    onSuccess: ({ filename }) => {
      // 导出属于敏感动作，后端会记录审计；这里同步提示用户，避免"导出了什么都没留下痕迹"
      toast.success(`已导出 ${filename}，${AUDIT_WRITTEN_HINT}`);
    },
  });

  /** 当前页净额合计：唯一一处前端求和，且明确标注"仅当前页" */
  const pageNetTotal = useMemo(() => {
    const items = data?.items ?? [];
    return items.reduce((sum, item) => sum + (Number(item.netPayable) || 0), 0);
  }, [data]);

  const applyRange = (range: { start: string; end: string }) => {
    setFilters({ periodStart: range.start, periodEnd: range.end });
  };

  const submitGenerate = () => {
    if (generateMutation.isPending) return;
    const creatorIds = generateForm.creatorIdsText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');

    /**
     * 优先按月出账。
     *
     * 月度结算是最常见用法，而「自己算月末」很容易错：闰年 2 月是 29 天、
     * 12 月的月末跨年。后端支持传 `month`（YYYY-MM）并按自然月解析，
     * 因此这里从已选账期里取年月，走后端解析而不是把区间拼出来。
     * 只有在账期跨月（自定义区间）时才回退到传 periodStart/periodEnd。
     */
    const sameMonth =
      generateForm.periodStart.slice(0, 7) === generateForm.periodEnd.slice(0, 7);
    const payload: GenerateSettlementRequest = sameMonth
      ? { month: generateForm.periodStart.slice(0, 7) }
      : {
          periodStart: generateForm.periodStart,
          periodEnd: generateForm.periodEnd,
        };

    generateMutation.mutate({
      ...payload,
      // 空数组与 undefined 语义不同：留空要传 undefined 表示"全量达人"
      creatorIds: creatorIds.length > 0 ? creatorIds : undefined,
    });
  };

  const fields: FilterField[] = [
    {
      type: 'date',
      key: 'periodStart',
      label: '账期开始',
      value: periodStart,
      onChange: (value) => setFilters({ periodStart: value }),
    },
    {
      type: 'date',
      key: 'periodEnd',
      label: '账期结束',
      value: periodEnd,
      onChange: (value) => setFilters({ periodEnd: value }),
    },
    {
      type: 'custom',
      key: 'rangeShortcut',
      label: '快捷账期',
      render: () => (
        <div className="row" style={{ gap: 'var(--space-2)' }}>
          <button type="button" className="btn btnSm" onClick={() => applyRange(currentMonthRange())}>
            本月
          </button>
          <button type="button" className="btn btnSm" onClick={() => applyRange(previousMonthRange())}>
            上月
          </button>
          <span className="subtle" style={{ fontSize: 'var(--font-size-xs)' }}>
            默认上月（次月结算上月流水）
          </span>
        </div>
      ),
    },
    {
      type: 'multi',
      key: 'status',
      label: '结算状态',
      value: status,
      options: SETTLEMENT_STATUS_OPTIONS,
      onChange: (value) => setFilters({ status: value as SettlementStatus[] }),
    },
    {
      type: 'custom',
      key: 'creatorId',
      label: '达人 ID',
      // 结算都是"先定位到人"再核对，后端暂无达人下拉候选接口，先用 id 精确筛选
      render: () => (
        <input
          className="input"
          style={{ width: 200 }}
          value={creatorId}
          placeholder="粘贴达人 id"
          onChange={(event) => setFilters({ creatorId: event.target.value })}
        />
      ),
    },
    {
      type: 'keyword',
      key: 'keyword',
      placeholder: '结算单号 / 达人昵称',
      value: keyword,
      onChange: (value) => setFilters({ keyword: value }),
    },
  ];

  const columns: Column<SettlementListItem>[] = useMemo(
    () => [
      {
        key: 'code',
        title: '结算单号',
        width: 148,
        render: (row) => <span className="mono">{row.code}</span>,
      },
      {
        key: 'creatorName',
        title: '达人',
        width: 116,
        ellipsis: true,
        render: (row) => row.creatorName,
      },
      {
        key: 'period',
        title: '账期',
        width: 186,
        render: (row) => (
          <span className="nowrap">
            {formatDate(row.periodStart)} ~ {formatDate(row.periodEnd)}
          </span>
        ),
      },
      {
        key: 'status',
        title: '状态',
        width: 100,
        render: (row) => (
          <StatusTag tone={SETTLEMENT_STATUS_TONES[row.status]}>
            {SETTLEMENT_STATUS_LABELS[row.status]}
          </StatusTag>
        ),
      },
      {
        key: 'itemCount',
        title: '明细',
        width: 76,
        align: 'right',
        render: (row) => <span className="mono">{row.itemCount}</span>,
      },
      {
        key: 'grossAmount',
        title: '流水总额',
        width: 130,
        align: 'right',
        render: (row) => <MoneyText value={row.grossAmount} variant="plain" />,
      },
      {
        key: 'platformFee',
        title: '平台费',
        width: 120,
        align: 'right',
        render: (row) => <MoneyText value={row.platformFee} variant="plain" muted />,
      },
      {
        key: 'agencyShare',
        title: '公司分成',
        width: 120,
        align: 'right',
        render: (row) => <MoneyText value={row.agencyShare} variant="plain" muted />,
      },
      {
        key: 'talentGross',
        title: '达人应得',
        width: 124,
        align: 'right',
        render: (row) => <MoneyText value={row.talentGross} variant="plain" />,
      },
      {
        key: 'taxWithheld',
        title: '代扣税',
        width: 116,
        align: 'right',
        render: (row) => <MoneyText value={row.taxWithheld} variant="plain" muted />,
      },
      {
        key: 'netPayable',
        title: '净应付',
        width: 140,
        align: 'right',
        tooltip: '超过大额阈值会自动高亮，便于财务优先处理',
        render: (row) => <MoneyText value={row.netPayable} />,
      },
      {
        key: 'adjustmentAmount',
        title: '调整金额',
        width: 124,
        align: 'right',
        tooltip: '人工调整，正负都可能；带符号展示，0 与"没有调整"在视觉上要能区分',
        render: (row) => <MoneyText value={row.adjustmentAmount} variant="plain" signed />,
      },
      {
        key: 'dueDate',
        title: '应付款日',
        width: 132,
        render: (row) => {
          const overdue = overdueDays(row.dueDate);
          // 已打款/已作废的单子不再提示逾期：钱已经出去了或这单已不算数，标红只会制造噪声
          const showOverdue = overdue !== null && row.status !== 'PAID' && row.status !== 'VOID';
          return (
            <span className="nowrap">
              {formatDate(row.dueDate)}
              {showOverdue && (
                <span style={{ color: 'var(--color-danger)', marginLeft: 'var(--space-1)' }}>
                  （逾期 {overdue} 天）
                </span>
              )}
            </span>
          );
        },
      },
      {
        key: 'actions',
        title: '操作',
        width: 88,
        render: (row) => (
          <div className="tableActions">
            <button
              type="button"
              className="btn btnSm"
              onClick={(event) => {
                event.stopPropagation();
                navigate(`/settlements/${row.id}`);
              }}
            >
              详情
            </button>
          </div>
        ),
      },
    ],
    [navigate],
  );

  return (
    <div className="page">
      <PageHeader
        title="结算管理"
        subtitle={`当前账期 ${formatDate(periodStart)} ~ ${formatDate(periodEnd)}；金额均为后端下发的字符串元`}
        actions={
          <>
            <PermissionGate permission={P.SETTLEMENT_GENERATE}>
              <button
                type="button"
                className="btn btnPrimary"
                disabled={generateMutation.isPending}
                onClick={() => {
                  setGenerateForm({
                    periodStart: periodStart || DEFAULT_RANGE.start,
                    periodEnd: periodEnd || DEFAULT_RANGE.end,
                    creatorIdsText: '',
                  });
                  setGenerateResult(null);
                  setGenerateOpen(true);
                }}
              >
                生成结算单
              </button>
            </PermissionGate>
            <PermissionGate permission={P.SETTLEMENT_EXPORT}>
              <button
                type="button"
                className="btn"
                // 导出会写审计且耗时随数据量增长，禁用防重复导出
                disabled={exportMutation.isPending}
                onClick={() => exportMutation.mutate()}
              >
                {exportMutation.isPending && <span className="spinner" aria-hidden="true" />}
                导出 Excel/CSV
              </button>
            </PermissionGate>
          </>
        }
      />

      <FilterBar fields={fields} onReset={reset} resultCount={data?.total} />

      <DataTable<SettlementListItem>
        columns={columns}
        rows={data?.items ?? []}
        rowKey={(row) => row.id}
        loading={isLoading}
        error={isError ? resolveErrorMessage(error) : null}
        onRetry={() => void refetch()}
        emptyTitle="该账期没有结算单"
        emptyDescription="确认账期是否选对，或点击「生成结算单」按流水生成"
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
        onRowClick={(row) => navigate(`/settlements/${row.id}`)}
        stickyHeader
        footer={
          <div className="row wrap" style={{ gap: 'var(--space-3)' }}>
            <span className="muted" style={{ fontSize: 'var(--font-size-sm)' }}>
              当前页合计（净应付）
            </span>
            <MoneyText value={pageNetTotal.toFixed(2)} />
            <span className="subtle" style={{ fontSize: 'var(--font-size-xs)' }}>
              共 {data?.total ?? 0} 张单据；跨页总额以后端返回的 total 与后端汇总接口为准，
              前端不做全量加总以免与后端口径不一致
            </span>
          </div>
        }
      />

      {/* ---------------- 生成结算单 ---------------- */}
      <Modal
        open={generateOpen}
        title="生成结算单"
        description="按账期汇总已发布内容的流水；同账期重复生成时后端会跳过已有单据"
        onClose={generateMutation.isPending ? () => undefined : () => setGenerateOpen(false)}
        footer={
          <>
            <button
              type="button"
              className="btn"
              onClick={() => setGenerateOpen(false)}
              disabled={generateMutation.isPending}
            >
              关闭
            </button>
            <button
              type="button"
              className="btn btnPrimary"
              disabled={generateMutation.isPending}
              onClick={submitGenerate}
            >
              {generateMutation.isPending && <span className="spinner" aria-hidden="true" />}
              开始生成
            </button>
          </>
        }
      >
        <div className="formGrid">
          <div className="field">
            <label className="label labelRequired" htmlFor="generate-start">
              账期开始
            </label>
            <input
              id="generate-start"
              type="date"
              className="input"
              value={generateForm.periodStart}
              onChange={(event) =>
                setGenerateForm({ ...generateForm, periodStart: event.target.value })
              }
            />
          </div>
          <div className="field">
            <label className="label labelRequired" htmlFor="generate-end">
              账期结束
            </label>
            <input
              id="generate-end"
              type="date"
              className="input"
              value={generateForm.periodEnd}
              min={generateForm.periodStart || undefined}
              onChange={(event) => setGenerateForm({ ...generateForm, periodEnd: event.target.value })}
            />
          </div>
          <div className="field fieldFull">
            <label className="label" htmlFor="generate-creators">
              指定达人 ID（每行一个，留空表示全部）
            </label>
            <textarea
              id="generate-creators"
              className="textarea"
              rows={4}
              value={generateForm.creatorIdsText}
              placeholder={'留空 = 该账期所有达人都生成\n也可只填需要补生成的达人 id，一行一个'}
              onChange={(event) =>
                setGenerateForm({ ...generateForm, creatorIdsText: event.target.value })
              }
            />
            <span className="hint">
              生成是幂等动作：同账期同达人重复提交，后端会返回"跳过"而不是重复建单
            </span>
          </div>
        </div>

        {generateResult && (
          <div className="card" style={{ marginTop: 'var(--space-4)' }}>
            <div className="cardHeader">
              <span className="cardTitle">生成结果</span>
              <span className="subtle" style={{ fontSize: 'var(--font-size-xs)' }}>
                本次共生成 {generateResult.generated} 张 / 跳过 {generateResult.skipped} 张
              </span>
            </div>
            <div className="cardBody">
              <div className="rowBetween wrap" style={{ marginBottom: 'var(--space-3)' }}>
                <span className="muted">本次净应付合计</span>
                <MoneyText value={generateResult.totalNetYuan} />
              </div>
              {generateResult.settlements.length === 0 ? (
                <div className="emptyInline">没有新增结算单（可能该账期已全部生成）</div>
              ) : (
                <div className="tableWrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>单号</th>
                        <th>达人</th>
                        <th className="textRight">净应付（元）</th>
                      </tr>
                    </thead>
                    <tbody>
                      {generateResult.settlements.map((item) => (
                        <tr key={item.id}>
                          <td className="mono">{item.code}</td>
                          <td>{item.creatorName}</td>
                          <td className="textRight">
                            <MoneyText value={item.netPayable} variant="plain" />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
