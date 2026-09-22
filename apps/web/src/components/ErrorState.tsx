import styles from './EmptyState.module.css';

/**
 * 错误态（从 EmptyState.tsx 拆出独立入口，方便页面按需引入且不产生循环依赖）。
 *
 * 与空态的差别：错误态必须给"重试"按钮与可读原因，否则用户只能刷新页面，
 * 而刷新往往会重放同一个失败请求，体验更差。
 */

export interface ErrorStateProps {
  title?: string;
  /** 已由 resolveErrorMessage 转换过的中文原因 */
  message: string;
  onRetry?: () => void;
  /** 后端 requestId：用户报障时运维能直接按编号捞日志 */
  requestId?: string | null;
  compact?: boolean;
}

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

export default ErrorState;
