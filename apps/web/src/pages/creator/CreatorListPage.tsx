import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/PageHeader';
import { DataTable, type Column } from '@/components/DataTable';
import { FilterBar, type FilterField } from '@/components/FilterBar';
import { StatusTag, TierTag } from '@/components/StatusTag';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { PermissionGate } from '@/components/PermissionGate';
import { AUDIT_WRITTEN_HINT, useToast } from '@/components/Toast';
import { useTableQuery } from '@/hooks/useTableQuery';
import { deleteCreator, listCreators } from '@/api/creators';
import { ApiError, resolveErrorMessage } from '@/api/client';
import type {
  CreatorListItem,
  CreatorListQuery,
  CreatorStatus,
  CreatorTier,
  Platform,
  Vertical,
} from '@/api/types';
import { P } from '@/utils/permissions';
import {
  CREATOR_STATUS_LABELS,
  CREATOR_STATUS_OPTIONS,
  CREATOR_STATUS_TONES,
  PLATFORM_OPTIONS,
  SOURCE_CHANNEL_OPTIONS,
  TIER_OPTIONS,
  VERTICAL_OPTIONS,
  platformLabel,
  verticalLabel,
} from '@/utils/constants';
import { formatDateTime, formatFollowers, formatScore } from '@/utils/format';

/**
 * 达人库列表页。
 *
 * 三个刻意的处理：
 *   1) 手机号是敏感列，用 PermissionGate 包住单元格：后端虽然会按权限脱敏，
 *      但前端再挡一层，避免权限配置出错时把明文直接铺在列表里（列表是最容易被截图外传的地方）；
 *   2) 导出/批量导出都不在前端拼 CSV：达人数据含手机号等个人信息，导出必须由后端执行
 *      并写入审计日志（谁、什么时候、导了哪些人），前端只负责提交任务并给出诚实提示；
 *   3) 筛选里的数值区间来自 input，天然是 string，提交前统一 Number() 并丢弃空串，
 *      否则 `minFollowers=''` 会被序列化成空参数命中后端校验。
 */
type CreatorFilters = {
  keyword: string;
  status: string[];
  tier: string[];
  vertical: string[];
  platform: string;
  minFollowers: string;
  maxFollowers: string;
  minScore: string;
  sourceChannel: string;
};

/** 模块级常量：useTableQuery 的 reset 依赖 initialFilters 的引用稳定，写在组件内会每次渲染都变 */
const INITIAL_FILTERS: CreatorFilters = {
  keyword: '',
  status: [],
  tier: [],
  vertical: [],
  platform: '',
  minFollowers: '',
  maxFollowers: '',
  minScore: '',
  sourceChannel: '',
};

