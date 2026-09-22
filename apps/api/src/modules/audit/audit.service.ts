import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { buildPaginated, PaginatedResult } from '../../common/utils/pagination';

export interface AuditRecordInput {
  userId: string | null;
  userName: string | null;
  action: string;
  resource: string;
  resourceId: string | null;
  summary: string;
  before?: unknown;
  after?: unknown;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  durationMs: number;
  success: boolean;
  errorMessage: string | null;
}

export interface AuditQuery {
  page: number;
  pageSize: number;
  userId?: string;
  resource?: string;
  resourceId?: string;
  action?: string;
  success?: boolean;
  from?: Date;
  to?: Date;
}

/**
 * 审计服务。
 *
 * 写入策略：审计是旁路——写失败只记应用日志，绝不回滚业务事务。
 * 代价是可能丢极少量审计记录，但换来的是「审计表锁/抖动不会导致业务不可用」。
 * 若合规要求 100% 不丢，应改为写 Kafka/本地文件后异步入库（见 docs/architecture.md 权衡说明）。
 *
 * 读取策略：审计日志含敏感快照，仅 AUDITOR / SUPER_ADMIN 角色的接口可访问，且查询强制分页。
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuditRecordInput): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          userId: input.userId,
          userName: input.userName,
          action: input.action,
          resource: input.resource,
          resourceId: input.resourceId,
          summary: input.summary.slice(0, 512),
          before: sanitizeJson(input.before) as Prisma.InputJsonValue,
          after: sanitizeJson(input.after) as Prisma.InputJsonValue,
          ip: input.ip,
          userAgent: input.userAgent,
          requestId: input.requestId,
          durationMs: input.durationMs,
          success: input.success,
          errorMessage: input.errorMessage?.slice(0, 512) ?? null,
        },
      });
    } catch (error) {
      this.logger.error(
        `审计写入失败 action=${input.action} resource=${input.resource} id=${input.resourceId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /** 条件查询审计日志（管理员排查「谁改了这条合同」） */
  async query(params: AuditQuery): Promise<PaginatedResult<AuditLogView>> {
    const where: Prisma.AuditLogWhereInput = {
      userId: params.userId,
      resource: params.resource,
      resourceId: params.resourceId,
      action: params.action,
      success: params.success,
      createdAt:
        params.from || params.to
          ? { gte: params.from ?? undefined, lte: params.to ?? undefined }
          : undefined,
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return buildPaginated(
      items.map((item) => ({
        id: item.id,
        userName: item.userName,
        action: item.action,
        resource: item.resource,
        resourceId: item.resourceId,
        summary: item.summary,
        ip: item.ip,
        success: item.success,
        errorMessage: item.errorMessage,
        durationMs: item.durationMs,
        requestId: item.requestId,
        before: item.before,
        after: item.after,
        createdAt: item.createdAt.toISOString(),
      })),
      total,
      params.page,
      params.pageSize,
    );
  }

  /** 某条业务资源的完整变更历史（详情页「操作记录」Tab） */
  async timelineFor(
    resource: string,
    resourceId: string,
    limit = 50,
  ): Promise<AuditLogView[]> {
    const items = await this.prisma.auditLog.findMany({
      where: { resource, resourceId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
    });
    return items.map((item) => ({
      id: item.id,
      userName: item.userName,
      action: item.action,
      resource: item.resource,
      resourceId: item.resourceId,
      summary: item.summary,
      ip: item.ip,
      success: item.success,
      errorMessage: item.errorMessage,
      durationMs: item.durationMs,
      requestId: item.requestId,
      before: item.before,
      after: item.after,
      createdAt: item.createdAt.toISOString(),
    }));
  }

  /**
   * 保留期清理。审计日志无限增长会拖慢查询并增加存储成本，
   * 默认保留 365 天（AUDIT_LOG_RETENTION_DAYS），由定时任务每月执行。
   */
  async purgeExpired(retentionDays: number): Promise<number> {
    const threshold = new Date(Date.now() - retentionDays * 86_400_000);
    const result = await this.prisma.auditLog.deleteMany({
      where: { createdAt: { lt: threshold } },
    });
    if (result.count > 0) {
      this.logger.warn(`清理过期审计日志 ${result.count} 条（早于 ${threshold.toISOString()}）`);
    }
    return result.count;
  }

  /** 变更前后差异对比，前端「操作记录」展示字段级 diff */
  static diff(
    before: Record<string, unknown> | null | undefined,
    after: Record<string, unknown> | null | undefined,
  ): Array<{ field: string; before: unknown; after: unknown }> {
    if (!before || !after) return [];
    const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
    const changes: Array<{ field: string; before: unknown; after: unknown }> = [];
    for (const field of fields) {
      const a = before[field];
      const b = after[field];
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        changes.push({ field, before: a, after: b });
      }
    }
    return changes;
  }
}

export interface AuditLogView {
  id: string;
  userName: string | null;
  action: string;
  resource: string;
  resourceId: string | null;
  summary: string;
  ip: string | null;
  success: boolean;
  errorMessage: string | null;
  durationMs: number;
  requestId: string | null;
  before: unknown;
  after: unknown;
  createdAt: string;
}

/** 递归清理 JSON：Prisma Decimal / Date 不能直接进 Json 字段 */
function sanitizeJson(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[too-deep]';
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((item) => sanitizeJson(item, depth + 1));
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    // Prisma.Decimal 判定：有 toFixed 且非 Date
    if (typeof (source as { toFixed?: unknown }).toFixed === 'function' && 's' in source) {
      return (source as { toString: () => string }).toString();
    }
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(source)) {
      output[key] = sanitizeJson(item, depth + 1);
    }
    return output;
  }
  return value;
}
