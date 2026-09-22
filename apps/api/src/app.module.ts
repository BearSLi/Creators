import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { env } from './config';
import { PrismaModule } from './prisma/prisma.module';
import { AiModule } from './modules/ai/ai.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { BrandsModule } from './modules/brands/brands.module';
import { CommonModule } from './modules/common/common.module';
import { ContentsModule } from './modules/contents/contents.module';
import { ContractsModule } from './modules/contracts/contracts.module';
import { CreatorsModule } from './modules/creators/creators.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { HealthModule } from './modules/health/health.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { SchedulerModule } from './modules/scheduler/scheduler.module';
import { SettlementsModule } from './modules/settlements/settlements.module';
import { UsersModule } from './modules/users/users.module';

/**
 * 应用根模块。
 *
 * 装配顺序遵循依赖方向：基础设施（Prisma/Config/限流）→ 通用能力（审计/AI）→ 业务模块。
 * 每个业务模块自己声明依赖，根模块只做汇总，避免出现「根模块里塞满 provider」的泥球。
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // 配置来源统一走自定义 env 校验（src/config/env.ts），这里只做全局可用性
      ignoreEnvFile: true,
      cache: true,
    }),
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: env.THROTTLE_TTL_SECONDS * 1000,
        limit: env.THROTTLE_LIMIT,
      },
    ]),
    ScheduleModule.forRoot(),
    PrismaModule,
    CommonModule,
    AuditModule,
    AiModule,
    AuthModule,
    HealthModule,
    CreatorsModule,
    BrandsModule,
    ContractsModule,
    ProjectsModule,
    ContentsModule,
    SettlementsModule,
    DashboardModule,
    UsersModule,
    SchedulerModule,
  ],
  providers: [
    // 全局限流：登录接口在 Controller 上单独覆盖为更严格阈值
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
