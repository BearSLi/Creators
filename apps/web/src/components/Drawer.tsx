import type { ReactNode } from 'react';
import { Overlay } from './overlay';
import styles from './Drawer.module.css';

/**
 * 抽屉。
 *
 * 与 Modal 的分工：Modal 用于"必须打断用户的决策"（确认、审批意见），
 * 抽屉用于"在当前上下文里补充查看/快速编辑"——用户能一边看列表一边看详情，
 * 这是后台系统里高频的对照场景（比如比对两个达人的数据）。
 */

export interface DrawerProps {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  /** wide 用于内容较多的详情预览（审计 diff、计算链路） */
  size?: 'md' | 'wide';
  closeOnMaskClick?: boolean;
}

export function Drawer({
  open,
  title,
  description,
  children,
  footer,
  onClose,
  size = 'md',
  closeOnMaskClick = true,
}: DrawerProps) {
  return (
    <Overlay
      open={open}
      onClose={onClose}
      className={styles.root}
      maskClassName={styles.mask}
      closeOnMaskClick={closeOnMaskClick}
      ariaLabel={typeof title === 'string' ? title : undefined}
    >
      <div className={`${styles.panel} ${size === 'wide' ? styles.wide : ''}`}>
        <div className={styles.header}>
          <div>
            <div className={styles.title}>{title}</div>
            {description && <div className={styles.description}>{description}</div>}
          </div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <div className={styles.body}>{children}</div>
        {footer && <div className={styles.footer}>{footer}</div>}
      </div>
    </Overlay>
  );
}