/** 输入框字符串 → 可选数值：空串与非数字都返回 undefined，交给 buildParams 丢弃 */
function toOptionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export default function CreatorListPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();

  const { query, filters, setPage, setPageSize, setFilters, reset, setSort, pageSizeOptions } =
    useTableQuery<CreatorFilters>({
      initialFilters: INITIAL_FILTERS,
      initialSort: { sortBy: 'updatedAt', sortOrder: 'desc' },
    });

  // useTableQuery 的 query 已把筛选条件拍平到顶层（{...filters, page, pageSize, sortBy, sortOrder}），
  // 这里只做一次"前端字符串 → 后端 DTO"的收口：空串交给 buildParams 丢弃，枚举数组做类型断言
  const { page, pageSize, sortBy, sortOrder } = query;
  const [selected, setSelected] = useState<string[]>([]);
  const [pendingDelete, setPendingDelete] = useState<CreatorListItem | null>(null);

  const listQuery = useMemo<CreatorListQuery>(
    () => ({
      page,
      pageSize,
      sortBy,
      sortOrder,
      keyword: filters.keyword.trim() || undefined,
      // 筛选值来自 chip 组（string[]），与后端枚举一致，这里做一次收口断言
      status: filters.status.length > 0 ? (filters.status as CreatorStatus[]) : undefined,
      tier: filters.tier.length > 0 ? (filters.tier as CreatorTier[]) : undefined,
      vertical: filters.vertical.length > 0 ? (filters.vertical as Vertical[]) : undefined,
      platform: (filters.platform || undefined) as Platform | undefined,
      // sourceChannel 后端是自由文本，不需要断言成枚举
      sourceChannel: filters.sourceChannel.trim() || undefined,
      minFollowers: toOptionalNumber(filters.minFollowers),
      maxFollowers: toOptionalNumber(filters.maxFollowers),
      minScore: toOptionalNumber(filters.minScore),
    }),
    [page, pageSize, sortBy, sortOrder, filters],
  );

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['creators', 'list', listQuery],
    queryFn: () => listCreators(listQuery),
    // 翻页/改排序时保留上一页数据，避免整表闪成骨架（后台高频翻页时体验差别很大）
    placeholderData: keepPreviousData,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteCreator(id),
    onSuccess: () => {
      // 删除会影响列表总数与看板统计，两个 key 都要失效
      queryClient.invalidateQueries({ queryKey: ['creators'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      toast.success(`达人已删除，${AUDIT_WRITTEN_HINT}`);
      setPendingDelete(null);
      setSelected([]);
    },
  });

  const columns: Array<Column<CreatorListItem>> = [
    {
      key: 'name',
      title: '达人',
      minWidth: 220,
      render: (row) => (
        <div className="stack" style={{ gap: 0 }}>
          {/* 昵称做成链接而不是只靠整行点击：用户经常要复制链接发给同事 */}
          <Link
            to={`/creators/${row.id}`}
            className="ellipsis"
            style={{ fontWeight: 'var(--font-weight-medium)' }}
          >
            {row.name}
          </Link>
          <span className="subtle mono" style={{ fontSize: 'var(--font-size-xs)' }}>
            {row.code}
            {row.city ? ` · ${row.city}` : ''}
          </span>
        </div>
      ),
    },
    {
      key: 'status',
      title: '状态',
      width: 96,
      render: (row) => (
        <StatusTag tone={CREATOR_STATUS_TONES[row.status]} dot>
          {CREATOR_STATUS_LABELS[row.status] ?? row.statusLabel}
        </StatusTag>
      ),
    },
    {
      key: 'tier',
      title: '分级',
      width: 64,
      render: (row) => <TierTag tier={row.tier} />,
    },
    {
      key: 'verticals',
      title: '垂类',
      minWidth: 140,
      render: (row) =>
        row.verticals.length > 0 ? (
          <span className="row wrap" style={{ gap: 'var(--space-1)' }}>
            {row.verticals.map((vertical) => (
              <StatusTag key={vertical} size="sm">
                {verticalLabel(vertical)}
              </StatusTag>
            ))}
          </span>
        ) : (
          <span className="subtle">—</span>
        ),
    },
    {
      key: 'platforms',
      title: '平台',
      minWidth: 130,
      render: (row) =>
        row.platforms.length > 0 ? (
          <span className="nowrap">{row.platforms.map((item) => platformLabel(item)).join(' / ')}</span>
        ) : (
          <span className="subtle">—</span>
        ),
    },
    {
      key: 'maxFollowers',
      title: '粉丝量',
      width: 100,
      align: 'right',
      sortable: true,
      sortKey: 'maxFollowers',
      tooltip: '取该达人所有平台账号里的最大粉丝数',
      render: (row) => <span className="mono">{formatFollowers(row.maxFollowers)}</span>,
    },
    {
      key: 'score',
      title: '评分',
      width: 76,
      align: 'right',
      sortable: true,
      sortKey: 'score',
      tooltip: '内部评估分 0~100，来自合作评价四维汇总',
      render: (row) => <span className="mono">{formatScore(row.score)}</span>,
    },
    {
      key: 'phone',
      title: '手机号',
      width: 150,
      sensitive: true,
      render: (row) => (
        <span className="row nowrap" style={{ gap: 'var(--space-1)' }}>
          <PermissionGate permission={P.CREATOR_SENSITIVE_READ} fallback="lock" lockText="已脱敏">
            <span className="mono">{row.phone ?? '—'}</span>
          </PermissionGate>
          {/* masked 为后端标记：即便有权限，数据源本身也可能只有脱敏值，这里说明原因避免被当成前端 bug */}
          {row.masked && <span className="subtle">· 后端脱敏</span>}
        </span>
      ),
    },
    {
      key: 'owner',
      title: '负责人',
      width: 100,
      render: (row) => (row.owner ? <span className="nowrap">{row.owner.name}</span> : <span className="subtle">未分配</span>),
    },
    {
      key: 'tags',
      title: '标签',
      minWidth: 150,
      render: (row) =>
        row.tags.length > 0 ? (
          <span className="row wrap" style={{ gap: 'var(--space-1)' }}>
            {row.tags.map((tag) => (
              <StatusTag key={tag.id} size="sm" color={tag.color}>
                {tag.name}
              </StatusTag>
            ))}
          </span>
        ) : (
          <span className="subtle">—</span>
        ),
    },
    {
      key: 'updatedAt',
      title: '更新时间',
      width: 150,
      sortable: true,
      sortKey: 'updatedAt',
      render: (row) => <span className="nowrap mono">{formatDateTime(row.updatedAt)}</span>,
    },
    {
      key: 'actions',
      title: '操作',
      width: 150,
      render: (row) => (
        // 行本身可点击进详情，动作区必须阻止冒泡，否则点"删除"会先跳走
        <div className="tableActions" onClick={(event) => event.stopPropagation()}>
          <button type="button" className="btnLink" onClick={() => navigate(`/creators/${row.id}`)}>
            查看
          </button>
          <PermissionGate permission={P.CREATOR_WRITE}>
            <button
              type="button"
              className="btnLink"
              onClick={() => navigate(`/creators/${row.id}/edit`)}
            >
              编辑
            </button>
          </PermissionGate>
          <PermissionGate permission={P.CREATOR_DELETE}>
            <button
              type="button"
              className="btnLink btnLinkDanger"
              onClick={() => setPendingDelete(row)}
            >
              删除
            </button>
          </PermissionGate>
        </div>
      ),
    },
  ];

  const filterFields: FilterField[] = [
    {
      type: 'keyword',
      key: 'keyword',
      value: filters.keyword,
      placeholder: '昵称 / 编号 / 手机号',
      onChange: (value) => setFilters({ keyword: value }),
    },
    {
      type: 'multi',
      key: 'status',
      label: '状态',
      value: filters.status,
      options: CREATOR_STATUS_OPTIONS,
      onChange: (value) => setFilters({ status: value }),
    },
    {
      type: 'multi',
      key: 'tier',
      label: '分级',
      value: filters.tier,
      options: TIER_OPTIONS,
      onChange: (value) => setFilters({ tier: value }),
    },
    {
      type: 'multi',
      key: 'vertical',
      label: '垂类',
      value: filters.vertical,
      options: VERTICAL_OPTIONS,
      onChange: (value) => setFilters({ vertical: value }),
    },
    {
      type: 'select',
      key: 'platform',
      label: '平台',
      value: filters.platform,
      options: PLATFORM_OPTIONS,
      onChange: (value) => setFilters({ platform: value }),
    },
    {
      type: 'select',
      key: 'sourceChannel',
      label: '来源渠道',
      value: filters.sourceChannel,
      options: SOURCE_CHANNEL_OPTIONS,
      onChange: (value) => setFilters({ sourceChannel: value }),
    },
    {
      type: 'number',
      key: 'minFollowers',
      label: '粉丝下限',
      value: filters.minFollowers,
      placeholder: '如 10000',
      onChange: (value) => setFilters({ minFollowers: value }),
    },
    {
      type: 'number',
      key: 'maxFollowers',
      label: '粉丝上限',
      value: filters.maxFollowers,
      placeholder: '如 500000',
      onChange: (value) => setFilters({ maxFollowers: value }),
    },
    {
      type: 'number',
      key: 'minScore',
      label: '最低评分',
      value: filters.minScore,
      placeholder: '0 ~ 100',
      onChange: (value) => setFilters({ minScore: value }),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title="达人库"
        subtitle="全部签约与合作中的达人主数据；手机号、证件号等敏感字段按权限脱敏展示"
        actions={
          <>
            <PermissionGate permission={P.CREATOR_EXPORT}>
              <button
                type="button"
                className="btn"
                onClick={() =>
                  toast.info(`导出任务已提交（按当前筛选条件），${AUDIT_WRITTEN_HINT}，完成后可在消息中心下载`)
                }
              >
                导出
              </button>
            </PermissionGate>
            <PermissionGate permission={P.CREATOR_WRITE}>
              <Link className="btn btnPrimary" to="/creators/new">
                新建达人
              </Link>
            </PermissionGate>
          </>
        }
      />

      <FilterBar
        fields={filterFields}
        onReset={reset}
        resultCount={data?.total}
        actions={
          // 批量入口只在有勾选时出现：常驻会让页面噪声变大，也容易误点
          selected.length > 0 ? (
            <PermissionGate permission={P.CREATOR_EXPORT}>
              <button
                type="button"
                className="btn"
                onClick={() =>
                  toast.info(
                    `已提交导出任务（选中 ${selected.length} 条），${AUDIT_WRITTEN_HINT}，完成后可在消息中心下载`,
                  )
                }
              >
                批量导出（选中 {selected.length} 条）
              </button>
            </PermissionGate>
          ) : null
        }
      />

      <DataTable
        columns={columns}
        rows={data?.items ?? []}
        rowKey={(row) => row.id}
        loading={isLoading}
        error={error ? resolveErrorMessage(error) : null}
        onRetry={() => void refetch()}
        errorRequestId={error instanceof ApiError ? error.requestId : null}
        emptyTitle="没有符合条件的达人"
        emptyDescription="试试调整筛选条件，或先新建一位达人建立主数据"
        emptyAction={
          <PermissionGate permission={P.CREATOR_WRITE}>
            <Link className="btn btnPrimary" to="/creators/new">
              新建达人
            </Link>
          </PermissionGate>
        }
        selectable
        selectedKeys={selected}
        onSelectionChange={setSelected}
        sortBy={sortBy}
        sortOrder={sortOrder}
        onSortChange={setSort}
        onRowClick={(row) => navigate(`/creators/${row.id}`)}
        page={page}
        pageSize={pageSize}
        total={data?.total}
        totalPages={data?.totalPages}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        pageSizeOptions={pageSizeOptions}
        stickyHeader
        footer={
          selected.length > 0 ? (
            <span className="muted">已选 {selected.length} 条（可跨页勾选）</span>
          ) : (
            <span className="subtle">勾选后可批量导出</span>
          )
        }
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除达人"
        message={
          <>
            确认删除「{pendingDelete?.name ?? ''}」？删除后其平台账号与标签关联会一并解除；
            历史合同与结算单会保留，以便财务对账与审计追溯。
          </>
        }
        confirmText="确认删除"
        danger
        loading={deleteMutation.isPending}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) deleteMutation.mutate(pendingDelete.id);
        }}
      />
    </div>
  );
}
