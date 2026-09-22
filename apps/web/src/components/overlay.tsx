import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useDebouncedCallback } from '@/hooks/useDebounce';

/**
 * 浮层基础能力：Esc 关闭 + body 锁滚动。
 *
 * 抽出来的原因：Modal / Drawer / ConfirmDialog 三个组件都要这套逻辑，
 * 而且 body 锁滚动必须成对加解（打开时 overflow:hidden，关闭或卸载时还原），
 * 复制三份必然出现"某个弹窗关闭后页面滚不动了"的经典 bug。
 */
export function useOverlayBehavior(open: boolean, onClose: (() => void) | undefined): void {
  // Esc 关闭做 80ms 防抖：避免用户连按 Esc 或与输入框的 Esc 冲突导致重复关闭
  const handleEsc = useDebouncedCallback(() => onClose?.(), 80);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        handleEsc();
      }
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, handleEsc]);
}

/** 统一的浮层容器：负责 portal 与遮罩点击关闭 */
export function Overlay({
  open,
  onClose,
  children,
  className,
  maskClassName,
  closeOnMaskClick = true,
  ariaLabel,
}: {
  open: boolean;
  onClose?: () => void;
  children: ReactNode;
  /** 定位容器类名（由各浮层提供） */
  className: string;
  /** 遮罩类名（由各浮层提供，保证遮罩层级与 z-index 落在同一 CSS Module 作用域内） */
  maskClassName: string;
  closeOnMaskClick?: boolean;
  ariaLabel?: string;
}) {
  useOverlayBehavior(open, onClose);

  if (!open) return null;

  return createPortal(
    <div className={className} role="presentation">
      {/* 遮罩单独成层：点击遮罩关闭是用户肌肉记忆，但点击弹窗内部绝不能关 */}
      <div
        className={maskClassName}
        role="presentation"
        onClick={closeOnMaskClick ? onClose : undefined}
      />
      <div role="dialog" aria-modal="true" aria-label={ariaLabel}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
