import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiTaskService } from './ai-task.service';
import { AiProviderRegistry } from './providers/ai-provider.registry';
import { PromptTemplateService } from './prompt-template.service';

/**
 * AI 能力模块。
 *
 * 定位：为业务模块提供「可治理」的 AI 调用能力，而不是散落各处的模型调用。
 * 治理能力包括：模板版本化与灰度、幂等防重复扣费、成本预算熔断、
 * 失败降级、结构化输出校验、全量落库可观测、人工反馈闭环。
 */
@Module({
  controllers: [AiController],
  providers: [AiProviderRegistry, PromptTemplateService, AiTaskService],
  exports: [AiTaskService, PromptTemplateService, AiProviderRegistry],
})
export class AiModule {}
