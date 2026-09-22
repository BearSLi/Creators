import { useCallback, useMemo, useState } from 'react';
import type { SortPayload } from '@/api/types';
import { PAGE_SIZE_OPTIONS } from '@/utils/constants';

/**
 * 列表页查询状态的统一管理。
 *
 * 为什么抽成 Hook：20 个列表页都要"翻页 / 改每页条数 / 改筛选 / 排序 / 重置"，
 * 各写一遍必然出现"改筛选忘了回第一页"这类 bug（用户在第 5 页筛选，结果空列表）。
 * 这里把所有改变结果集的操作都强制回到 page=1。
 */

export interface TableQueryState<F extends Record<string, unknown>> {
  page: number;
  pageSize: number;
  filters: F;
  sortBy?: string;
  sortOrder: 'asc' | 'desc';
}

export interface UseTableQueryOptions<F extends Record<string, unknown>> {
  initialFilters: F;
  initialPageSize?: number;
  initialSort?: SortPayload;
}

/**
 * 查询条件对象的结构：
 *   { ...filters, page, pageSize, sortBy, sortOrder }
 * 即筛选条件被"拍平"到顶层，因此可以直接当作请求参数与 queryKey 使用，
 * 不需要页面里写 `...query.filters`——少一层嵌套就少一类"忘了展开"的 bug。
 *
 * 注意 filters 字段要显式声明为 F：`F & {...}` 这种交叉类型在泛型里可能被
 * 折叠成 Record<string, unknown>，导致页面里 `query.filters.keyword` 推到 unknown。
 */
export type TableQueryParams<F extends Record<string, unknown>> = F & {
  page: number;
  pageSize: number;
  sortBy?: string;
  sortOrder: 'asc' | 'desc';
  /** 原始筛选条件（与顶层字段同值），用于回填表单控件 */
  filters: F;
};

export interface UseTableQueryResult<F extends Record<string, unknown>> {
  /** 可直接作为查询参数与 queryKey 使用（已含 filters 的全部字段） */
  query: TableQueryParams<F>;
  /** 原始筛选条件，用于回填表单控件 */
  filters: F;
  /** 便于类型标注的查询条件类型别名 */
  setPage: (page: number) => void;
  setPageSize: (pageSize: number) => void;
  /** 合并式更新筛选条件（局部字段更新也走这里） */
  setFilters: (patch: Partial<F>) => void;
  /** 整体替换筛选条件，用于"重置"或"载入预设视图" */
  replaceFilters: (next: F) => void;
  reset: () => void;
  setSort: (payload: SortPayload) => void;
  toggleSort: (sortBy: string) => void;
  pageSizeOptions: number[];
}

export function useTableQuery<F extends Record<string, unknown>>(
  options: UseTableQueryOptions<F>,
): UseTableQueryResult<F> {
  const { initialFilters, initialPageSize = 20, initialSort } = options;

  const [page, setPageState] = useState(1);
  const [pageSize, setPageSizeState] = useState(
    PAGE_SIZE_OPTIONS.includes(initialPageSize) ? initialPageSize : PAGE_SIZE_OPTIONS[1],
  );
  const [filters, setFiltersState] = useState<F>(initialFilters);
  const [sortBy, setSortBy] = useState<string | undefined>(initialSort?.sortBy);
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>(initialSort?.sortOrder ?? 'desc');

  const setPage = useCallback((next: number) => {
    setPageState(next < 1 ? 1 : next);
  }, []);

  const setPageSize = useCallback((next: number) => {
    setPageSizeState(next);
    // 每页条数变化会改变总页数，停留在原页码可能越界（第 10 页只有 3 页了）
    setPageState(1);
  }, []);

  const setFilters = useCallback((patch: Partial<F>) => {
    setFiltersState((prev) => ({ ...prev, ...patch }));
    // 筛选条件变了必须回到第一页，否则用户看到的是"筛选后第 5 页"这种空结果
    setPageState(1);
  }, []);

  const replaceFilters = useCallback((next: F) => {
    setFiltersState(next);
    setPageState(1);
  }, []);

  const reset = useCallback(() => {
    setFiltersState(initialFilters);
    setSortBy(initialSort?.sortBy);
    setSortOrder(initialSort?.sortOrder ?? 'desc');
    setPageState(1);
  }, [initialFilters, initialSort?.sortBy, initialSort?.sortOrder]);

  const setSort = useCallback((payload: SortPayload) => {
    setSortBy(payload.sortBy);
    setSortOrder(payload.sortOrder);
    setPageState(1);
  }, []);

  /** 表头点击：同一列在 asc/desc 间切换，换列时默认从降序开始（后台看"最大/最新"更常见） */
  const toggleSort = useCallback(
    (nextSortBy: string) => {
      setSortBy((prevSortBy) => {
        setSortOrder((prevOrder) => (prevSortBy === nextSortBy && prevOrder === 'desc' ? 'asc' : 'desc'));
        return nextSortBy;
      });
      setPageState(1);
    },
    [],
  );

  const query = useMemo<TableQueryParams<F>>(
    // 分页/排序字段放最后：即使筛选条件里意外出现同名字段，也以分页器状态为准
    () => ({ ...filters, page, pageSize, sortBy, sortOrder, filters }),
    [filters, page, pageSize, sortBy, sortOrder],
  );

  return {
    query,
    filters,
    setPage,
    setPageSize,
    setFilters,
    replaceFilters,
    reset,
    setSort,
    toggleSort,
    pageSizeOptions: PAGE_SIZE_OPTIONS,
  };
}
