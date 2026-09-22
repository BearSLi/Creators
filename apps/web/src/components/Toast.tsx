import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import styles from './Toast.module.css';

/**
 * 轻量 Toast。
 *
 * 为什么不用第三方库：需求只有"成功/失败/警告 + 自动消失"，自己实现 120 行，
 * 还能顺手把「业务提示必须成对出现」的约定固化下来——例如审批成功后固定提示
 * 「已写入审计日志」，这个文案统一在这里提供，避免各页面写法不一致。
 */

export type ToastTone = 'success' | 'error' | 'warning' | 'info';

export interface ToastOptions {
  tone?: ToastTone;
  /** 毫秒；0 表示不自动关闭（用于需要用户读完的错误详情） */
  duration?: number;
}

interface ToastItem {
  id: string;
  tone: ToastTone;
  message: string;
  duration: number;
}

interface ToastContextValue {
  push: (message: string, options?: ToastOptions) => string;
  success: (message: string, options?: Omit<ToastOptions, 'tone'>) => string;
  error: (message: string, options?: Omit<ToastOptions, 'tone'>) => string;
  warning: (message: string, options?: Omit<ToastOptions, 'tone'>) => string;
  info: (message: string, options?: Omit<ToastOptions, 'tone'>) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TONE_DURATION: Record<ToastTone, number> = {
  success: 2600,
  info: 3000,
  warning: 4000,
  // 错误停留更久：用户往往需要读完并决定下一步（如整理权限申请）
  error: 6000,
};

/**
 * 资金/权限类操作成功后的统一提示。
 * 放在这里而不是各页面：审计留痕是平台级约定，文案必须一致，否则法务对不上口径。
 */
export const AUDIT_WRITTEN_HINT = '已写入审计日志';

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timersRef = useRef<Map<string, number>>(new Map());
  const idRef = useRef(0);

  const dismiss = useCallback((id: string) => {
    setItems((prev) => prev.filter((item) => item.id !== id));
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (message: string, options: ToastOptions = {}): string => {
      const tone = options.tone ?? 'info';
      idRef.current += 1;
      const id = `toast-${idRef.current}`;
      const duration = options.duration ?? TONE_DURATION[tone];

      setItems((prev) => {
        // 同样的消息短时间内重复出现（用户连点）只保留一条，避免刷屏
        const deduped = prev.filter((item) => item.message !== message || item.tone !== tone);
        // 最多同时展示 4 条，超出丢弃最旧的
        return [...deduped, { id, tone, message, duration }].slice(-4);
      });

      if (duration > 0) {
        const timer = window.setTimeout(() => dismiss(id), duration);
        timersRef.current.set(id, timer);
      }
      return id;
    },
    [dismiss],
  );

  // 卸载时清理所有定时器，避免"组件已卸载仍 setState"的告警
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({
      push,
      dismiss,
      success: (message, options) => push(message, { ...options, tone: 'success' }),
      error: (message, options) => push(message, { ...options, tone: 'error' }),
      warning: (message, options) => push(message, { ...options, tone: 'warning' }),
      info: (message, options) => push(message, { ...options, tone: 'info' }),
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* aria-live=polite：屏幕阅读器会播报但不打断当前朗读 */}
      <div className={styles.viewport} role="status" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={`${styles.toast} ${styles[item.tone]}`}>
            <span className={styles.icon} aria-hidden="true">
              {item.tone === 'success' ? '✓' : item.tone === 'error' ? '!' : item.tone === 'warning' ? '⚠' : 'i'}
            </span>
            <span className={styles.message}>{item.message}</span>
            <button
              type="button"
              className={styles.close}
              onClick={() => dismiss(item.id)}
              aria-label="关闭提示"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast 必须在 <ToastProvider> 内使用');
  }
  return context;
}
