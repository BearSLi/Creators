import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser, RequirePermissions } from '../../common/decorators/index';
import type { AuthUser } from '../auth/auth.types';
import { PERMISSIONS } from '../auth/permissions';
import { AiTaskService } from './ai-task.service';
import { PromptTemplateService } from './prompt-template.service';
import {
  CreateAiTaskDto,
  CreatePromptTemplateDto,
  QueryAiTaskDto,
  QueryPromptTemplateDto,
  SubmitFeedbackDto,
  TogglePromptTemplateDto,
  UpdatePromptTemplateDto,
} from './dto/ai.dto';

@ApiTags('AI 能力')
@ApiBearerAuth()
@Controller('ai')
export class AiController {
  constructor(
    private readonly aiTaskService: AiTaskService,
    private readonly promptTemplateService: PromptTemplateService,
  ) {}

  // ------------------------------ 任务 ------------------------------

  @Get('tasks')
  @RequirePermissions(PERMISSIONS.AI_RUN)
  @ApiOperation({ summary: 'AI 任务列表（可按类型/状态/达人/时间筛选）' })
  async listTasks(@CurrentUser() user: AuthUser, @Query() query: QueryAiTaskDto) {
    return this.aiTaskService.list(user, query);
  }

  @Get('tasks/:id')
  @RequirePermissions(PERMISSIONS.AI_RUN)
  @ApiOperation({ summary: 'AI 任务详情（含输入、输出、token、成本、耗时、降级原因）' })
  async getTask(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.aiTaskService.findOne(id);
  }

  @Post('tasks')
  @RequirePermissions(PERMISSIONS.AI_RUN)
  @Audit({
    action: 'AI_INVOKE',
    resource: 'ai_task',
    summary: '发起 AI 任务',
    // AI 输入可能含大段内容，审计只记任务类型即可，避免审计表被大 payload 撑爆
    captureBody: false,
  })
  @ApiOperation({
    summary: '发起 AI 任务',
    description:
      '按任务类型选择 Prompt 模板 → 渲染 → 预算校验 → 调用模型（失败自动降级）→ 结构化校验 → 落库成本与耗时。传 idempotencyKey 可防重复扣费。',
  })
  async createTask(@CurrentUser() user: AuthUser, @Body() dto: CreateAiTaskDto) {
    return this.aiTaskService.execute(user, dto);
  }

  @Post('tasks/:id/feedback')
  @RequirePermissions(PERMISSIONS.AI_FEEDBACK)
  @Audit({ action: 'UPDATE', resource: 'ai_task', summary: '提交 AI 结果反馈' })
  @ApiOperation({
    summary: '提交 AI 结果反馈（采纳/拒绝）',
    description: '反馈用于统计采纳率并驱动 Prompt 迭代，是「AI 真的有用吗」的量化依据。',
  })
  async feedback(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: SubmitFeedbackDto,
  ) {
    return this.aiTaskService.submitFeedback(user, id, dto);
  }

  @Get('usage')
  @RequirePermissions(PERMISSIONS.AI_RUN)
  @ApiOperation({
    summary: 'AI 月度用量与成本',
    description: '返回预算占用、各任务类型调用量/成本/平均耗时、人工采纳率。',
  })
  async usage(@Query('year') year?: string, @Query('month') month?: string) {
    const now = new Date();
    const parsedYear = year ? Number.parseInt(year, 10) : now.getFullYear();
    const parsedMonth = month ? Number.parseInt(month, 10) : now.getMonth() + 1;
    const safeYear = Number.isFinite(parsedYear) ? parsedYear : now.getFullYear();
    const safeMonth = Number.isFinite(parsedMonth) && parsedMonth >= 1 && parsedMonth <= 12 ? parsedMonth : now.getMonth() + 1;
    return this.aiTaskService.usage(safeYear, safeMonth);
  }

  // ------------------------------ Prompt 模板 ------------------------------

  @Get('prompts')
  @RequirePermissions(PERMISSIONS.AI_PROMPT_READ)
  @ApiOperation({ summary: 'Prompt 模板列表（含多版本）' })
  async listPrompts(@Query() query: QueryPromptTemplateDto) {
    return this.promptTemplateService.list(query);
  }

  @Get('prompts/:id')
  @RequirePermissions(PERMISSIONS.AI_PROMPT_READ)
  @ApiOperation({ summary: 'Prompt 模板详情' })
  async getPrompt(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.promptTemplateService.findOne(id);
  }

  @Post('prompts')
  @RequirePermissions(PERMISSIONS.AI_PROMPT_WRITE)
  @Audit({ action: 'CREATE', resource: 'prompt_template', summary: '新建 Prompt 模板版本' })
  @ApiOperation({
    summary: '新建 Prompt 模板',
    description: '同一 key 再次创建会自动递增 version，形成可回滚的版本历史。',
  })
  async createPrompt(@CurrentUser() user: AuthUser, @Body() dto: CreatePromptTemplateDto) {
    return this.promptTemplateService.create(user, dto);
  }

  @Patch('prompts/:id')
  @RequirePermissions(PERMISSIONS.AI_PROMPT_WRITE)
  @Audit({ action: 'UPDATE', resource: 'prompt_template', summary: '编辑 Prompt 模板' })
  @ApiOperation({
    summary: '编辑 Prompt 模板',
    description: '已被任务使用过的模板禁止修改 Prompt 内容，必须新建版本，保证历史任务可追溯。',
  })
  async updatePrompt(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdatePromptTemplateDto,
  ) {
    return this.promptTemplateService.update(user, id, dto);
  }

  @Post('prompts/:id/toggle')
  @RequirePermissions(PERMISSIONS.AI_PROMPT_WRITE)
  @Audit({ action: 'UPDATE', resource: 'prompt_template', summary: '启用/停用 Prompt 模板' })
  @ApiOperation({ summary: '启用/停用 Prompt 模板（停用保留历史引用）' })
  async togglePrompt(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: TogglePromptTemplateDto,
  ) {
    return this.promptTemplateService.toggle(user, id, dto.isActive);
  }

  @Post('prompts/seed-defaults')
  @RequirePermissions(PERMISSIONS.AI_PROMPT_WRITE)
  @Audit({ action: 'CREATE', resource: 'prompt_template', summary: '初始化内置 Prompt 模板' })
  @ApiOperation({ summary: '补齐内置默认模板（幂等，已存在的 key 不会被覆盖）' })
  async seedDefaults() {
    return this.promptTemplateService.seedDefaultTemplates();
  }
}
