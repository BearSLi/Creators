import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  StreamableFile,
} from '@nestjs/common';
import { map, Observable } from 'rxjs';
import type { Response } from 'express';

export interface ApiEnvelope<T> {
  success: true;
  data: T;
  requestId: string;
  timestamp: string;
}

/**
 * 统一成功响应包装：{ success, data, requestId, timestamp }
 *
 * 例外：
 * - 文件下载（StreamableFile / 已设置 Content-Disposition 的响应）不包装，
 *   否则会破坏二进制流。
 * - 已经是信封结构的返回值（例如分页已带 items/total）仍包一层 data，
 *   前端解包逻辑统一：const data = res.data.data。
 */
@Injectable()
export class ResponseEnvelopeInterceptor<T> implements NestInterceptor<T, ApiEnvelope<T> | T> {
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<ApiEnvelope<T> | T> {
    const http = context.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<{ requestId?: string }>();
    const requestId = request.requestId ?? 'unknown';

    return next.handle().pipe(
      map((data) => {
        if (data instanceof StreamableFile) return data;
        if (response.getHeader('Content-Disposition')) return data;

        return {
          success: true as const,
          data,
          requestId,
          timestamp: new Date().toISOString(),
        };
      }),
    );
  }
}
