import { useMemo, useState, type ReactNode } from 'react';
import { Pagination } from './Pagination';
import { LoadingSkeleton } from './LoadingSkeleton';
import { EmptyState, ErrorState } from './EmptyState';
import type { SortPayload } from '@/api/types';
import styles from './DataTable.module.css';

/**
 * 泛型表格。
 *
 * 目标是把 20 个列表页重复的"四态 + 排序 + 分页"收敛成一个组件：
 *   加载中 → 骨架屏（保持列宽，不跳动）
 *   出错   → 错误态 + 重试（带上 requestId 便于报障）
 *   空     → 空态 + 引导动作
 *   有数据 → 正常渲染
 *
 * 排序策略：
 *   - 传了 onSortChange（服务端排序）时，只回调事件，排序由后端完成；
 *   - 没传时退化为客户端排序，用于选项总量小的场景（如标签列表）。
 *   两种模式不能混用，否则会出现"点了排序只排了当前页"的迷惑行为。
 */

export type Align = 'left' | 'center' | 'right';

export interface Column<T> {
  key: string;
  title: ReactNode;
  /** 单元格渲染；缺省时按 dataIndex 取原始值 */
  render?: (row: T, index: number) => ReactNode;
  /** 缺省取值的字段名；金额/日期列建议直接用 render，避免拿到原始字符串 */
  dataIndex?: keyof T & string;
  width?: number | string;
  minWidth?: number | string;
  align?: Align;
  /** 是否可排序（服务端字段名用 sortKey 指定） */
  sortable?: boolean;
  sortKey?: string;
  /** 该列是否需要权限才展示明文（如手机号）；由调用方决定渲染内容 */
  sensitive?: boolean;
  ellipsis?: boolean;
  /** 表头补充说明，鼠标悬停展示 */
  tooltip?: string;
}

export interface DataTableProps<T> {
  columns: Array<Column<T>>;
  rows: T[];
  /** 行主键：必须稳定，避免勾选状态错位 */
  rowKey: (row: T) => string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  errorRequestId?: string | null;
  emptyTitle?: string;
  emptyDescription?: ReactNode;
  emptyAction?: ReactNode;
  /** 服务端排序回调；不传则启用客户端排序 */
  onSortChange?: (payload: SortPayload) => void;
  /** 当前排序状态（受控） */
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  /** 行点击（查看详情） */
  onRowClick?: (row: T) => void;
  /** 行样式钩子，如逾期结算标红 */
  rowClassName?: (row: T) => string;
  /** 勾选列配置 */
  selectable?: boolean;
  selectedKeys?: string[];
  onSelectionChange?: (keys: string[]) => void;
  /** 分页信息；total 为 undefined 时不渲染分页 */
  page?: number;
  pageSize?: number;
  total?: number;
  totalPages?: number;
  onPageChange?: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  pageSizeOptions?: number[];
  /** 表格底部左侧的汇总/说明 */
  footer?: ReactNode;
  /** 骨架屏行数 */
  skeletonRows?: number;
  /** 粘性表头（长列表滚动时保留列名） */
  stickyHeader?: boolean;
  className?: string;
}

