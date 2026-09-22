import { useEffect, useState, type ReactNode } from 'react';
import { Modal } from './Modal';

/**
 * 二次确认对话框。
 *
 * 两种模式：
 *   - 普通确认：danger 动作用红色按钮，文案要求写清后果（"解约后该达人本月不再产生新结算"）；
 *   - 必填原因：requireReason 为 true 时，未填原因不能提交。
 *
 * 为什么会内建"必填原因"：达人解约、拉黑、结算争议等动作后端要求 reason 字段，
 * 前端若各自实现，很容易出现"提交后报 REASON_REQUIRED"这种低级返工。
 */

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  /** 主体说明：必须写清"会发生什么"，而不是只问"确定吗" */
  message: ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  loading?: boolean;
  requireReason?: boolean;
  reasonLabel?: string;
  reasonPlaceholder?: string;
  reasonMinLength?: number;
  onCancel: () => void;
  /** requireReason 时把原因回传；否则 reason 为 undefined */
  onConfirm: (reason?: string) => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmText = '确定',
  cancelText = '取消',
  danger = false,
  loading = false,
  requireReason = false,
  reasonLabel = '操作原因',
  reasonPlaceholder = '请填写原因，将记入审计日志',
  reasonMinLength = 5,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);

  // 每次打开都清空：复用组件时残留上一次的原因会造成误提交
  useEffect(() => {
    if (open) {
      setReason('');
      setTouched(false);
    }
  }, [open]);

  const trimmed = reason.trim();
  const reasonInvalid = requireReason && trimmed.length < reasonMinLength;

  return (
    <Modal
      open={open}
      title={title}
      size="sm"
      onClose={loading ? () => undefined : onCancel}
      footer={
        <>
          <button type="button" className="btn" onClick={onCancel} disabled={loading}>
            {cancelText}
          </button>
          <button
            type="button"
            className={`btn ${danger ? 'btnDanger' : 'btnPrimary'}`}
            disabled={loading || reasonInvalid}
            onClick={() => {
              setTouched(true);
              if (reasonInvalid) return;
              onConfirm(requireReason ? trimmed : undefined);
            }}
          >
            {loading && <span className="spinner" aria-hidden="true" />}
            {confirmText}
          </button>
        </>
      }
    >
      <div style={{ fontSize: 'var(--font-size-sm)', lineHeight: 'var(--line-height-loose)' }}>
        {message}
      </div>

      {requireReason && (
        <div className="field" style={{ marginTop: 'var(--space-4)' }}>
          <label className="label labelRequired" htmlFor="confirm-reason">
            {reasonLabel}
          </label>
          <textarea
            id="confirm-reason"
            className={`textarea ${touched && reasonInvalid ? 'inputError' : ''}`}
            value={reason}
            placeholder={reasonPlaceholder}
            onChange={(event) => setReason(event.target.value)}
            onBlur={() => setTouched(true)}
            rows={3}
          />
          <span className={touched && reasonInvalid ? 'errorText' : 'hint'}>
            至少 {reasonMinLength} 个字，当前 {trimmed.length} 字。原因会写入审计日志，便于后续追溯。
          </span>
        </div>
      )}
    </Modal>
  );
}
