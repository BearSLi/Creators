import { randomUUID } from 'node:crypto';
import { BadRequestException, INestApplication, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import type { NextFunction, Request, Response } from 'express';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { EmptyStringToUndefinedPipe } from './common/pipes/empty-string-to-undefined.pipe';
import { flattenValidationErrors } from './common/pipes/validation-errors';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor';
import { AuditService } from './modules/audit/audit.service';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { PermissionsGuard } from './modules/auth/guards/permissions.guard';
import { env, isProduction } from './config';

/**
 * 全局中间件与管道的统一装配。
 * 独立成函数（而不是全写在 main.ts）的原因：e2e 测试需要复用完全相同的配置，
 * 否则「测试环境能过、线上 500」这类问题无法避免。
 */
export function configureApp(app: INestApplication): void {
  const logger = new Logger('Bootstrap');
  const expressApp = app as NestExpressApplication;

  // 部署在 Nginx / SLB 之后，需要信任一层代理才能拿到真实客户端 IP（用于审计与限流）
  expressApp.set('trust proxy', 1);

  app.use(
    helmet({
      // 纯 JSON API 不需要 CSP；文档页需要放宽，避免 Swagger UI 白屏
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  // 请求 ID 贯穿日志、错误响应与审计记录，是排查线上问题的第一抓手
  app.use((request: Request & { requestId?: string }, response: Response, next: NextFunction) => {
    const incoming = request.headers['x-request-id'];
    const requestId = typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID();
    request.requestId = requestId;
    response.setHeader('X-Request-Id', requestId);
    next();
  });

  app.enableCors({
    origin: isProduction ? env.WEB_ORIGIN.split(',').map((item) => item.trim()) : true,
    credentials: true,
    exposedHeaders: ['Content-Disposition', 'X-Request-Id'],
  });

  app.useGlobalPipes(
    // 用自定义管道：在标准校验之前把「空字符串」规范化成 undefined，
    // 否则表单里未填写的选填项会被 @IsOptional() 之外的校验器拦下
    // （详见 EmptyStringToUndefinedPipe 的类注释）
    new EmptyStringToUndefinedPipe({
      // 只接受 DTO 声明的字段：防止客户端注入 ownerId/status 等本不该由前端控制的字段
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      validationError: { target: false, value: false },
      /**
       * 自定义校验失败响应：在既有扁平 `message/details` 之外，追加结构化的 `fieldErrors`。
       *
       * 为什么必须做：默认响应里字段名只以英文句子形式出现，前端无法可靠地据此标红输入框；
       * 而前端全局错误提示又写着「请检查标红字段后重试」——两边一凑，
       * 用户看到的就是一句让去看红字段、但一个红字段都没有的提示。
       * 详见 common/pipes/validation-errors.ts 的完整复盘。
       */
      exceptionFactory: (errors) => {
        const { messages, fieldErrors } = flattenValidationErrors(errors);
        return new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: messages.length > 0 ? messages : ['请求参数未通过校验'],
          fieldErrors,
        });
      },
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());

  const reflector = app.get(Reflector);
  const auditService = app.get(AuditService);
  app.useGlobalInterceptors(
    new AuditInterceptor(reflector, auditService),
    new ResponseEnvelopeInterceptor(),
  );

  // 默认拒绝：所有接口都需要 JWT，@Public() 显式放开
  app.useGlobalGuards(new JwtAuthGuard(reflector), new PermissionsGuard(reflector));

  app.setGlobalPrefix('api');

  /**
   * 关于 API 版本控制：**刻意不启用**。
   *
   * 早期版本启用了 `enableVersioning({ type: VersioningType.HEADER, defaultVersion: '1' })`，
   * 结果所有业务路由都变成「只匹配版本 1」，而没有任何控制器标 @Version()，
   * 于是未携带 `X-API-Version: 1` 的请求全部 404 —— 包括前端自己的请求
   * （vite 代理不会加这个头）。整个 API 对外不可用，而单测与类型检查都发现不了，
   * 因为它只在真实 HTTP 请求经过路由匹配时才显现。
   *
   * 结论：本项目是内部工具，只有自家一个前端消费，不存在版本协商需求。
   * 引入版本控制只会增加所有调用方的负担、并制造这类静默故障。
   * 将来若真需要多版本共存，应连同调用方约定与集成测试一起设计，而不是先加上全局开关。
   */
  app.enableShutdownHooks();

  logger.log(`应用初始化完成（环境=${env.NODE_ENV}，AI Provider=${env.AI_PROVIDER}）`);
}
