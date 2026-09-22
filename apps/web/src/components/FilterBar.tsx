import type { ReactNode } from 'react';
import { useDebouncedCallback } from '@/hooks/useDebounce';
import { formatInteger } from '@/utils/format';
import styles from './FilterBar.module.css';

/**
 * 筛选栏。
 *
 * 后台列表页的筛选有两个反复出现的问题，这个组件针对性解决：
 *   1) 关键词逐字触发请求 → 这里内建 350ms 防抖，页面只管接收值；
 *   2) 多选状态（达人状态、合同状态）用原生 multiple 下拉很难用 →
 *      统一改用 chip 组，点一下切换，当前选中一眼可见。
 *
 * 布局用 flex-wrap：筛选条件多时自动换行，不需要为每个页面单独调样式。
 */

export interface SelectOption {
  value: string;
  label: string;
}

export type FilterField =
  | {
      type: 'keyword';
      key: string;
      label?: string;
      placeholder?: string;
      value: string;
      onChange: (value: string) => void;
      /** 防抖时长，默认 350ms */
      debounce?: number;
    }
  | {
      type: 'select';
      key: string;
      label: string;
      value: string;
      options: SelectOption[];
      onChange: (value: string) => void;
      /** 允许清空（默认第一项为"全部"） */
      placeholder?: string;
    }
  | {
      type: 'multi';
      key: string;
      label: string;
      value: string[];
      options: SelectOption[];
      onChange: (value: string[]) => void;
    }
  | {
      type: 'date';
      key: string;
      label: string;
      value: string;
      onChange: (value: string) => void;
      max?: string;
      min?: string;
    }
  | {
      type: 'number';
      key: string;
      label: string;
      value: string;
      placeholder?: string;
      onChange: (value: string) => void;
      width?: number;
    }
  | {
      type: 'custom';
      key: string;
      label?: string;
      render: () => ReactNode;
    };

export interface FilterBarProps {
  fields: FilterField[];
  /** 右侧额外按钮区（导出、批量操作） */
  actions?: ReactNode;
  /** 是否显示"重置"；传 onReset 才显示 */
  onReset?: () => void;
  /** 展示当前筛选命中数，让用户确认筛选是否生效 */
  resultCount?: number;
}

export function FilterBar({ fields, actions, onReset, resultCount }: FilterBarProps) {
  return (
    <div className={`card ${styles.root}`}>
      <div className={styles.fields}>
        {fields.map((field) => (
          <FilterFieldView key={field.key} field={field} />
        ))}
      </div>

      <div className={styles.footer}>
        <div className={styles.resultHint}>
          {resultCount !== undefined && (
            <>
              已筛选出 <strong>{formatInteger(resultCount)}</strong> 条记录
            </>
          )}
        </div>
        <div className={styles.actions}>
          {onReset && (
            <button type="button" className="btn btnGhost" onClick={onReset}>
              重置筛选
            </button>
          )}
          {actions}
        </div>
      </div>
    </div>
  );
}

function FilterFieldView({ field }: { field: FilterField }) {
  if (field.type === 'keyword') {
    return <KeywordField field={field} />;
  }

  if (field.type === 'custom') {
    return (
      <div className={styles.field}>
        {field.label && <span className={styles.label}>{field.label}</span>}
        {field.render()}
      </div>
    );
  }

  if (field.type === 'select') {
    return (
      <div className={styles.field}>
        <span className={styles.label}>{field.label}</span>
        <select
          className={`select ${styles.control}`}
          value={field.value}
          onChange={(event) => field.onChange(event.target.value)}
        >
          <option value="">{field.placeholder ?? '全部'}</option>
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (field.type === 'number') {
    return (
      <div className={styles.field}>
        <span className={styles.label}>{field.label}</span>
        <input
          type="number"
          className={`input ${styles.control}`}
          style={{ width: field.width ?? 120 }}
          value={field.value}
          placeholder={field.placeholder}
          onChange={(event) => field.onChange(event.target.value)}
        />
      </div>
    );
  }

  if (field.type === 'date') {
    return (
      <div className={styles.field}>
        <span className={styles.label}>{field.label}</span>
        <input
          type="date"
          className={`input ${styles.control}`}
          style={{ width: 150 }}
          value={field.value}
          min={field.min}
          max={field.max}
          onChange={(event) => field.onChange(event.target.value)}
        />
      </div>
    );
  }

  // 多选 chip 组：不使用折叠，全量展示 + flex-wrap 换行
  return (
    <div className={`${styles.field} ${styles.fieldWide}`}>
      <span className={styles.label}>{field.label}</span>
      <div className="chipGroup">
        {field.options.map((option) => {
          const active = field.value.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              className={`chip ${active ? 'chipActive' : ''}`}
              aria-pressed={active}
              onClick={() => {
                field.onChange(
                  active
                    ? field.value.filter((item) => item !== option.value)
                    : [...field.value, option.value],
                );
              }}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 关键词输入：内部维护即时值，防抖后才向上抛，避免每个字符都触发请求 */
function KeywordField({
  field,
}: {
  field: Extract<FilterField, { type: 'keyword' }>;
}) {
  // 用受控 + 防抖回调：输入框手感即时，请求节流
  const debouncedChange = useDebouncedCallback((next: string) => field.onChange(next), field.debounce ?? 350);

  return (
    <div className={styles.field}>
      {field.label && <span className={styles.label}>{field.label}</span>}
      <div className={styles.searchWrap}>
        <span className={styles.searchIcon} aria-hidden="true">
          ⌕
        </span>
        <input
          type="search"
          className={`input ${styles.control} ${styles.search}`}
          defaultValue={field.value}
          placeholder={field.placeholder ?? '搜索关键词'}
          onChange={(event) => debouncedChange(event.target.value)}
        />
      </div>
    </div>
  );
}
