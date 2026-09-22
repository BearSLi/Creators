import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { CreatorsModule } from '../creators/creators.module';
import { ContentController } from './content.controller';
import { ContentService } from './content.service';
import { MetricsCollectorService } from './metrics-collector.service';

/**
 * 内容模块。
 *
 * imports:
 *   - CreatorsModule：创建/改达人时复用 CreatorService.assertSchedulable，
 *     「什么算可排期」只维护一份规则，避免内容模块与达人模块口径漂移；
 *   - CommonModule：内容编号生成（CodeGeneratorService）。
 * MetricsCollectorService 与 ContentService 同模块提供：
 * 采集是内容的内部能力（数据回填到内容与账号上），不对外暴露独立控制器，
 * 避免出现「绕过内容权限直接刷数据」的入口。
 */
@Module({
  imports: [CreatorsModule, CommonModule],
  controllers: [ContentController],
  providers: [ContentService, MetricsCollectorService],
  exports: [ContentService, MetricsCollectorService],
})
export class ContentsModule {}
