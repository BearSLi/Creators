import type { ReactNode } from 'react';
import styles from './EmptyState.module.css';

/**
 * 空状态 / 错误状态。
 *
 * 三态原则里的"空"和"错误"必须区分开：
 *   - 空（EmptyState）：请求成功但没有数据。文案要引导下一步动作（"去新建达人"）；
 *   - 错误（ErrorState）：请求失败。必须给"重试"按钮，并把后端错误码映射后的中文原因展示出来，
 *     否则用户只能刷新页面，而刷新往往会重放同一个失败请求。
 */

export interface EmptyStateProps {
  title?: string;
  description?: ReactNode;
  action?: ReactNode;
  /** compact 用于卡片内的局部空态（如某个 Tab 下没有数据） */
  compact?: boolean;
}

export function EmptyState({
  title = '暂无数据',
  description,
  action,
  compact = false,
}: EmptyStateProps) {
  return (
    <div className={`${styles.root} ${compact ? styles.compact : ''}`}>
      <div className={styles.icon} aria-hidden="true">
        {/* 用简单几何图形代替插图，避免引入图片资源与额外体积 */}
        <svg viewBox="0 0 48 48" width="48" height="48" fill="none">
          <rect x="8" y="12" width="32" height="24" rx="3" stroke="currentColor" strokeWidth="1.5" />
          <path d="M8 20h32" stroke="currentColor" strokeWidth="1.5" />
          <path d="M16 28h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </div>
      <div className={styles.title}>{title}</div>
      {description && <div className={styles.description}>{description}</div>}
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}

export interface ErrorStateProps {
  title?: string;
  /** 已由 resolveErrorMessage 转换过的中文原因 */
  message: string;
  onRetry?: () => void;
  /** 展示后端 requestId：用户报障时运维能直接定位日志 */
  requestId?: string | null;
  compact?: boolean;
}

/**
 * 错误态：与 EmptyState 同文件维护，两者共用 .root/.icon/.title 样式，
 * 放在一起能保证"空"和"错"的视觉重量一致（一个太大一个太小会让页面显得碎裂）。
 * 另有独立入口 `@/components/ErrorState`，两种引入方式等价。
 */
export function ErrorState({
  title = '加载失败',
  message,
  onRetry,
  requestId,
  compact = false,
}: ErrorStateProps) {
  return (
    <div className={`${styles.root} ${compact ? styles.compact : ''}`}>
      <div className={`${styles.icon} ${styles.errorIcon}`} aria-hidden="true">
        <svg viewBox="0 0 48 48" width="48" height="48" fill="none">
          <circle cx="24" cy="24" r="15" stroke="currentColor" strokeWidth="1.5" />
          <path d="M24 16v11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="24" cy="32" r="1.4" fill="currentColor" />
        </svg>
      </div>
      <div className={styles.title}>{title}</div>
      <div className={styles.description}>{message}</div>
      {requestId && (
        <div className={styles.requestId}>
          请求编号：<code>{requestId}</code>
        </div>
      )}
      {onRetry && (
        <div className={styles.action}>
          <button type="button" className="btn" onClick={onRetry}>
            重新加载
          </button>
        </div>
      )}
    </div>
  );
}
