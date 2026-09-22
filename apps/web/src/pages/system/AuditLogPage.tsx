import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { getAuditTimeline, listAuditLogs } from '@/api/audit';
import { resolveErrorMessage } from '@/api/client';
import type { AuditAction, AuditLogItem } from '@/api/types';
import { DataTable, type Column } from '@/components/DataTable';
import { Drawer } from '@/components/Drawer';
import { ErrorState } from '@/components/EmptyState';
import { FilterBar } from '@/components/FilterBar';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';
import { PageHeader } from '@/components/PageHeader';
import { StatusTag, type StatusTone } from '@/components/StatusTag';
import { useTableQuery } from '@/hooks/useTableQuery';
import {
  AUDIT_ACTION_LABELS,
  AUDIT_ACTION_OPTIONS,
  AUDIT_RESOURCE_LABELS,
} from '@/utils/constants';
import { formatDateTime, formatMs, formatRelative } from '@/utils/format';

/**
 * 审计日志。
 *
 * 这个页面的核心是**字段级 diff**，而不是"把 before/after 两个 JSON 丢出来"：
 *   1) 审计是给人查问题的，一个结算单有 30+ 字段，全量对比等于没对比；
 *      所以只默认展示发生变化的字段，并提供"显示未变化字段"开关兜底；
 *   2) 值可能是对象/数组（如 tieredShares、calculationTrace），必须能展开看结构，
 *      因此统一走 JSON 序列化兜底；
 *   3) **审计日志自己也会泄露敏感数据**：一次编辑达人会把手机号明文写进快照，
 *      而能看日志的人不一定有 creator:sensitive:read 权限，因此这里再做一层脱敏。
 */

type AuditFilters = {
  keyword: string;
  resource: string;
  action: string;
  userId: string;
  success: string;
  from: string;
  to: string;
};

/** 动作 → 颜色。审计动作后端是字符串枚举（可能新增），未知值退化 neutral，不抛错 */
const ACTION_TONES: Record<string, StatusTone> = {
  CREATE: 'success',
  UPDATE: 'info',
  DELETE: 'danger',
  READ: 'neutral',
  APPROVE: 'success',
  REJECT: 'danger',
  EXPORT: 'warning',
  LOGIN: 'info',
  LOGOUT: 'neutral',
  PAY: 'primary',
  SYNC: 'info',
  OTHER: 'neutral',
};

/** 敏感字段名（含手机号 / 证件 / 密码 / 银行账号） */
const SENSITIVE_KEY_PATTERN = /phone|idCard|password|bank/i;

/** 脱敏：只保留前后各 3 个字符，中间用 *** 代替（够定位，又不足以还原） */
function maskValue(text: string): string {
  if (text.length <= 6) return '******';
  return `${text.slice(0, 3)}***${text.slice(-3)}`;
}

/**
 * 值 → 可读文本。
 * 字符串直接展示（否则每个值都带着引号，diff 表会非常吵）；
 * 对象/数组走 JSON.stringify，保证嵌套结构也看得见；循环引用等异常情况兜底 String()。
 */
