import type { ReactNode } from 'react';
import styles from './StatCard.module.css';
import { formatDelta } from '@/utils/format';

/**
 * KPI 卡片。
 *
 * 看板上的数字必须回答两个问题："现在是多少"和"比之前好了还是差了"。
 * 因此 delta 用带符号的百分比 + 箭头 + 颜色三重编码——只给颜色对色盲用户不友好。
 * 「越低越好」的指标（结算待付、异常数）用 invertDelta 反转颜色语义。
 */

export interface StatCardProps {
  label: string;
  value: ReactNode;
  /** 单位：元/人/条，直接跟在数值后的小字 */
  unit?: string;
  /** 环比变化百分比，如 12.5 表示 +12.5% */
  delta?: number | null;
  /** true 表示"数值下降是好事"（如待处理数、逾期数） */
  invertDelta?: boolean;
  hint?: ReactNode;
  /** 图标或色块，用于区分同一行的多张卡 */
  accent?: 'primary' | 'success' | 'warning' | 'danger' | 'info';
  onClick?: () => void;
  loading?: boolean;
}

export function StatCard({
  label,
  value,
  unit,
  delta,
  invertDelta = false,
  hint,
  accent = 'primary',
  onClick,
  loading = false,
}: StatCardProps) {
  const hasDelta = delta !== null && delta !== undefined && !Number.isNaN(delta);
  // 中性区间：±0.05% 以内视为持平，避免把噪声显示成"上涨"
  const flat = hasDelta && Math.abs(delta ?? 0) < 0.05;
  const positive = hasDelta && (invertDelta ? (delta ?? 0) < 0 : (delta ?? 0) > 0);

  const deltaClass = flat ? styles.flat : positive ? styles.up : styles.down;
  const arrow = flat ? '→' : (delta ?? 0) > 0 ? '↑' : '↓';

  return (
    <div
      className={`card ${styles.root} ${onClick ? styles.clickable : ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      <div className={styles.header}>
        <span className={`${styles.accent} ${styles[accent]}`} aria-hidden="true" />
        <span className={styles.label}>{label}</span>
      </div>

      {loading ? (
        <span className="skeleton" style={{ width: '60%', height: 26, marginTop: 'var(--space-3)' }} />
      ) : (
        <div className={styles.valueRow}>
          <span className={styles.value}>{value}</span>
          {unit && <span className={styles.unit}>{unit}</span>}
        </div>
      )}

      <div className={styles.footer}>
        {hasDelta && (
          <span className={`${styles.delta} ${deltaClass}`}>
            <span aria-hidden="true">{arrow}</span>
            {formatDelta(delta)}
          </span>
        )}
        {hint && <span className={styles.hint}>{hint}</span>}
      </div>
    </div>
  );
}
