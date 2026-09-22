import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { env } from './config';
import { buildSwaggerConfig } from './config/swagger.config';

/**
 * 应用入口。
 *
 * 启动顺序刻意如此：先校验环境变量（config/env.ts 在 import 时即校验，
 * 缺失关键配置会直接 crash）→ 再建应用 → 最后监听端口。
 * 「启动即失败」比「运行到某个接口才 500」对运维友好得多。
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    // 请求体上限：批量导入达人、提交长脚本需要较大 body，但必须有上限防 DoS
    bodyParser: true,
    rawBody: false,
  });

  app.useBodyParser('json', { limit: '2mb' });
  app.useBodyParser('urlencoded', { limit: '512kb', extended: true });

  configureApp(app);

  // Swagger 仅在非生产环境开放：接口文档会暴露内部数据结构，生产环境不应对外可访问
  if (env.NODE_ENV !== 'production') {
    // 文档定义与 scripts/generate-openapi.mjs 共用同一份配置，
    // 避免「UI 上有、导出的 spec 里没有」这类契约漂移
    const document = SwaggerModule.createDocument(app, buildSwaggerConfig());
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: { persistAuthorization: true, docExpansion: 'none' },
      customSiteTitle: 'CreatorOps API 文档',
    });
    logger.log(`Swagger 文档已开启：${env.PUBLIC_BASE_URL}/api/docs`);
  }

  await app.listen(env.API_PORT, '0.0.0.0');

  logger.log(`CreatorOps API 已启动：http://localhost:${env.API_PORT}/api`);
  logger.log(`环境=${env.NODE_ENV}  数据库连接池=${env.DATABASE_POOL_SIZE}  AI Provider=${env.AI_PROVIDER}`);
  logger.log(`健康检查：http://localhost:${env.API_PORT}/api/health/ready`);

  // 优雅退出：收到 SIGTERM 时停止接收新请求并关闭数据库连接（k8s 滚动更新必需）
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      logger.log(`收到 ${signal}，开始优雅退出…`);
      void app.close().then(() => process.exit(0));
    });
  }
}

void bootstrap().catch((error: unknown) => {
  // 启动失败必须打完整堆栈并以非 0 退出，否则容器编排会认为启动成功
  const logger = new Logger('Bootstrap');
  logger.error('应用启动失败', error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
