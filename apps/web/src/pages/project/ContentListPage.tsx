import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/PageHeader';
import { DataTable, type Column } from '@/components/DataTable';
import { FilterBar, type FilterField } from '@/components/FilterBar';
import { Modal } from '@/components/Modal';
import { StatusTag, type StatusTone } from '@/components/StatusTag';
import { MoneyText } from '@/components/MoneyText';
import { EmptyState, ErrorState } from '@/components/EmptyState';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';
import { PermissionGate } from '@/components/PermissionGate';
import { useToast, AUDIT_WRITTEN_HINT } from '@/components/Toast';
import { useTableQuery } from '@/hooks/useTableQuery';
import { listContents, publishContent, reviewContent } from '@/api/contents';
import type { ContentListItem, ContentStatus, Platform } from '@/api/types';
import { resolveErrorMessage } from '@/api/client';
import {
  CONTENT_BOARD_COLUMNS,
  CONTENT_REVIEWABLE_STATUSES,
  CONTENT_STATUS_LABELS,
  CONTENT_STATUS_OPTIONS,
  CONTENT_STATUS_TONES,
  PLATFORM_LABELS,
  PLATFORM_OPTIONS,
} from '@/utils/constants';
import { formatCount, formatDateTime, formatPercentValue } from '@/utils/format';
import { P } from '@/utils/permissions';

/**
 * 内容排期看板。
 *
 * 为什么默认是看板而不是表格：内容运营每天的真实问题是"卡在哪一步"，
 * 表格按时间倒序只能告诉你"最近改了什么"，看不出"待审核堆了 12 条"。
 * 看板按状态分列后，积压位置一眼可见。
 *
 * 【看板的数据获取取舍，必须说清楚】
 * 看板要求**跨状态同时可见**（同一屏里比较 7 个状态的数量），而表格视图只需要"当前页"。
 * 所以看板走的是"一次性拉取（pageSize=100）+ 前端按 status 分组"：
 *   - 好处：所有列同时出现在一屏，拖动/切筛选不会出现"某列加载一半"的割裂感；
 *   - 代价：数据量超过单页上限时，超出的内容在这块看板上不可见（不是分页藏起来，而是根本没有）；
 *   - 数据量大时的正确做法：改成后端按状态分列的接口（每列独立分页 + 每列单独 loading
 *     与"加载更多"），或者用游标分页按列增量拉取。当前实现只适合单项目/单周的运营排期量，
 *     这也是这里 pageSize 固定 100、并把表格视图保留为全量查数的原因。
 *
 * 另一个取舍：审核与发布做成两个独立权限动作（P.CONTENT_REVIEW / P.CONTENT_PUBLISH），
 * 不合并成"一键过审并发布"——内容审核与投放发布在责任上是两件事（内容岗 / 投放岗），
 * 合并会让审计日志里分不清是谁批准上线的内容。
 */

type ViewMode = 'board' | 'table';

interface ContentFilters extends Record<string, unknown> {
  keyword: string;
  creatorId: string;
  platform: string;
  status: ContentStatus[];
  from: string;
  to: string;
}

const EMPTY_FILTERS: ContentFilters = {
  keyword: '',
  creatorId: '',
  platform: '',
  status: [],
  from: '',
  to: '',
};

/** 合规分着色：分数越高越安全，阈值与后端等级口径对齐（80+ 通过 / 60+ 关注 / 其余风险） */
function complianceTone(score: number): StatusTone {
  if (score >= 80) return 'success';
  if (score >= 60) return 'warning';
  return 'danger';
}

/** 逾期未发布：已排期时间早于现在，但状态还停在未发布的那几个 */
function isOverdue(row: ContentListItem): boolean {
  if (!row.scheduledAt) return false;
  if (row.status === 'PUBLISHED' || row.status === 'OFFLINE') return false;
  return new Date(row.scheduledAt).getTime() < Date.now();
}

