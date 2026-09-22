import styles from './MoneyText.module.css';
import { formatMoney, formatMoneyCompact, isNegativeMoney } from '@/utils/format';
import { LARGE_AMOUNT_THRESHOLD_YUAN } from '@/utils/constants';

/**
 * 金额展示组件。
 *
 * 后台对账场景的三个硬性要求，这个组件一次性满足：
 *   1) 等宽字体 + 右对齐 + 两位小数 + 千分位 —— 只有等宽才能纵向比较"位数对不对"；
 *   2) 空值显示占位符而不是 0.00 —— "没有金额"和"金额为 0"是两件不同的事；
 *   3) 大额高亮 —— 财务需要在长列表里秒级定位大额单。
 *
 * 组件只接受后端返回的字符串元，内部不做任何运算（除格式化），
 * 因此不会出现"前端四舍五入后与结算单不一致"的问题。
 */

export interface MoneyTextProps {
  value: string | number | null | undefined;
  /** yuan：带 ¥ 前缀；plain：纯数字（表格列已有"金额（元）"表头时用） */
  variant?: 'yuan' | 'plain' | 'compact';
  /** 强制显示正负号，用于调整金额等有方向的字段 */
  signed?: boolean;
  /** 超过阈值时高亮；默认使用全局阈值 */
  highlightThreshold?: number;
  /** 弱化展示（次要列） */
  muted?: boolean;
  placeholder?: string;
  className?: string;
  title?: string;
}

export function MoneyText({
  value,
  variant = 'yuan',
  signed = false,
  highlightThreshold = LARGE_AMOUNT_THRESHOLD_YUAN,
  muted = false,
  placeholder = '—',
  className,
  title,
}: MoneyTextProps) {
  const text =
    variant === 'compact' ? formatMoneyCompact(value, placeholder) : formatMoney(value, placeholder);

  if (text === placeholder) {
    return (
      <span className={`${styles.money} ${styles.placeholder} ${className ?? ''}`}>{placeholder}</span>
    );
  }

  const numeric = Number(value);
  const negative = isNegativeMoney(value);
  const large = !negative && Math.abs(numeric) >= highlightThreshold;
  const prefix = variant === 'yuan' ? '¥' : '';
  const sign = signed && numeric > 0 ? '+' : '';

  const classNames = [
    styles.money,
    negative ? styles.negative : '',
    large ? styles.large : '',
    muted ? styles.muted : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span
      className={classNames}
      title={title ?? `${prefix}${text}`}
      // 高亮原因对读屏用户不可见，用 title 之外再补一层语义说明
      data-large={large ? 'true' : undefined}
    >
      {sign}
      {prefix}
      {text}
    </span>
  );
}

/** 比率展示：基点整数 → 百分数，等宽且右对齐，与金额列排在一起不会错位 */
export function BpText({ bp, className }: { bp: number | null | undefined; className?: string }) {
  if (bp === null || bp === undefined || Number.isNaN(bp)) {
    return <span className={`${styles.money} ${styles.placeholder} ${className ?? ''}`}>—</span>;
  }
  return <span className={`${styles.money} ${className ?? ''}`}>{(bp / 100).toFixed(2)}%</span>;
}
