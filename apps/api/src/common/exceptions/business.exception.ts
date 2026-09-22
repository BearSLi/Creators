import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * 业务异常基类。
 *
 * 与 HttpException 的区别：携带稳定的机器可读 `code`，
 * 前端用它做文案映射，而不是解析中文 message（文案改动不该破坏前端逻辑）。
 *
 * 为什么 status 参数放宽为 `HttpStatus | number`：
 * NestJS 的 `HttpStatus` 枚举没有收录 423 Locked（WebDAV 扩展状态码），
 * 而账号锁定场景用 423 语义最准确。放宽类型后既可用枚举成员，
 * 也可直接传标准 HTTP 状态码数字，不必为了迁就枚举而改用不贴切的 403。
 */
export class BusinessException extends HttpException {
  constructor(
    readonly code: string,
    message: string,
    status: HttpStatus | number = HttpStatus.BAD_REQUEST,
    readonly details?: unknown,
  ) {
    super({ code, message }, status);
  }
}

/** 404：目标资源不存在 */
export class ResourceNotFoundException extends BusinessException {
  constructor(resource: string, id?: string) {
    super(
      'RESOURCE_NOT_FOUND',
      id ? `${resource} 不存在：${id}` : `${resource} 不存在`,
      HttpStatus.NOT_FOUND,
    );
  }
}

/** 409：业务状态冲突，如状态机不允许的流转 */
export class StateConflictException extends BusinessException {
  constructor(message: string, details?: unknown) {
    super('STATE_CONFLICT', message, HttpStatus.CONFLICT, details);
  }
}

/** 403：权限不足 */
export class PermissionDeniedException extends BusinessException {
  constructor(message = '当前角色无权执行该操作', details?: unknown) {
    super('PERMISSION_DENIED', message, HttpStatus.FORBIDDEN, details);
  }
}

/** 409：幂等键冲突，重复提交已被安全忽略 */
export class DuplicateOperationException extends BusinessException {
  constructor(message = '该操作已执行，请勿重复提交', details?: unknown) {
    super('DUPLICATE_OPERATION', message, HttpStatus.CONFLICT, details);
  }
}

/** 422：入参在语义上不可用（格式合法但业务不可行） */
export class UnprocessableException extends BusinessException {
  constructor(message: string, details?: unknown) {
    super('UNPROCESSABLE_ENTITY', message, HttpStatus.UNPROCESSABLE_ENTITY, details);
  }
}

/** 429：触发限流，附带重试建议 */
export class RateLimitedException extends BusinessException {
  constructor(message = '操作过于频繁，请稍后重试', retryAfterSeconds = 60) {
    super('RATE_LIMITED', message, HttpStatus.TOO_MANY_REQUESTS, { retryAfterSeconds });
  }
}

/** 503：外部依赖（AI / 平台接口）不可用，已降级 */
export class UpstreamUnavailableException extends BusinessException {
  constructor(service: string, details?: unknown) {
    super(
      'UPSTREAM_UNAVAILABLE',
      `${service} 暂时不可用，请稍后重试`,
      HttpStatus.SERVICE_UNAVAILABLE,
      details,
    );
  }
}