export default function ContentListPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  // 视图状态放 URL：从项目详情"去内容看板"跳过来、或分享链接时，视图与筛选都能还原
  const view: ViewMode = searchParams.get('view') === 'table' ? 'table' : 'board';

  const { query, setPage, setPageSize, setFilters, reset, setSort, pageSizeOptions } =
    useTableQuery<ContentFilters>({ initialFilters: EMPTY_FILTERS, initialPageSize: 20 });

  const [reviewTarget, setReviewTarget] = useState<ContentListItem | null>(null);
  const [reviewForm, setReviewForm] = useState<{ approved: boolean; note: string }>({
    approved: true,
    note: '',
  });
  const [publishTarget, setPublishTarget] = useState<ContentListItem | null>(null);
  const [publishForm, setPublishForm] = useState<{ publishedUrl: string; platformContentId: string }>({
    publishedUrl: '',
    platformContentId: '',
  });

  const { keyword, creatorId, platform, status, from, to } = query.filters;

  /** 服务端查询参数：看板与表格共用同一份筛选，只有分页策略不同 */
  const baseParams = useMemo(
    () => ({
      keyword: keyword || undefined,
      creatorId: creatorId || undefined,
      platform: (platform || undefined) as Platform | undefined,
      status,
      from: from || undefined,
      to: to || undefined,
    }),
    [keyword, creatorId, platform, status, from, to],
  );

  const boardQuery = useQuery({
    queryKey: ['contents', 'board', baseParams],
    queryFn: () => listContents({ ...baseParams, page: 1, pageSize: 100 }),
    // 只有看板视图在用时才请求，切到表格视图不会白白多打一个请求
    enabled: view === 'board',
  });

  const tableQuery = useQuery({
    queryKey: ['contents', 'list', query.page, query.pageSize, query.sortBy, query.sortOrder, baseParams],
    queryFn: () =>
      listContents({
        ...baseParams,
        page: query.page,
        pageSize: query.pageSize,
        sortBy: query.sortBy,
        sortOrder: query.sortOrder,
      }),
    enabled: view === 'table',
    placeholderData: keepPreviousData,
  });

  const reviewMutation = useMutation({
    mutationFn: (payload: { id: string; approved: boolean; note: string }) =>
      reviewContent(payload.id, {
        approved: payload.approved,
        // 通过时 note 是可选的审核备注；驳回时必须带上原因
        note: payload.approved ? payload.note.trim() || undefined : undefined,
        rejectReason: payload.approved ? undefined : payload.note.trim(),
      }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['contents'] });
      toast.success(
        `内容已${variables.approved ? '通过审核' : '驳回'}，${AUDIT_WRITTEN_HINT}`,
      );
      setReviewTarget(null);
    },
  });

  const publishMutation = useMutation({
    mutationFn: (payload: { id: string; publishedUrl: string; platformContentId: string }) =>
      publishContent(payload.id, {
        publishedUrl: payload.publishedUrl.trim() || undefined,
        platformContentId: payload.platformContentId.trim() || undefined,
        // 由前端记录"点下发布的时间"：后端会以自己的时间为准，这里只是给排期一个可读的落点
        publishedAt: new Date().toISOString(),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contents'] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast.success(`内容已标记发布，${AUDIT_WRITTEN_HINT}`);
      setPublishTarget(null);
    },
  });

  const openReview = (row: ContentListItem, approved: boolean) => {
    setReviewTarget(row);
    setReviewForm({ approved, note: '' });
  };

  const openPublish = (row: ContentListItem) => {
    setPublishTarget(row);
    setPublishForm({ publishedUrl: row.publishedUrl ?? '', platformContentId: '' });
  };

  const fields: FilterField[] = [
    {
      type: 'keyword',
      key: 'keyword',
      placeholder: '内容标题 / 编号',
      value: keyword,
      onChange: (value) => setFilters({ keyword: value }),
    },
    {
      type: 'select',
      key: 'platform',
      label: '平台',
      value: platform,
      options: PLATFORM_OPTIONS,
      onChange: (value) => setFilters({ platform: value }),
    },
    {
      type: 'multi',
      key: 'status',
      label: '内容状态',
      value: status,
      options: CONTENT_STATUS_OPTIONS,
      onChange: (value) => setFilters({ status: value as ContentStatus[] }),
    },
    {
      type: 'custom',
      key: 'creatorId',
      label: '达人 ID',
      // 与项目列表同理：后端暂无达人下拉候选接口，先用 id 精确筛选
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
      type: 'date',
      key: 'from',
      label: '排期起',
      value: from,
      onChange: (value) => setFilters({ from: value }),
    },
    {
      type: 'date',
      key: 'to',
      label: '排期止',
      value: to,
      onChange: (value) => setFilters({ to: value }),
    },
  ];

  const tableColumns: Column<ContentListItem>[] = [
    {
      key: 'title',
      title: '内容标题',
      minWidth: 220,
      render: (row) => (
        <button
          type="button"
          className="btnLink"
          onClick={(event) => {
            event.stopPropagation();
            navigate(`/contents/${row.id}`);
          }}
        >
          {row.title}
        </button>
      ),
    },
    {
      key: 'creatorName',
      title: '达人',
      width: 110,
      ellipsis: true,
      render: (row) => row.creatorName,
    },
    {
      key: 'projectName',
      title: '项目',
      width: 140,
      ellipsis: true,
      render: (row) => row.projectName ?? '—',
    },
    {
      key: 'platform',
      title: '平台',
      width: 96,
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
      render: (row) => (
        <span className="nowrap" style={isOverdue(row) ? { color: 'var(--color-danger)' } : undefined}>
          {formatDateTime(row.scheduledAt)}
          {isOverdue(row) && ' 逾期'}
        </span>
      ),
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
      render: (row) => <span className="mono">{formatCount(row.viewCount)}</span>,
    },
    {
      key: 'likeCount',
      title: '点赞',
      width: 92,
      align: 'right',
      render: (row) => <span className="mono">{formatCount(row.likeCount)}</span>,
    },
    {
      key: 'commentCount',
      title: '评论',
      width: 92,
      align: 'right',
      render: (row) => <span className="mono">{formatCount(row.commentCount)}</span>,
    },
    {
      key: 'shareCount',
      title: '转发',
      width: 92,
      align: 'right',
      render: (row) => <span className="mono">{formatCount(row.shareCount)}</span>,
    },
    {
      key: 'completionRate',
      title: '完播率',
      width: 92,
      align: 'right',
      // completionRate 后端直接给百分数（42.5 表示 42.5%），不要再除 100
      render: (row) => <span className="mono">{formatPercentValue(row.completionRate)}</span>,
    },
    {
      key: 'conversions',
      title: '转化数',
      width: 92,
      align: 'right',
      render: (row) => <span className="mono">{formatCount(row.conversions)}</span>,
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
      width: 92,
      align: 'right',
      render: (row) =>
        row.complianceScore === null ? (
          <span className="subtle">未检测</span>
        ) : (
          <StatusTag tone={complianceTone(row.complianceScore)} size="sm">
            {row.complianceScore}
          </StatusTag>
        ),
    },
    {
      key: 'actions',
      title: '操作',
      width: 190,
      render: (row) => (
        <div className="tableActions">
          <button
            type="button"
            className="btn btnSm"
            onClick={(event) => {
              event.stopPropagation();
              navigate(`/contents/${row.id}`);
            }}
          >
            详情
          </button>
          {/* 审核只对内部审核/平台审核有意义；其它状态点了后端会 409，前端先不给入口 */}
          {CONTENT_REVIEWABLE_STATUSES.includes(row.status) && (
            <PermissionGate permission={P.CONTENT_REVIEW}>
              <button type="button" className="btn btnSm" onClick={() => openReview(row, true)}>
                审核
              </button>
            </PermissionGate>
          )}
          {row.status !== 'PUBLISHED' && (
            <PermissionGate permission={P.CONTENT_PUBLISH}>
              <button type="button" className="btn btnSm" onClick={() => openPublish(row)}>
                发布
              </button>
            </PermissionGate>
          )}
        </div>
      ),
    },
  ];

  /** 看板分组：一次拉取的结果按 CONTENT_BOARD_COLUMNS 的顺序分桶（顺序即生产流水线顺序） */
  const boardGroups = useMemo(() => {
    const items = boardQuery.data?.items ?? [];
    const groups = new Map<ContentStatus, ContentListItem[]>();
    CONTENT_BOARD_COLUMNS.forEach((column) => groups.set(column, []));
    items.forEach((item) => {
      // 后端若新增了枚举值，这里会落到"未分组"，用 default 桶兜底而不是丢弃数据
      const bucket = groups.get(item.status);
      if (bucket) bucket.push(item);
      else groups.set(item.status, [item]);
    });
    return groups;
  }, [boardQuery.data]);

  const renderBoard = () => {
    // isFetching 也走骨架：筛选条件变化时会重新拉取，若继续显示旧分组，
    // 用户会以为"筛选没生效"（分组数量明明变了却没反应）
    if (boardQuery.isPending || boardQuery.isFetching) {
      return (
        <div className="grid gridCols4">
          {CONTENT_BOARD_COLUMNS.slice(0, 4).map((column) => (
            <div key={column} className="card">
              <div className="cardHeader">
                <span className="cardTitle">{CONTENT_STATUS_LABELS[column]}</span>
              </div>
              <div className="cardBody">
                <LoadingSkeleton variant="card" rows={2} header={false} />
              </div>
            </div>
          ))}
        </div>
      );
    }

    if (boardQuery.isError) {
      return (
        <div className="card">
          <ErrorState
            message={resolveErrorMessage(boardQuery.error)}
            onRetry={() => void boardQuery.refetch()}
          />
        </div>
      );
    }

    // 整体空态：所有列都没数据时给引导，而不是渲染 7 个"暂无"
    if ((boardQuery.data?.items.length ?? 0) === 0) {
      return (
        <div className="card">
          <EmptyState
            title="没有符合条件的内容"
            description="调整筛选条件，或从项目详情里新建内容"
            action={
              <button type="button" className="btn" onClick={() => navigate('/projects')}>
                去项目列表
              </button>
            }
          />
        </div>
      );
    }

    return (
      <div
        style={{
          display: 'grid',
          // 7 个状态列在宽屏里横向铺开，窄屏自动换行，不引入横向滚动条
          gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
          gap: 'var(--space-4)',
        }}
      >
        {CONTENT_BOARD_COLUMNS.map((column) => {
          const items = boardGroups.get(column) ?? [];
          return (
            <section key={column} className="card" style={{ display: 'flex', flexDirection: 'column' }}>
              <div className="cardHeader">
                <span className="row" style={{ gap: 'var(--space-2)' }}>
                  <StatusTag tone={CONTENT_STATUS_TONES[column]} size="sm">
                    {CONTENT_STATUS_LABELS[column]}
                  </StatusTag>
                </span>
                <span className="subtle" style={{ fontSize: 'var(--font-size-xs)' }}>
                  {items.length} 条
                </span>
              </div>
              <div className="cardBody stack" style={{ gap: 'var(--space-3)' }}>
                {items.length === 0 && <div className="emptyInline">暂无</div>}
                {items.map((item) => (
                  <article
                    key={item.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => navigate(`/contents/${item.id}`)}
                    onKeyDown={(event) => {
                      // 卡片整体可点，键盘用户也需要 Enter/Space 能进详情
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        navigate(`/contents/${item.id}`);
                      }
                    }}
                    style={{
                      border: '1px solid var(--color-border)',
                      borderRadius: 'var(--radius-md)',
                      padding: 'var(--space-3)',
                      background: 'var(--color-bg-subtle)',
                      cursor: 'pointer',
                    }}
                  >
                    <div className="clamp2" style={{ fontWeight: 'var(--font-weight-medium)' }}>
                      {item.title}
                    </div>

                    <div className="row wrap" style={{ gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
                      <span className="muted" style={{ fontSize: 'var(--font-size-xs)' }}>
                        {item.creatorName}
                      </span>
                      <StatusTag tone="neutral" size="sm">
                        {PLATFORM_LABELS[item.platform]}
                      </StatusTag>
                    </div>

                    <div
                      className="rowBetween"
                      style={{ marginTop: 'var(--space-2)', fontSize: 'var(--font-size-xs)' }}
                    >
                      <span style={isOverdue(item) ? { color: 'var(--color-danger)' } : undefined}>
                        {item.scheduledAt ? formatDateTime(item.scheduledAt) : '未排期'}
                        {isOverdue(item) && ' · 已逾期未发布'}
                      </span>
                    </div>

                    <div
                      className="rowBetween"
                      style={{ marginTop: 'var(--space-2)', fontSize: 'var(--font-size-xs)' }}
                    >
                      <span className="mono">播放 {formatCount(item.viewCount)}</span>
                      {item.complianceScore === null ? (
                        <span className="subtle">合规分 —</span>
                      ) : (
                        <StatusTag tone={complianceTone(item.complianceScore)} size="sm">
                          合规 {item.complianceScore}
                        </StatusTag>
                      )}
                    </div>

                    {/* 待审核的卡片在看板上要能直接处理，否则运营得切到表格视图才能审核 */}
                    {CONTENT_REVIEWABLE_STATUSES.includes(item.status) && (
                      <div
                        className="row"
                        style={{ gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <PermissionGate permission={P.CONTENT_REVIEW}>
                          <button
                            type="button"
                            className="btn btnSm"
                            onClick={() => openReview(item, true)}
                          >
                            通过
                          </button>
                          <button
                            type="button"
                            className="btn btnSm btnDanger"
                            onClick={() => openReview(item, false)}
                          >
                            驳回
                          </button>
                        </PermissionGate>
                      </div>
                    )}
                  </article>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    );
  };

  return (
    <div className="page">
      <PageHeader
        title="内容排期"
        subtitle="看板按状态分列，积压一眼可见；表格视图用于查数、审核与发布"
        actions={
          <div className="tabs" role="tablist" aria-label="视图切换">
            <button
              type="button"
              role="tab"
              aria-selected={view === 'board'}
              className={`tab ${view === 'board' ? 'tabActive' : ''}`}
              onClick={() => setSearchParams({ view: 'board' })}
            >
              看板视图
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'table'}
              className={`tab ${view === 'table' ? 'tabActive' : ''}`}
              onClick={() => setSearchParams({ view: 'table' })}
            >
              表格视图
            </button>
          </div>
        }
      />

      <FilterBar
        fields={fields}
        onReset={reset}
        // 看板与表格的 total 含义不同：看板是"本次拉取的条数"，所以只在表格视图展示命中数
        resultCount={view === 'table' ? tableQuery.data?.total : undefined}
      />

      {view === 'board' ? (
        <>
          <p className="subtle" style={{ fontSize: 'var(--font-size-xs)', marginBottom: 'var(--space-3)' }}>
            看板一次性拉取最多 100 条并在前端按状态分组，以便跨状态同屏比较；超出部分请用表格视图查全量。
          </p>
          {renderBoard()}
        </>
      ) : (
        <DataTable<ContentListItem>
          columns={tableColumns}
          rows={tableQuery.data?.items ?? []}
          rowKey={(row) => row.id}
          loading={tableQuery.isLoading}
          error={tableQuery.isError ? resolveErrorMessage(tableQuery.error) : null}
          onRetry={() => void tableQuery.refetch()}
          emptyTitle="没有符合条件的内容"
          emptyDescription="试试放宽时间范围，或清空状态筛选"
          onSortChange={setSort}
          sortBy={query.sortBy}
          sortOrder={query.sortOrder}
          page={query.page}
          pageSize={query.pageSize}
          total={tableQuery.data?.total}
          totalPages={tableQuery.data?.totalPages}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
          pageSizeOptions={pageSizeOptions}
          onRowClick={(row) => navigate(`/contents/${row.id}`)}
          stickyHeader
        />
      )}

      {/* ---------------- 审核 ---------------- */}
      <Modal
        open={reviewTarget !== null}
        title={reviewForm.approved ? '通过审核' : '驳回内容'}
        description={reviewTarget?.title}
        onClose={reviewMutation.isPending ? () => undefined : () => setReviewTarget(null)}
        footer={
          <>
            <button
              type="button"
              className="btn"
              onClick={() => setReviewTarget(null)}
              disabled={reviewMutation.isPending}
            >
              取消
            </button>
            <button
              type="button"
              className={`btn ${reviewForm.approved ? 'btnPrimary' : 'btnDanger'}`}
              disabled={
                reviewMutation.isPending ||
                // 驳回必须写原因：不然达人只看到"被拒"却不知道改什么
                (!reviewForm.approved && reviewForm.note.trim().length < 5)
              }
              onClick={() => {
                if (!reviewTarget) return;
                reviewMutation.mutate({
                  id: reviewTarget.id,
                  approved: reviewForm.approved,
                  note: reviewForm.note,
                });
              }}
            >
              {reviewMutation.isPending && <span className="spinner" aria-hidden="true" />}
              {reviewForm.approved ? '确认通过' : '确认驳回'}
            </button>
          </>
        }
      >
        <div className="field">
          <label className={reviewForm.approved ? 'label' : 'label labelRequired'} htmlFor="review-note">
            {reviewForm.approved ? '审核备注（选填）' : '驳回原因'}
          </label>
          <textarea
            id="review-note"
            className="textarea"
            rows={4}
            value={reviewForm.note}
            placeholder={
              reviewForm.approved ? '例：脚本无违规表述，可排期' : '例：第 2 段出现"最有效"极限词，请改写后重提'
            }
            onChange={(event) => setReviewForm({ ...reviewForm, note: event.target.value })}
          />
          <span className={!reviewForm.approved && reviewForm.note.trim().length < 5 ? 'errorText' : 'hint'}>
            {reviewForm.approved
              ? '备注会写入审核记录，便于后续追溯'
              : `驳回原因至少 5 个字，当前 ${reviewForm.note.trim().length} 字，将同步给达人侧`}
          </span>
        </div>
      </Modal>

      {/* ---------------- 发布 ---------------- */}
      <Modal
        open={publishTarget !== null}
        title="标记为已发布"
        description={`${publishTarget?.title ?? ''}（${publishTarget ? PLATFORM_LABELS[publishTarget.platform] : ''}）`}
        onClose={publishMutation.isPending ? () => undefined : () => setPublishTarget(null)}
        footer={
          <>
            <button
              type="button"
              className="btn"
              onClick={() => setPublishTarget(null)}
              disabled={publishMutation.isPending}
            >
              取消
            </button>
            <button
              type="button"
              className="btn btnPrimary"
              disabled={publishMutation.isPending}
              onClick={() => {
                if (!publishTarget) return;
                publishMutation.mutate({ id: publishTarget.id, ...publishForm });
              }}
            >
              {publishMutation.isPending && <span className="spinner" aria-hidden="true" />}
              确认发布
            </button>
          </>
        }
      >
        <p className="muted" style={{ fontSize: 'var(--font-size-sm)', marginBottom: 'var(--space-3)' }}>
          填上作品链接后，数据同步与结算归因就能自动对上这条内容；两项都可以留空，稍后在详情页补。
        </p>
        <div className="formGrid">
          <div className="field fieldFull">
            <label className="label" htmlFor="publish-url">
              作品链接
            </label>
            <input
              id="publish-url"
              className="input"
              value={publishForm.publishedUrl}
              placeholder="https://..."
              onChange={(event) => setPublishForm({ ...publishForm, publishedUrl: event.target.value })}
            />
          </div>
          <div className="field fieldFull">
            <label className="label" htmlFor="publish-platform-id">
              平台作品 ID
            </label>
            <input
              id="publish-platform-id"
              className="input"
              value={publishForm.platformContentId}
              placeholder="平台侧的作品 id，用于精确采集数据"
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
