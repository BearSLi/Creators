import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { PageHeader } from '@/components/PageHeader';
import { DataTable, type Column } from '@/components/DataTable';
import { FilterBar, type FilterField } from '@/components/FilterBar';
import { StatusTag } from '@/components/StatusTag';
import { MoneyText } from '@/components/MoneyText';
import { PermissionGate } from '@/components/PermissionGate';
import { useTableQuery } from '@/hooks/useTableQuery';
import { listContracts } from '@/api/contracts';
import { ApiError, resolveErrorMessage } from '@/api/client';
import type { ContractListItem, ContractListQuery, ContractStatus } from '@/api/types';
import { P } from '@/utils/permissions';
import {
  CONTRACT_STATUS_LABELS,
  CONTRACT_STATUS_OPTIONS,
  CONTRACT_STATUS_TONES,
  SETTLEMENT_MODE_LABELS,
} from '@/utils/constants';
import { formatBp, formatDate, formatDateTime } from '@/utils/format';

/**
 * 合同列表页。
 *
 * 两个业务取舍：
 *   1) 达人/品牌筛选用 UUID 文本输入而不是下拉：后端没有提供"达人/品牌下拉"接口
 *      （listUsers 之类需要额外的读权限，跨模块调用会放大权限面），
 *      与其在前端偷偷拉一页数据假装是下拉，不如明确要求填 ID，并在提示里说清怎么做；
 *   2) 分润列只展示达人分成基点，四档完整规则进详情看：
 *      列表里塞四个百分比会把表格压垮，而真正做判断时需要的是完整规则卡片。
 */
type ContractFilters = {
  keyword: string;
  status: string[];
  creatorId: string;
  brandId: string;
};

const INITIAL_FILTERS: ContractFilters = {
  keyword: '',
  status: [],
  creatorId: '',
  brandId: '',
};

