import { SetMetadata } from '@nestjs/common';
import type { Request } from 'express';

export const AUDIT_META_KEY = 'creatorops:audit';

export type AuditAction =
  | 'CREATE'
  | 'UPDATE'
  | 'DELETE'
  | 'LOGIN'
  | 'LOGOUT'
  | 'EXPORT'
  | 'IMPORT'
  | 'APPROVE'
  | 'REJECT'
  | 'PUBLISH'
  | 'PAY'
  | 'GENERATE'
  | 'SYNC'
  | 'AI_INVOKE';

export interface AuditMeta {
  /** 动作类型 */
  action: AuditAction;
  /** 资源类型，建议用表名（creator / contract / settlement） */
  resource: string;
  /** 摘要，写进审计日志便于人读 */
  summary?: string;
  /** 是否记录请求体（默认记录，敏感字段会被脱敏） */
  captureBody?: boolean;
  /** 自定义资源 ID 提取，默认取 path 参数 :id 或响应体 id */
  resourceIdFrom?: (request: Request, result: unknown) => string | null;
}

/**
 * 声明式审计埋点。用在 Controller 的写操作方法上。
 *
 * 例：
 *   @Audit({ action: 'APPROVE', resource: 'contract', summary: '审批达人合同' })
 *   approve(@Param('id') id: string) { ... }
 */
export const Audit = (meta: AuditMeta) => SetMetadata(AUDIT_META_KEY, meta);
