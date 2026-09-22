import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { AiTaskStatus, AiTaskType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/utils/pagination';

export class CreateAiTaskDto {
  @ApiProperty({ enum: AiTaskType, description: '任务类型' })
  @IsEnum(AiTaskType, { message: 'AI 任务类型非法' })
  taskType!: AiTaskType;

  @ApiProperty({
    description:
      '任务输入。字段需与对应 Prompt 模板声明的变量一致，例如脚本生成：{brief, vertical, platform, duration, tone}',
    example: { brief: '某美妆品牌新品粉底液种草，主打持妆 12 小时', platform: 'DOUYIN', duration: 45 },
  })
  @IsObject({ message: 'input 必须是对象' })
  input!: Record<string, unknown>;

  @ApiPropertyOptional({ description: '关联达人 ID（便于从达人详情页反查 AI 历史）' })
  @IsOptional()
  @IsUUID('4')
  creatorId?: string;

  @ApiPropertyOptional({
    description:
      '幂等键。同一 key 只真正调用一次模型，防止用户重复点击造成重复扣费。前端建议用 crypto.randomUUID() 生成',
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  idempotencyKey?: string;
}

export class QueryAiTaskDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: AiTaskType })
  @IsOptional()
  @IsEnum(AiTaskType)
  taskType?: AiTaskType;

  @ApiPropertyOptional({ enum: AiTaskStatus })
  @IsOptional()
  @IsEnum(AiTaskStatus)
  status?: AiTaskStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('4')
  creatorId?: string;

  @ApiPropertyOptional({ description: '按发起人过滤' })
  @IsOptional()
  @IsUUID('4')
  requestedById?: string;

  @ApiPropertyOptional({ description: '起始时间（ISO）' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: '结束时间（ISO）' })
  @IsOptional()
  @IsDateString()
  to?: string;
}

export class SubmitFeedbackDto {
  @ApiProperty({ description: '1 = 采纳，-1 = 拒绝', enum: [1, -1] })
  @IsIn([1, -1], { message: 'feedback 只能是 1（采纳）或 -1（拒绝）' })
  feedback!: 1 | -1;

  @ApiPropertyOptional({ description: '反馈备注，说明采纳/拒绝原因，用于 Prompt 迭代', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class PromptVariableDto {
  @ApiProperty({ description: '变量名，模板中用 {{name}} 引用' })
  @IsString()
  @Matches(/^[a-zA-Z][a-zA-Z0-9_]*$/, { message: '变量名需为字母开头的字母数字下划线组合' })
  @MaxLength(64)
  name!: string;

  @ApiPropertyOptional({ description: '是否必填，默认 true' })
  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @ApiPropertyOptional({ description: '变量说明，展示在 AI 工作台表单上' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @ApiPropertyOptional({ description: '最大长度，超出会被截断以防 token 爆炸', minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20_000)
  maxLength?: number;
}

export class CreatePromptTemplateDto {
  @ApiProperty({ description: '模板 key，如 script.generate；同一 key 的多次创建会递增版本号' })
  @IsString()
  @Matches(/^[a-z][a-z0-9_.]*$/, { message: '模板 key 需为小写字母、数字、点、下划线组合，如 script.generate' })
  @MaxLength(64)
  key!: string;

  @ApiProperty({ description: '模板名称' })
  @IsString()
  @MinLength(2)
  @MaxLength(128)
  name!: string;

  @ApiPropertyOptional({ description: '模板说明' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiProperty({ description: '系统提示词：角色设定与硬性约束' })
  @IsString()
  @MinLength(10, { message: '系统提示词至少 10 个字符' })
  @MaxLength(8000)
  systemPrompt!: string;

  @ApiProperty({ description: '用户提示词模板，使用 {{variable}} 占位' })
  @IsString()
  @MinLength(5)
  @MaxLength(8000)
  userPromptTemplate!: string;

  @ApiPropertyOptional({ type: [PromptVariableDto], description: '变量声明' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => PromptVariableDto)
  variables?: PromptVariableDto[];

  @ApiPropertyOptional({ description: '期望输出的 JSON Schema（用于文档与校验参考）' })
  @IsOptional()
  @IsObject()
  outputSchema?: Record<string, unknown>;

  @ApiProperty({ description: '使用的模型名，如 gpt-4o-mini / claude-3-5-sonnet / gemini-1.5-pro' })
  @IsString()
  @MaxLength(64)
  model!: string;

  @ApiPropertyOptional({ description: '温度 0-2，创意任务高、结构化任务低', minimum: 0, maximum: 2 })
  @IsOptional()
  @Type(() => Number)
  @Min(0)
  @Max(2)
  temperature?: number;

  @ApiPropertyOptional({ description: '最大输出 token', minimum: 256 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(256)
  @Max(32_000)
  maxTokens?: number;

  @ApiPropertyOptional({ description: '是否启用' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    description: '灰度比例 0-100。小于 100 时仅部分流量生效，用于 A/B 验证 Prompt 效果',
    minimum: 0,
    maximum: 100,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  rolloutPercent?: number;

  @ApiPropertyOptional({ description: '指定版本号（默认在 latest 基础上 +1）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  version?: number;
}

export class UpdatePromptTemplateDto extends PartialType(CreatePromptTemplateDto) {}

export class QueryPromptTemplateDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '按 key 精确过滤' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  key?: string;

  @ApiPropertyOptional({ description: '关键词：名称或 key' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  keyword?: string;

  @ApiPropertyOptional({ description: '是否启用' })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isActive?: boolean;
}

export class TogglePromptTemplateDto {
  @ApiProperty({ description: '启用/停用。停用是下线而非删除，保留历史引用' })
  @IsBoolean()
  isActive!: boolean;
}

export class AnalyzeCommentsDto {
  @ApiProperty({ description: '评论原文，每行一条', maxLength: 12000 })
  @IsString()
  @MinLength(2)
  @MaxLength(12_000)
  comments!: string;

  @ApiPropertyOptional({ description: '内容标题' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ description: '关联内容 ID，生成的洞察会回写到内容备注' })
  @IsOptional()
  @IsUUID('4')
  contentId?: string;
}
