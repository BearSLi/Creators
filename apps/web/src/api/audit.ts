import { api, buildParams } from './client';
import type { AuditLogItem, AuditLogQuery, Paginated } from './types';

/**
 * 审计日志接口。
 *
 * 后端控制器挂在 /audit-logs（见 apps/api 的 AuditController），
 * 支持按人/资源/动作/时间/成功与否过滤，以及某条业务资源的完整操作时间线。
 */

export function listAuditLogs(query: AuditLogQuery = {}): Promise<Paginated<AuditLogItem>> {
  return api.get<Paginated<AuditLogItem>>('/audit-logs', buildParams(query));
}

/** 详情页的「操作记录」时间线：按 resource + id 拉全量变更 */
export function getAuditTimeline(
  resource: string,
  id: string,
  limit = 50,
): Promise<AuditLogItem[]> {
  return api.get<AuditLogItem[]>(
    `/audit-logs/${resource}/${id}/timeline`,
    buildParams({ limit }),
  );
}