/** 客户端排序的比较函数：数字按数值比，其余按中文本地化字符串比 */
function compareValues(a: unknown, b: unknown): number {
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1;
  return String(a).localeCompare(String(b), 'zh-CN', { numeric: true });
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  error = null,
  onRetry,
  errorRequestId,
  emptyTitle,
  emptyDescription,
  emptyAction,
  onSortChange,
  sortBy,
  sortOrder = 'desc',
  onRowClick,
  rowClassName,
  selectable = false,
  selectedKeys = [],
  onSelectionChange,
  page = 1,
  pageSize = 20,
  total,
  totalPages,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions,
  footer,
  skeletonRows = 8,
  stickyHeader = false,
  className,
}: DataTableProps<T>) {
  const clientSortEnabled = !onSortChange;
  // 客户端排序模式下表格自带一份排序状态（受控场景由父级通过 props 传入）
  const [internalSort, setInternalSort] = useState<SortPayload | null>(null);

  /** 当前生效的排序：受控优先，其次内部状态 */
  const effectiveSortBy = onSortChange ? sortBy : (internalSort?.sortBy ?? sortBy);
  const effectiveSortOrder = onSortChange ? sortOrder : (internalSort?.sortOrder ?? sortOrder);

  const sortedRows = useMemo(() => {
    if (!clientSortEnabled || !effectiveSortBy) return rows;
    // sortKey 用于服务端字段名（可能与列 key 不同），两处都要匹配
    const column = columns.find(
      (item) => (item.sortKey ?? item.key) === effectiveSortBy,
    );
    if (!column?.dataIndex) return rows;

    const dataIndex = column.dataIndex;
    const sorted = [...rows].sort((left, right) =>
      compareValues(left[dataIndex], right[dataIndex]),
    );
    return effectiveSortOrder === 'asc' ? sorted : sorted.reverse();
    // columns 是每次渲染新建的数组，不能进依赖；排序只依赖排序键变化与行数据
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, effectiveSortBy, effectiveSortOrder, clientSortEnabled]);

  const allSelected = selectable && sortedRows.length > 0 && sortedRows.every((row) => selectedKeys.includes(rowKey(row)));
  const someSelected = selectable && !allSelected && sortedRows.some((row) => selectedKeys.includes(rowKey(row)));

  const toggleAll = () => {
    if (!onSelectionChange) return;
    if (allSelected) {
      // 只移除当前页的 key，避免影响其他页已选中的行（跨页批量操作场景）
      const currentKeys = new Set(sortedRows.map(rowKey));
      onSelectionChange(selectedKeys.filter((key) => !currentKeys.has(key)));
      return;
    }
    const merged = new Set(selectedKeys);
    sortedRows.forEach((row) => merged.add(rowKey(row)));
    onSelectionChange([...merged]);
  };

  const toggleOne = (key: string) => {
    if (!onSelectionChange) return;
    if (selectedKeys.includes(key)) {
      onSelectionChange(selectedKeys.filter((item) => item !== key));
      return;
    }
    onSelectionChange([...selectedKeys, key]);
  };

  const handleSort = (column: Column<T>) => {
    if (!column.sortable) return;
    const key = column.sortKey ?? column.key;
    // 同一列在 asc/desc 之间切换；换列时默认降序（后台更常看"最新/最大"）
    const nextOrder: 'asc' | 'desc' =
      effectiveSortBy === key && effectiveSortOrder === 'desc' ? 'asc' : 'desc';

    if (onSortChange) {
      onSortChange({ sortBy: key, sortOrder: nextOrder });
      return;
    }
    setInternalSort({ sortBy: key, sortOrder: nextOrder });
  };

  if (error) {
    return (
      <div className={`card ${className ?? ''}`}>
        <ErrorState message={error} onRetry={onRetry} requestId={errorRequestId} />
      </div>
    );
  }

  if (loading) {
    return (
      <div className={`card ${className ?? ''}`} style={{ padding: 'var(--space-3)' }}>
        <LoadingSkeleton rows={skeletonRows} columns={Math.min(columns.length, 7)} />
      </div>
    );
  }

  if (sortedRows.length === 0) {
    return (
      <div className={`card ${className ?? ''}`}>
        <EmptyState
          title={emptyTitle ?? '没有符合条件的数据'}
          description={emptyDescription ?? '试试放宽筛选条件，或清空关键词后重新查询'}
          action={emptyAction}
        />
      </div>
    );
  }

  const showPagination = total !== undefined && onPageChange;

  return (
    <div className={`card ${className ?? ''}`}>
      <div className="tableWrap">
        <table className={`table ${stickyHeader ? styles.sticky : ''}`}>
          <thead>
            <tr>
              {selectable && (
                <th style={{ width: 44 }}>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(node) => {
                      // indeterminate 只能用 DOM 属性设置，React 没有对应 prop
                      if (node) node.indeterminate = someSelected;
                    }}
                    onChange={toggleAll}
                    aria-label="全选当前页"
                  />
                </th>
              )}
              {columns.map((column) => {
                const key = column.sortKey ?? column.key;
                const active = effectiveSortBy === key;
                const ariaSort = active
                  ? effectiveSortOrder === 'asc'
                    ? 'ascending'
                    : 'descending'
                  : undefined;
                return (
                  <th
                    key={column.key}
                    aria-sort={ariaSort}
                    title={column.tooltip}
                    style={{
                      width: column.width,
                      minWidth: column.minWidth,
                      textAlign: column.align ?? 'left',
                    }}
                  >
                    {column.sortable ? (
                      <button
                        type="button"
                        className={`${styles.sortButton} ${active ? styles.sortActive : ''}`}
                        onClick={() => handleSort(column)}
                      >
                        {column.title}
                        <span className={styles.sortIcon} aria-hidden="true">
                          {active ? (effectiveSortOrder === 'asc' ? '↑' : '↓') : '↕'}
                        </span>
                      </button>
                    ) : (
                      column.title
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row, index) => {
              const key = rowKey(row);
              const extraClass = rowClassName?.(row) ?? '';
              return (
                <tr
                  key={key}
                  className={extraClass}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  style={onRowClick ? { cursor: 'pointer' } : undefined}
                >
                  {selectable && (
                    <td onClick={(event) => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedKeys.includes(key)}
                        onChange={() => toggleOne(key)}
                        aria-label="选择该行"
                      />
                    </td>
                  )}
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      style={{ textAlign: column.align ?? 'left' }}
                      className={column.ellipsis ? 'ellipsis' : undefined}
                    >
                      {column.render
                        ? column.render(row, index)
                        : column.dataIndex
                          ? ((row[column.dataIndex] as ReactNode) ?? '—')
                          : '—'}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {(showPagination || footer) && (
        <div className={styles.footer}>
          <div className={styles.footerLeft}>{footer}</div>
          {showPagination && (
            <Pagination
              page={page}
              pageSize={pageSize}
              total={total ?? 0}
              totalPages={totalPages ?? Math.max(1, Math.ceil((total ?? 0) / pageSize))}
              onPageChange={onPageChange}
              onPageSizeChange={onPageSizeChange}
              pageSizeOptions={pageSizeOptions}
            />
          )}
        </div>
      )}
    </div>
  );
}
