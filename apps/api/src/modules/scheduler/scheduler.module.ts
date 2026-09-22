import { Module } from '@nestjs/common';
import { ContentsModule } from '../contents/contents.module';
import { SettlementsModule } from '../settlements/settlements.module';
import { ScheduledJobsService } from './scheduled-jobs.service';

/**
 * 定时任务模块。
 *
 * 为什么依赖业务模块而不是自己实现一遍：
 *   - 依赖 SettlementsModule：让「手动生成结算」与「每月自动生成」走同一段代码。
 *     两套实现是数据口径分歧的常见来源，而且口径分歧往往几个月后才发现。
 *   - 依赖 ContentsModule：复用采集器（含驱动选择、超时重试、幂等快照）而不是重写。
 */
@Module({
  imports: [SettlementsModule, ContentsModule],
  providers: [ScheduledJobsService],
})
export class SchedulerModule {}
