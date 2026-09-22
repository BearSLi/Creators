import type { ReactNode } from 'react';
import { Overlay } from './overlay';
import styles from './Modal.module.css';

/**
 * 模态框。
 *
 * 约定：
 *   - 危险动作（解约、作废结算）不要用 Modal 的默认关闭行为掩盖后果，
 *     应配合 ConfirmDialog 或在 footer 里放明确的红色按钮；
 *   - footer 里的提交按钮必须支持 loading（见传参），后台系统里"点了没反应"
 *     会被用户重复点击，是造成重复建单的主要原因。
 */

export interface ModalProps {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** 数据录入中的弹窗禁止点遮罩关闭，避免误触丢失已填内容 */
  closeOnMaskClick?: boolean;
}

export function Modal({
  open,
  title,
  description,
  children,
  footer,
  onClose,
  size = 'md',
  closeOnMaskClick = false,
}: ModalProps) {
  const sizeClass = size === 'md' ? '' : styles[size];

  return (
    <Overlay
      open={open}
      onClose={onClose}
      className={styles.root}
      maskClassName={styles.mask}
      closeOnMaskClick={closeOnMaskClick}
      ariaLabel={typeof title === 'string' ? title : undefined}
    >
      <div className={`${styles.dialog} ${sizeClass}`}>
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