function toDisplayText(value: unknown): string {
  if (value === undefined) return '（无该字段）';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

interface DiffRow {
  key: string;
  changed: boolean;
  sensitive: boolean;
  beforeText: string;
  afterText: string;
}

/** 字段级 diff：取 before / after 的 key 并集，逐字段比较展示文本 */
function buildDiffRows(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): DiffRow[] {
  const beforeData = before ?? {};
  const afterData = after ?? {};
  const keys = [...new Set([...Object.keys(beforeData), ...Object.keys(afterData)])].sort();

  return keys.map((key) => {
    const beforeText = toDisplayText(beforeData[key]);
    const afterText = toDisplayText(afterData[key]);
    const sensitive = SENSITIVE_KEY_PATTERN.test(key);
    return {
      key,
      changed: beforeText !== afterText,
      sensitive,
      beforeText: sensitive ? maskValue(beforeText) : beforeText,
      afterText: sensitive ? maskValue(afterText) : afterText,
    };
  });
}

export default function AuditLogPage() {
  const [selected, setSelected] = useState<AuditLogItem | null>(null);
  // 未变化字段默认折叠：审计场景下"什么没变"通常不是关注点
  const [showUnchanged, setShowUnchanged] = useState(false);
  // FilterBar 的关键词框是非受控 + 防抖实现，重置筛选时靠重挂载清掉输入框里的残留文本
  const [filterResetKey, setFilterResetKey] = useState(0);

  const table = useTableQuery<AuditFilters>({
    initialFilters: {
      keyword: '',
      resource: '',
      action: '',
      userId: '',
      success: '',
      from: '',
      to: '',
    },
    initialPageSize: 20,
    initialSort: { sortBy: 'createdAt', sortOrder: 'desc' },
  });
  const filters = table.filters;

  const listQuery = useQuery({
    queryKey: ['audit-logs', 'list', table.query],
    queryFn: () =>
      listAuditLogs({
        page: table.query.page,
        pageSize: table.query.pageSize,
        sortBy: table.query.sortBy,
        sortOrder: table.query.sortOrder,
        keyword: filters.keyword,
        resource: filters.resource,
        action: filters.action,
        userId: filters.userId,
        // 'true' / 'false' 字符串：后端按字符串接收，空串会被 buildParams 丢掉表示"全部"
        success: filters.success,
        from: filters.from,
        to: filters.to,
      }),
    placeholderData: keepPreviousData,
  });

  // 时间线：只有选中日志带 resourceId 时才请求，避免抽屉里出现无意义的空请求
  const timelineResource = selected?.resource ?? '';
  const timelineResourceId = selected?.resourceId ?? '';
  const timelineQuery = useQuery({
    queryKey: ['audit-logs', 'timeline', timelineResource, timelineResourceId],
    queryFn: () => getAuditTimeline(timelineResource, timelineResourceId, 50),
    enabled: timelineResourceId !== '',
  });

  const diffRows = selected === null ? [] : buildDiffRows(selected.before, selected.after);
  const changedCount = diffRows.filter((row) => row.changed).length;
  const visibleDiffRows = showUnchanged ? diffRows : diffRows.filter((row) => row.changed);

  const resourceOptions = Object.entries(AUDIT_RESOURCE_LABELS).map(([value, label]) => ({
    value,
    label,
  }));

  const columns: Array<Column<AuditLogItem>> = [
    {
      key: 'createdAt',
      title: '时间',
      sortable: true,
      // 绝对时间用来对账，相对时间（hover）用来快速判断"是不是刚刚发生的事"
      render: (row) => <span title={formatRelative(row.createdAt)}>{formatDateTime(row.createdAt)}</span>,
    },
    {
      key: 'userName',
      title: '操作人',
      render: (row) => row.userName ?? <span className="subtle">系统 / 未知</span>,
    },
    {
      key: 'action',
      title: '动作',
      render: (row) => (
        <StatusTag tone={ACTION_TONES[row.action] ?? 'neutral'} size="sm">
          {AUDIT_ACTION_LABELS[row.action as AuditAction] ?? row.action}
        </StatusTag>
      ),
    },
    {
      key: 'resource',
      title: '资源',
      render: (row) => AUDIT_RESOURCE_LABELS[row.resource] ?? row.resource,
    },
    {
      key: 'resourceId',
      title: '资源 ID',
      render: (row) =>
        row.resourceId ? (
          <span
            className="mono ellipsis"
            style={{ display: 'inline-block', maxWidth: 160 }}
            title={row.resourceId}
          >
            {row.resourceId}
          </span>
        ) : (
          <span className="subtle">—</span>
        ),
    },
    {
      key: 'success',
      title: '结果',
      render: (row) => (
        <div className="row" style={{ gap: 'var(--space-1)' }}>
          <StatusTag tone={row.success ? 'success' : 'danger'} size="sm" dot>
            {row.success ? '成功' : '失败'}
          </StatusTag>
          {!row.success && row.message && (
            <span className="ellipsis" style={{ maxWidth: 200 }} title={row.message}>
              {row.message}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'ip',
      title: 'IP',
      render: (row) => (row.ip ? <span className="mono">{row.ip}</span> : <span className="subtle">—</span>),
    },
    {
      key: 'durationMs',
      title: '耗时',
      align: 'right',
      render: (row) => <span className="mono">{formatMs(row.durationMs)}</span>,
    },
    {
      key: 'actions',
      title: '操作',
      render: (row) => (
        <button
          type="button"
          className="btnLink"
          onClick={() => {
            setShowUnchanged(false);
            setSelected(row);
          }}
        >
          查看变更
        </button>
      ),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title="审计日志"
        subtitle="所有写操作都会留痕；点击「查看变更」可以逐字段比对变更前后，敏感字段已脱敏展示"
      />

      <FilterBar
        key={filterResetKey}
        fields={[
          {
            type: 'keyword',
            key: 'keyword',
            value: filters.keyword,
            placeholder: '搜索资源名 / 消息内容',
            onChange: (value) => table.setFilters({ keyword: value }),
          },
          {
            type: 'select',
            key: 'resource',
            label: '资源类型',
            value: filters.resource,
            options: resourceOptions,
            onChange: (value) => table.setFilters({ resource: value }),
          },
          {
            type: 'select',
            key: 'action',
            label: '动作',
            value: filters.action,
            options: AUDIT_ACTION_OPTIONS,
            onChange: (value) => table.setFilters({ action: value }),
          },
          {
            type: 'select',
            key: 'success',
            label: '结果',
            value: filters.success,
            options: [
              { value: 'true', label: '成功' },
              { value: 'false', label: '失败' },
            ],
            onChange: (value) => table.setFilters({ success: value }),
          },
          {
            type: 'date',
            key: 'from',
            label: '开始日期',
            value: filters.from,
            onChange: (value) => table.setFilters({ from: value }),
          },
          {
            type: 'date',
            key: 'to',
            label: '结束日期',
            value: filters.to,
            onChange: (value) => table.setFilters({ to: value }),
          },
          {
            type: 'custom',
            key: 'userId',
            label: '操作人 ID',
            // FilterBar 没有纯文本类型，用 custom 渲染 UUID 输入框：
            // 操作人 ID 是精确匹配，混进 keyword 会变成模糊搜索而查不到人
            render: () => (
              <input
                className="input mono"
                style={{ width: 260 }}
                type="text"
                placeholder="员工 UUID（精确匹配）"
                value={filters.userId}
                onChange={(event) => table.setFilters({ userId: event.target.value })}
              />
            ),
          },
        ]}
        onReset={() => {
          table.reset();
          setFilterResetKey((prev) => prev + 1);
        }}
        resultCount={listQuery.data?.total}
      />

      <DataTable<AuditLogItem>
        columns={columns}
        rows={listQuery.data?.items ?? []}
        rowKey={(row) => row.id}
        loading={listQuery.isLoading}
        error={listQuery.isError ? resolveErrorMessage(listQuery.error) : null}
        onRetry={() => {
          void listQuery.refetch();
        }}
        onSortChange={table.setSort}
        sortBy={table.query.sortBy}
        sortOrder={table.query.sortOrder}
        page={table.query.page}
        pageSize={table.query.pageSize}
        total={listQuery.data?.total}
        totalPages={listQuery.data?.totalPages}
        onPageChange={table.setPage}
        onPageSizeChange={table.setPageSize}
        pageSizeOptions={table.pageSizeOptions}
        emptyTitle="没有符合条件的审计记录"
        emptyDescription="审计日志按时间倒序保留全部写操作，试试放宽时间范围或清空筛选条件"
        stickyHeader
      />

      <Drawer
        open={selected !== null}
        title="变更详情"
        description={selected ? `${formatDateTime(selected.createdAt)} · ${selected.userName ?? '系统'}` : undefined}
        size="wide"
        onClose={() => setSelected(null)}
        footer={
          <button type="button" className="btn" onClick={() => setSelected(null)}>
            关闭
          </button>
        }
      >
        {selected && (
          <div className="stack">
            <dl className="descriptions">
              <div className="descriptionsItem">
                <dt>动作</dt>
                <dd>
                  <StatusTag tone={ACTION_TONES[selected.action] ?? 'neutral'} size="sm">
                    {AUDIT_ACTION_LABELS[selected.action as AuditAction] ?? selected.action}
                  </StatusTag>
                </dd>
              </div>
              <div className="descriptionsItem">
                <dt>资源</dt>
                <dd>
                  {AUDIT_RESOURCE_LABELS[selected.resource] ?? selected.resource}
                  {selected.resourceId && <span className="mono"> · {selected.resourceId}</span>}
                </dd>
              </div>
              <div className="descriptionsItem">
                <dt>结果</dt>
                <dd>
                  <StatusTag tone={selected.success ? 'success' : 'danger'} size="sm" dot>
                    {selected.success ? '成功' : '失败'}
                  </StatusTag>
                  {selected.message && <span className="muted"> {selected.message}</span>}
                </dd>
              </div>
              <div className="descriptionsItem">
                <dt>IP / 耗时</dt>
                <dd>
                  <span className="mono">{selected.ip ?? '—'}</span> ·{' '}
                  <span className="mono">{formatMs(selected.durationMs)}</span>
                </dd>
              </div>
              <div className="descriptionsItem">
                <dt>User Agent</dt>
                <dd className="mono" style={{ wordBreak: 'break-all' }}>
                  {selected.userAgent ?? '—'}
                </dd>
              </div>
            </dl>

            <div className="divider" />

            <div className="rowBetween">
              <div className="sectionTitle" style={{ marginBottom: 0 }}>
                字段变更（{changedCount} 个字段发生变化，共 {diffRows.length} 个）
              </div>
              <label className="checkboxRow" htmlFor="audit-show-unchanged">
                <input
                  id="audit-show-unchanged"
                  type="checkbox"
                  checked={showUnchanged}
                  onChange={(event) => setShowUnchanged(event.target.checked)}
                />
                显示未变化字段
              </label>
            </div>

            {/* 新建/删除没有对照侧，必须显式说明，否则用户会以为 diff 缺失 */}
            {selected.before === null && (
              <div className="hint">本次操作是<strong>新建</strong>：没有变更前快照，右侧全是新增的值。</div>
            )}
            {selected.after === null && (
              <div className="hint">
                本次操作是<strong>删除</strong>：没有变更后快照，左侧是删除前的最后状态。
              </div>
            )}
            {selected.before === null && selected.after === null && (
              <div className="hint">
                该操作没有快照数据（如登录/导出类动作），请结合操作人、IP 与消息内容判断。
              </div>
            )}

            {visibleDiffRows.length === 0 ? (
              <div className="emptyInline">
                {diffRows.length === 0
                  ? '这条日志没有可对比的字段快照'
                  : '所有字段的值都没有变化（可勾选「显示未变化字段」查看全量）'}
              </div>
            ) : (
              <div className="tableWrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ width: 200 }}>字段</th>
                      <th>变更前</th>
                      <th>变更后</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleDiffRows.map((row) => (
                      <tr key={row.key}>
                        <td className="mono" style={{ verticalAlign: 'top', wordBreak: 'break-all' }}>
                          {row.key}
                          {row.sensitive && (
                            <>
                              {' '}
                              <StatusTag tone="warning" size="sm" title="敏感字段已脱敏展示">
                                已脱敏
                              </StatusTag>
                            </>
                          )}
                        </td>
                        <td
                          style={{
                            verticalAlign: 'top',
                            wordBreak: 'break-all',
                            // 变更前用红底、变更后用绿底：颜色是"从哪来到哪去"最快的编码方式
                            background: row.changed ? 'var(--color-danger-bg)' : undefined,
                          }}
                        >
                          {row.beforeText}
                        </td>
                        <td
                          style={{
                            verticalAlign: 'top',
                            wordBreak: 'break-all',
                            background: row.changed ? 'var(--color-success-bg)' : undefined,
                          }}
                        >
                          {row.afterText}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {selected.resourceId && (
              <>
                <div className="divider" />
                <div className="sectionTitle">该资源的完整操作记录</div>

                {timelineQuery.isLoading && <LoadingSkeleton rows={4} columns={2} />}

                {timelineQuery.isError && (
                  <ErrorState
                    message={resolveErrorMessage(timelineQuery.error)}
                    onRetry={() => {
                      void timelineQuery.refetch();
                    }}
                    compact
                  />
                )}

                {timelineQuery.data?.length === 0 && (
                  <div className="emptyInline">该资源只有当前这一条操作记录</div>
                )}

                {(timelineQuery.data ?? []).map((item) => (
                  <div
                    key={item.id}
                    style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-start' }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        width: 12,
                        flex: '0 0 auto',
                      }}
                    >
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          marginTop: 6,
                          borderRadius: '50%',
                          background: item.success ? 'var(--color-primary-600)' : 'var(--color-danger)',
                        }}
                      />
                      <span style={{ flex: '1 1 auto', width: 2, background: 'var(--color-border)' }} />
                    </div>
                    <div style={{ flex: '1 1 auto', minWidth: 0, paddingBottom: 'var(--space-3)' }}>
                      <div className="row wrap" style={{ gap: 'var(--space-2)' }}>
                        <StatusTag tone={ACTION_TONES[item.action] ?? 'neutral'} size="sm">
                          {AUDIT_ACTION_LABELS[item.action as AuditAction] ?? item.action}
                        </StatusTag>
                        <span className="muted">{formatDateTime(item.createdAt)}</span>
                        <span className="subtle">{item.userName ?? '系统'}</span>
                      </div>
                      {item.message && <div className="hint">{item.message}</div>}
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
}
