import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { ContentStatus, Platform } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginationQueryDto, ToArray } from '../../../common/utils/pagination';

export class CreateContentDto {
  @ApiProperty({ description: '达人 ID（内容归属人，结算归因的最小单元就是它）' })
  @IsUUID('4')
  creatorId!: string;

  @ApiPropertyOptional({ description: '所属项目 ID' })
  @IsOptional()
  @IsUUID('4')
  projectId?: string;

  @ApiPropertyOptional({ description: '发布账号 ID（PlatformAccount），必须是该达人自己的账号' })
  @IsOptional()
  @IsUUID('4')
  accountId?: string;

  @ApiProperty({ description: '内容标题', maxLength: 200 })
  @IsString()
  @Length(1, 200)
  title!: string;

  @ApiPropertyOptional({ description: '脚本/文案（AI 生成内容也留档，便于复盘与合规追溯）' })
  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  script?: string;

  @ApiProperty({ enum: Platform, description: '发布平台' })
  @IsEnum(Platform)
  platform!: Platform;

  @ApiPropertyOptional({
    enum: ContentStatus,
    description: '初始状态，仅允许 IDEA 或 SCRIPTING；其余状态必须走状态流转接口',
  })
  @IsOptional()
  @IsEnum(ContentStatus)
  status?: ContentStatus;

  @ApiPropertyOptional({ description: '时长（秒）', minimum: 0, maximum: 86_400 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(86_400)
  durationSec?: number;

  @ApiPropertyOptional({ description: '计划发布时间（ISO 8601）' })
  @IsOptional()
  @IsDateString({}, { message: 'scheduledAt 需为 ISO 8601 日期时间字符串' })
  scheduledAt?: string;

  @ApiPropertyOptional({ description: '关联的 AI 任务 ID（脚本生成/合规预检）' })
  @IsOptional()
  @IsUUID('4')
  aiTaskId?: string;
}

/**
 * 内容更新 DTO。
 *
 * 刻意排除 status：状态只能经状态机接口（submit-review / review / publish）流转，
 * 否则 PATCH 一个 status 就能把「选题」直接改成「已发布」，绕过审核与发布时间回填，
 * 结算与数据采集会认到一条从未真正发布过的内容。
 */
export class UpdateContentDto extends PartialType(
  OmitType(CreateContentDto, ['status'] as const),
) {
  @ApiPropertyOptional({ description: 'AI 合规预检分 0-100（合规预检回写用）', minimum: 0, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  complianceScore?: number;

  @ApiPropertyOptional({
    type: [Object],
    description: '合规风险项 [{ level, category, snippet, suggestion }]，由 AI 预检回写',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50, { message: '合规风险项最多 50 条' })
  complianceFlags?: unknown[];
}

export class ReviewContentDto {
  @ApiProperty({ description: '审核是否通过' })
  @IsBoolean()
  approved!: boolean;

  @ApiPropertyOptional({ description: '审核备注（通过/驳回都建议填写）', maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  @ApiPropertyOptional({ description: '驳回原因（approved=false 时必填，会回显给内容团队）', maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  rejectReason?: string;
}

export class PublishContentDto {
  @ApiPropertyOptional({ description: '平台侧内容 ID，发布后回填用于关联采集数据', maxLength: 128 })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  platformContentId?: string;

  @ApiPropertyOptional({ description: '发布链接', maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  publishedUrl?: string;

  @ApiPropertyOptional({ description: '实际发布时间（不传取当前时间，用于补录历史内容）' })
  @IsOptional()
  @IsDateString({}, { message: 'publishedAt 需为 ISO 8601 日期时间字符串' })
  publishedAt?: string;
}

/** 内容列表查询条件：与内容看板筛选栏一一对应 */
export class QueryContentDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '达人 ID' })
  @IsOptional()
  @IsUUID('4')
  creatorId?: string;

  @ApiPropertyOptional({ description: '项目 ID' })
  @IsOptional()
  @IsUUID('4')
  projectId?: string;

  @ApiPropertyOptional({ enum: Platform, description: '平台精确过滤' })
  @IsOptional()
  @IsEnum(Platform)
  platform?: Platform;

  @ApiPropertyOptional({ enum: ContentStatus, isArray: true, description: '状态多选' })
  @ToArray()
  @IsOptional()
  @IsEnum(ContentStatus, { each: true })
  status?: ContentStatus[];

  @ApiPropertyOptional({ description: '关键词：内容标题/平台内容 ID' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  keyword?: string;

  @ApiPropertyOptional({ description: '发布时间起（含），ISO 8601' })
  @IsOptional()
  @IsDateString({}, { message: 'from 需为 ISO 8601 日期时间字符串' })
  from?: string;

  @ApiPropertyOptional({ description: '发布时间止（含），ISO 8601' })
  @IsOptional()
  @IsDateString({}, { message: 'to 需为 ISO 8601 日期时间字符串' })
  to?: string;
}