export default function ContractListPage() {
  const navigate = useNavigate();

  const { query, filters, setPage, setPageSize, setFilters, reset, setSort, pageSizeOptions } =
    useTableQuery<ContractFilters>({
      initialFilters: INITIAL_FILTERS,
      initialSort: { sortBy: 'createdAt', sortOrder: 'desc' },
    });

  // query 已把筛选条件拍平到顶层（{...filters, page, pageSize, sortBy, sortOrder}），
  // filters 单独用来回填筛选控件；这里只把状态数组收口成后端枚举类型
  const { page, pageSize, sortBy, sortOrder } = query;
  const [hintOpen, setHintOpen] = useState(false);

  const listQuery = useMemo<ContractListQuery>(
    () => ({
      page,
      pageSize,
      sortBy,
      sortOrder,
      keyword: filters.keyword.trim() || undefined,
      status: filters.status.length > 0 ? (filters.status as ContractStatus[]) : undefined,
      creatorId: filters.creatorId.trim() || undefined,
      brandId: filters.brandId.trim() || undefined,
    }),
    [page, pageSize, sortBy, sortOrder, filters],
  );

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['contracts', 'list', listQuery],
    queryFn: () => listContracts(listQuery),
    placeholderData: keepPreviousData,
  });

  const columns: Array<Column<ContractListItem>> = [
    {
      key: 'code',
      title: '合同编号',
      width: 150,
      render: (row) => <span className="mono">{row.code}</span>,
    },
    {
      key: 'title',
      title: '标题',
      minWidth: 200,
      ellipsis: true,
      tooltip: '点击行可进入合同详情',
      render: (row) => <span className="ellipsis">{row.title}</span>,
    },
    {
      key: 'creatorName',
      title: '达人',
      width: 120,
      render: (row) => (
        <Link to={`/creators/${row.creatorId}`} onClick={(event) => event.stopPropagation()}>
          {row.creatorName}
        </Link>
      ),
    },
    {
      key: 'brandName',
      title: '品牌',
      width: 130,
      render: (row) => (row.brandName ? row.brandName : <span className="subtle">—</span>),
    },
    {
      key: 'status',
      title: '状态',
      width: 92,
      render: (row) => (
        <StatusTag tone={CONTRACT_STATUS_TONES[row.status]} dot>
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
      title: '固定费用（元）',
      width: 130,
      align: 'right',
      sortable: true,
      sortKey: 'fixedFee',
      render: (row) => <MoneyText value={row.fixedFee} variant="plain" />,
    },
    {
      key: 'talentShareBp',
      title: '分润（达人）',
      width: 110,
      align: 'right',
      tooltip: '达人分成基点，1000 = 10%；完整四档比率见合同详情',
      render: (row) => <span className="mono">{formatBp(row.talentShareBp)}</span>,
    },
    {
      key: 'effectiveFrom',
      title: '生效期',
      width: 200,
      sortable: true,
      sortKey: 'effectiveFrom',
      render: (row) => (
        <span className="nowrap mono">
          {formatDate(row.effectiveFrom)} ~ {row.effectiveTo ? formatDate(row.effectiveTo) : '长期'}
        </span>
      ),
    },
    {
      key: 'signedAt',
      title: '签署时间',
      width: 150,
      sortable: true,
      sortKey: 'signedAt',
      render: (row) => (
        <span className="nowrap mono">
          {row.signedAt ? formatDateTime(row.signedAt) : <span className="subtle">未签署</span>}
        </span>
      ),
    },
    {
      key: 'exclusivity',
      title: '独家',
      width: 84,
      render: (row) =>
        row.exclusivity ? (
          <StatusTag tone="danger" size="sm" title="独家合作：合同期内不得接同类竞品">
            独家
          </StatusTag>
        ) : (
          <span className="subtle">非独家</span>
        ),
    },
    {
      key: 'actions',
      title: '操作',
      width: 120,
      render: (row) => (
        // 行点击已用于进详情，动作按钮必须阻止冒泡
        <div className="tableActions" onClick={(event) => event.stopPropagation()}>
          <button type="button" className="btnLink" onClick={() => navigate(`/contracts/${row.id}`)}>
            查看
          </button>
          <PermissionGate permission={P.CONTRACT_WRITE}>
            <button
              type="button"
              className="btnLink"
              onClick={() => navigate(`/contracts/${row.id}/edit`)}
            >
              编辑
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
      placeholder: '合同编号 / 标题',
      onChange: (value) => setFilters({ keyword: value }),
    },
    {
      type: 'multi',
      key: 'status',
      label: '状态',
      value: filters.status,
      options: CONTRACT_STATUS_OPTIONS,
      onChange: (value) => setFilters({ status: value }),
    },
    {
      type: 'custom',
      key: 'creatorId',
      label: '达人 ID',
      render: () => (
        <input
          className="input mono"
          style={{ width: 260 }}
          value={filters.creatorId}
          placeholder="达人 UUID"
          title="后端未提供达人下拉接口，请粘贴达人 UUID"
          onChange={(event) => setFilters({ creatorId: event.target.value })}
        />
      ),
    },
    {
      type: 'custom',
      key: 'brandId',
      label: '品牌 ID',
      render: () => (
        <input
          className="input mono"
          style={{ width: 260 }}
          value={filters.brandId}
          placeholder="品牌 UUID"
          title="后端未提供品牌下拉接口，请粘贴品牌 UUID"
          onChange={(event) => setFilters({ brandId: event.target.value })}
        />
      ),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title="合同管理"
        subtitle="达人/品牌筛选用 UUID 输入：后端未提供下拉接口，不做假的候选列表"
        actions={
          <PermissionGate permission={P.CONTRACT_WRITE}>
            <Link className="btn btnPrimary" to="/contracts/new">
              拟定合同
            </Link>
          </PermissionGate>
        }
      />

      <FilterBar
        fields={filterFields}
        onReset={reset}
        resultCount={data?.total}
        actions={
          <button type="button" className="btn btnGhost" onClick={() => setHintOpen((prev) => !prev)}>
            {hintOpen ? '收起填写说明' : '如何填写 ID？'}
          </button>
        }
      />

      {hintOpen && (
        <div className="card" style={{ marginTop: 'var(--space-3)' }}>
          <div className="cardBody">
            <p className="hint">
              达人 ID / 品牌 ID 需要填写 UUID。可以在「达人库」或「品牌管理」列表里打开一条记录，
              从浏览器地址栏复制路径末尾的 ID；合同详情页的关联信息里也能看到对应的达人 ID。
              后端暂未提供达人 / 品牌的下拉查询接口，因此这里不提供候选列表，避免前端拉全量数据造成性能与权限问题。
            </p>
          </div>
        </div>
      )}

      <DataTable
        columns={columns}
        rows={data?.items ?? []}
        rowKey={(row) => row.id}
        loading={isLoading}
        error={error ? resolveErrorMessage(error) : null}
        onRetry={() => void refetch()}
        errorRequestId={error instanceof ApiError ? error.requestId : null}
        emptyTitle="没有符合条件的合同"
        emptyDescription="调整筛选条件，或先拟定一份新合同"
        emptyAction={
          <PermissionGate permission={P.CONTRACT_WRITE}>
            <Link className="btn btnPrimary" to="/contracts/new">
              拟定合同
            </Link>
          </PermissionGate>
        }
        sortBy={sortBy}
        sortOrder={sortOrder}
        onSortChange={setSort}
        onRowClick={(row) => navigate(`/contracts/${row.id}`)}
        page={page}
        pageSize={pageSize}
        total={data?.total}
        totalPages={data?.totalPages}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        pageSizeOptions={pageSizeOptions}
        stickyHeader
        footer={<span className="subtle">金额均为字符串元，前端不做加减</span>}
      />
    </div>
  );
}
