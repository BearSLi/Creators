import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { BusinessException } from '../exceptions/business.exception';
import { ScopedAccessError } from '../utils/scope';

/** 对外统一错误响应体，前端只需处理一种结构 */
export interface ErrorResponseBody {
  success: false;
  code: string;
  message: string;
  details?: unknown;
  /**
   * 字段级校验错误（仅 VALIDATION_FAILED 会带）：`{ 字段名: [消息] }`。
   *
   * 与 `details` 并存而不是替换它——`details` 是扁平消息数组（既有调用方与文档依赖），
   * `fieldErrors` 是给表单标红用的结构化版本。两者同源，不会不一致。
   */
  fieldErrors?: Record<string, string[]>;
  path: string;
  requestId: string;
  timestamp: string;
}

/**
 * 全局异常过滤器。
 *
 * 职责：
 * 1) 把内部异常翻译成稳定的业务错误码，前端可据此做 i18n 与差异化提示。
 * 2) 绝不把堆栈、SQL、驱动错误原文返回给客户端（信息泄露），只进日志。
 * 3) Prisma 错误码映射成可读语义：唯一冲突 → 409、外键约束 → 409、找不到 → 404。
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { requestId?: string }>();
    const requestId = request.requestId ?? 'unknown';

    const { status, code, message, details, fieldErrors } = this.translate(exception);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `[${requestId}] ${request.method} ${request.url} -> ${status} ${code}: ${message}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(
        `[${requestId}] ${request.method} ${request.url} -> ${status} ${code}: ${message}`,
      );
    }

    const body: ErrorResponseBody = {
      success: false,
      code,
      message,
      details,
      // 只有校验类错误才有字段级信息；其余情况不带该键，避免前端误判
      ...(fieldErrors && Object.keys(fieldErrors).length > 0 ? { fieldErrors } : {}),
      path: request.url,
      requestId,
      timestamp: new Date().toISOString(),
    };
    response.status(status).json(body);
  }

  private translate(exception: unknown): {
    status: number;
    code: string;
    message: string;
    details?: unknown;
    fieldErrors?: Record<string, string[]>;
  } {
    if (exception instanceof BusinessException) {
      return {
        status: exception.getStatus(),
        code: exception.code,
        message: exception.message,
        details: exception.details,
      };
    }

    /**
     * 数据范围越权必须映射为 403，而不是落到下面的兜底 500。
     *
     * ScopedAccessError 是 common/utils/scope.ts 里为了「不依赖 Nest 类型」而
     * 直接继承 Error 的（便于纯函数测试）。但异常过滤器只认识 HttpException，
     * 于是「访问了不在自己负责范围内的数据」会被报成 500 服务内部错误：
     *   - 前端拿不到「这是权限问题」的信息，无法给出正确提示；
     *   - 监控会把正常的越权拦截当成服务故障来告警。
     * 安全边界报错报错得不对，等于这条边界在可观测性上是不可见的。
     */
    if (exception instanceof ScopedAccessError) {
      return {
        status: HttpStatus.FORBIDDEN,
        code: 'SCOPE_DENIED',
        message: exception.message,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      // ValidationPipe 的响应体形如 { message: string[], error, statusCode }
      if (typeof payload === 'object' && payload !== null && 'message' in payload) {
        const raw = (payload as { message: string | string[] }).message;
        const messages = Array.isArray(raw) ? raw : [raw];
        // 校验管道会额外挂 fieldErrors（见 common/pipes/validation-errors.ts）；
        // 其它 HttpException 通常没有这个键，原样透传即可
        const fieldErrors = (payload as { fieldErrors?: Record<string, string[]> }).fieldErrors;
        return {
          status,
          code: status === HttpStatus.BAD_REQUEST ? 'VALIDATION_FAILED' : `HTTP_${status}`,
          message: messages.join('；'),
          details: Array.isArray(raw) ? raw : undefined,
          fieldErrors,
        };
      }
      return { status, code: `HTTP_${status}`, message: exception.message };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.translatePrisma(exception);
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        code: 'DB_VALIDATION_ERROR',
        message: '请求数据不符合数据模型约束',
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: '服务内部错误，请稍后重试或联系系统管理员',
    };
  }

  private translatePrisma(error: Prisma.PrismaClientKnownRequestError): {
    status: number;
    code: string;
    message: string;
    details?: unknown;
  } {
    const target = (error.meta?.target as string[] | string | undefined) ?? undefined;
    const field = Array.isArray(target) ? target.join(', ') : target;

    switch (error.code) {
      case 'P2002':
        return {
          status: HttpStatus.CONFLICT,
          code: 'DUPLICATE_RESOURCE',
          message: `数据已存在，唯一字段冲突${field ? `：${field}` : ''}`,
          details: { fields: target },
        };
      case 'P2003':
        return {
          status: HttpStatus.CONFLICT,
          code: 'RELATION_CONSTRAINT',
          message: '存在关联数据，无法完成该操作（如达人已绑定合同/内容）',
        };
      case 'P2025':
        return {
          status: HttpStatus.NOT_FOUND,
          code: 'RESOURCE_NOT_FOUND',
          message: '目标数据不存在或已被删除',
        };
      case 'P2000':
        return {
          status: HttpStatus.BAD_REQUEST,
          code: 'VALUE_TOO_LONG',
          message: `字段长度超出限制${field ? `：${field}` : ''}`,
        };
      case 'P2034':
        return {
          status: HttpStatus.CONFLICT,
          code: 'TRANSACTION_CONFLICT',
          message: '并发写入冲突，请重试',
        };
      default:
        return {
          status: HttpStatus.BAD_REQUEST,
          code: `DB_${error.code}`,
          message: '数据库操作失败，请检查输入数据',
        };
    }
  }
}
