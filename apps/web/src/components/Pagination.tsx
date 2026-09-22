import styles from './Pagination.module.css';
import { formatInteger } from '@/utils/format';
import { PAGE_SIZE_OPTIONS } from '@/utils/constants';

/**
 * 分页器。
 *
 * 交互细节（都是从真实后台使用习惯里来的）：
 *   - 页码按钮用"首页/上一页/页码/下一页/末页"，数据量大时用户更依赖跳页；
 *   - 提供"每页条数"选择，对账时用户常切成 100 条一次看完；
 *   - 总数与"当前第 x-y 条"必须显示，用户才能判断是否漏看。
 */

export interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  pageSizeOptions?: number[];
}

/** 生成页码窗口：当前页附近 2 页，首尾保留，中间用省略号 */
function buildPageItems(page: number, totalPages: number): Array<number | 'gap'> {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  const items: Array<number | 'gap'> = [1];
  const start = Math.max(2, page - 1);
  const end = Math.min(totalPages - 1, page + 1);

  if (start > 2) items.push('gap');
  for (let current = start; current <= end; current += 1) items.push(current);
  if (end < totalPages - 1) items.push('gap');
  items.push(totalPages);

  return items;
}

export function Pagination({
  page,
  pageSize,
  total,
  totalPages,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = PAGE_SIZE_OPTIONS,
}: PaginationProps) {
  const safeTotalPages = Math.max(1, totalPages);
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <div className={styles.root}>
      <span className={styles.summary}>
        共 <strong>{formatInteger(total)}</strong> 条
        {total > 0 && ` · 当前 ${from}-${to}`}
      </span>

      {onPageSizeChange && (
        <label className={styles.pageSize}>
          每页
          <select
            className="select"
            value={pageSize}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
          >
            {pageSizeOptions.map((option) => (
              <option key={option} value={option}>
                {option} 条
              </option>
            ))}
          </select>
        </label>
      )}

      <nav className={styles.pager} aria-label="分页导航">
        <button
          type="button"
          className={styles.pageButton}
          disabled={page <= 1}
          onClick={() => onPageChange(1)}
        >
          首页
        </button>
        <button
          type="button"
          className={styles.pageButton}
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          上一页
        </button>

        {buildPageItems(page, safeTotalPages).map((item, index) =>
          item === 'gap' ? (
            <span key={`gap-${index}`} className={styles.gap}>
              …
            </span>
          ) : (
            <button
              key={item}
              type="button"
              className={`${styles.pageButton} ${item === page ? styles.pageActive : ''}`}
              aria-current={item === page ? 'page' : undefined}
              onClick={() => onPageChange(item)}
            >
              {item}
            </button>
          ),
        )}

        <button
          type="button"
          className={styles.pageButton}
          disabled={page >= safeTotalPages}
          onClick={() => onPageChange(page + 1)}
        >
          下一页
        </button>
        <button
          type="button"
          className={styles.pageButton}
          disabled={page >= safeTotalPages}
          onClick={() => onPageChange(safeTotalPages)}
        >
          末页
        </button>
      </nav>
    </div>
  );
}
