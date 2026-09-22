import type { CSSProperties, ReactNode } from 'react';
import styles from './StatusTag.module.css';

/**
 * 状态标签。
 *
 * 所有状态（达人/合同/项目/内容/结算/审批）共用一套 tone 色板，
 * 这样"绿色=好、橙色=待处理、红色=异常"在整个系统里语义一致，
 * 用户不需要针对每个页面重新学习颜色含义。
 */

export type StatusTone = 'neutral' | 'info' | 'warning' | 'success' | 'danger' | 'primary';

export interface StatusTagProps {
  children: ReactNode;
  tone?: StatusTone;
  /** 显示前置圆点：用于强调"这是状态而非分类" */
  dot?: boolean;
  /** 自定义颜色（标签体系里颜色由后端下发，如 tag.color） */
  color?: string;
  size?: 'sm' | 'md';
  title?: string;
}

export function StatusTag({
  children,
  tone = 'neutral',
  dot = false,
  color,
  size = 'md',
  title,
}: StatusTagProps) {
  const style: CSSProperties = color
    ? {
        // 业务标签颜色由后端下发十六进制值，用 color-mix 派生浅底，避免再让用户选背景色
        color,
        borderColor: `color-mix(in srgb, ${color} 35%, transparent)`,
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
      }
    : {};

  return (
    <span
      className={`${styles.tag} ${styles[tone]} ${size === 'sm' ? styles.sm : ''}`}
      style={style}
      title={title}
    >
      {dot && <span className={styles.dot} aria-hidden="true" />}
      {children}
    </span>
  );
}

/** 达人等级徽标：S/A/B/C/D 用不同底色，列表里一眼分辨头部达人 */
export function TierTag({ tier }: { tier: string }) {
  const toneMap: Record<string, StatusTone> = {
    S: 'danger',
    A: 'warning',
    B: 'info',
    C: 'neutral',
    D: 'neutral',
  };
  return (
    <StatusTag tone={toneMap[tier] ?? 'neutral'} size="sm" title={`达人分级：${tier} 级`}>
      {tier}
    </StatusTag>
  );
}
