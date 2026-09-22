import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import type { Request } from 'express';
import { AUDIT_META_KEY, AuditMeta } from '../decorators/audit.decorator';
import { AuditService } from '../../modules/audit/audit.service';
import type { AuthUser } from '../../modules/auth/auth.types';

/**
 * 审计拦截器：对所有标注 @Audit() 的写操作自动落审计日志。
 *
 * 为什么用拦截器而不是在 Service 里手写：
 *   手工埋点一定会漏（尤其是后续新增接口），而审计是合规刚需。
 *   把「动作名 + 资源类型」声明在 Controller 上，拦截器统一记录：
 *   操作人、IP、UA、requestId、耗时、成功与否、变更前后快照。
 * 敏感字段在 AuditService 内部脱敏（手机号/证件号/金额可选脱敏策略）。
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly auditService: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.get<AuditMeta>(AUDIT_META_KEY, context.getHandler());
    if (!meta) return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<Request & { user?: AuthUser; requestId?: string }>();
    const startedAt = Date.now();

    return next.handle().pipe(
      tap({
        next: (result) => {
          void this.write(meta, request, result, startedAt, true, null);
        },
        error: (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          void this.write(meta, request, null, startedAt, false, message);
        },
      }),
    );
  }

  private async write(
    meta: AuditMeta,
    request: Request & { user?: AuthUser; requestId?: string },
    result: unknown,
    startedAt: number,
    success: boolean,
    errorMessage: string | null,
  ): Promise<void> {
    try {
      const resourceId = meta.resourceIdFrom?.(request, result) ?? extractResourceId(request, result);
      await this.auditService.record({
        userId: request.user?.id ?? null,
        userName: request.user?.name ?? null,
        action: meta.action,
        resource: meta.resource,
        resourceId,
        summary: meta.summary ?? `${meta.action} ${meta.resource}`,
        before: meta.captureBody === false ? undefined : maskBody(request.body),
        after: success ? summarizeResult(result) : undefined,
        ip: request.ip ?? null,
        userAgent: request.headers['user-agent']?.slice(0, 256) ?? null,
        requestId: request.requestId ?? null,
        durationMs: Date.now() - startedAt,
        success,
        errorMessage,
      });
    } catch (error) {
      // 审计失败不能影响主流程（例如数据库瞬时抖动），但必须留痕到应用日志以便补偿
      this.logger.error(
        `写入审计日志失败 action=${meta.action} resource=${meta.resource}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}

const SENSITIVE_BODY_KEYS = new Set([
  'password',
  'newPassword',
  'oldPassword',
  'refreshToken',
  'accessToken',
  'idCard',
  'idCardEncrypted',
]);

/** 入参脱敏后入库：审计日志本身也是敏感数据，不能变成密码泄露的新渠道 */
function maskBody(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  if (Array.isArray(body)) return body.map((item) => maskBody(item));
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    output[key] = SENSITIVE_BODY_KEYS.has(key) ? '***' : maskBody(value);
  }
  return output;
}

/** 结果摘要：只保留 id 与关键状态字段，避免审计表被大 payload 撑爆 */
function summarizeResult(result: unknown): unknown {
  if (result === null || result === undefined) return undefined;
  if (typeof result !== 'object') return { value: result };
  const source = result as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of ['id', 'code', 'status', 'success', 'count', 'total']) {
    if (key in source) picked[key] = source[key];
  }
  if ('data' in source && source.data && typeof source.data === 'object') {
    const data = source.data as Record<string, unknown>;
    if ('id' in data) picked.id = data.id;
    if ('code' in data) picked.code = data.code;
    if ('status' in data) picked.status = data.status;
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}

function extractResourceId(request: Request, result: unknown): string | null {
  const params = request.params as Record<string, string | undefined>;
  if (params?.id) return params.id;
  if (result && typeof result === 'object') {
    const source = result as Record<string, unknown>;
    if (typeof source.id === 'string') return source.id;
    const data = source.data as Record<string, unknown> | undefined;
    if (data && typeof data.id === 'string') return data.id;
  }
  return null;
}
