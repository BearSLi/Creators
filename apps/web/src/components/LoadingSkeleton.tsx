import styles from './LoadingSkeleton.module.css';

/**
 * 骨架屏。
 *
 * 为什么不用转圈 loading：
 *   1) 骨架能预示最终布局，用户心理等待时间更短，也不会因为内容出现导致布局跳动；
 *   2) 后台列表页的"列宽"是信息的一部分，骨架先把列宽撑住，加载完成后视觉更稳。
 */

export interface LoadingSkeletonProps {
  /** 骨架行数；表格场景一般给 8~10 行填满首屏 */
  rows?: number;
  /** 列数：与真实表格列数接近才有"预示布局"的效果 */
  columns?: number;
  /** 是否渲染表头占位 */
  header?: boolean;
  variant?: 'table' | 'list' | 'card' | 'text';
  className?: string;
}

export function LoadingSkeleton({
  rows = 8,
  columns = 5,
  header = true,
  variant = 'table',
  className,
}: LoadingSkeletonProps) {
  if (variant === 'text') {
    return (
      <div className={className}>
        {Array.from({ length: rows }).map((_, index) => (
          <span
            key={index}
            className="skeleton"
            style={{
              width: `${100 - (index % 3) * 12}%`,
              marginBottom: 'var(--space-2)',
            }}
          />
        ))}
      </div>
    );
  }

  if (variant === 'card') {
    return (
      <div className={`${styles.cardGrid} ${className ?? ''}`}>
        {Array.from({ length: rows }).map((_, index) => (
          <div key={index} className={styles.card}>
            <span className="skeleton" style={{ width: '45%', height: 12 }} />
            <span className="skeleton" style={{ width: '70%', height: 22, marginTop: 'var(--space-3)' }} />
            <span className="skeleton" style={{ width: '35%', height: 10, marginTop: 'var(--space-2)' }} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className={`${styles.wrap} ${className ?? ''}`}>
      {header && (
        <div className={styles.row} style={{ background: 'var(--color-bg-subtle)' }}>
          {Array.from({ length: columns }).map((_, index) => (
            <div key={index} className={styles.cell}>
              <span className="skeleton" style={{ width: index === 0 ? '60%' : '40%' }} />
            </div>
          ))}
        </div>
      )}
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div key={rowIndex} className={styles.row}>
          {Array.from({ length: columns }).map((_, cellIndex) => (
            <div key={cellIndex} className={styles.cell}>
              {/* 宽度错落：完全等宽会像"加载条"而不是"表格内容" */}
              <span
                className="skeleton"
                style={{ width: `${[70, 45, 60, 35, 55, 40][(rowIndex + cellIndex) % 6]}%` }}
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** 详情页通用骨架：顶部标题 + 若干描述项 */
export function DetailSkeleton() {
  return (
    <div className="card">
      <div className="cardBody">
        <span className="skeleton" style={{ width: 220, height: 18 }} />
        <div style={{ marginTop: 'var(--space-5)' }} className="descriptions">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className="descriptionsItem">
              <span className="skeleton" style={{ width: 72 }} />
              <span className="skeleton" style={{ width: '55%' }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
