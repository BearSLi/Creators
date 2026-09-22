import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { ContentVertical, ProjectStatus } from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { PaginationQueryDto, ToArray } from '../../../common/utils/pagination';

/** 金额统一用字符串传递：前端不经过 JS 浮点（0.1+0.2 类问题）再送回后端 */
export const MONEY_PATTERN = /^\d{1,16}(\.\d{1,2})?$/;

export class CreateProjectDto {
  @ApiProperty({ description: '项目名称，如「某品牌 3 月短剧投放」', maxLength: 200 })
  @IsString()
  @Length(1, 200)
  name!: string;

  @ApiPropertyOptional({ description: '品牌（客户）ID' })
  @IsOptional()
  @IsUUID('4')
  brandId?: string;

  @ApiPropertyOptional({ description: '合同 ID。合同的达人必须与 creatorId 一致' })
  @IsOptional()
  @IsUUID('4')
  contractId?: string;

  @ApiPropertyOptional({ description: '达人 ID。需已签约且在可排期状态' })
  @IsOptional()
  @IsUUID('4')
  creatorId?: string;

  @ApiPropertyOptional({ enum: ContentVertical, description: '内容垂类，默认 SHORT_DRAMA' })
  @IsOptional()
  @IsEnum(ContentVertical)
  vertical?: ContentVertical;

  @ApiPropertyOptional({
    description: '预算（元，字符串，最多两位小数）。用于毛利看板',
    example: '50000.00',
  })
  @IsOptional()
  @Matches(MONEY_PATTERN, { message: '预算格式不正确，需为最多两位小数的金额字符串' })
  budget?: string;

  @ApiPropertyOptional({ description: '项目负责人（员工）ID' })
  @IsOptional()
  @IsUUID('4')
  ownerId?: string;

  @ApiPropertyOptional({ description: '开始日期（ISO 8601）', example: '2026-03-01' })
  @IsOptional()
  @IsDateString({}, { message: 'startDate 需为 ISO 8601 日期字符串' })
  startDate?: string;

  @ApiPropertyOptional({ description: '交付截止日期（ISO 8601），必须晚于开始日期' })
  @IsOptional()
  @IsDateString({}, { message: 'dueDate 需为 ISO 8601 日期字符串' })
  dueDate?: string;

  @ApiPropertyOptional({ description: '项目 brief：内容方向、交付要求、注意事项', maxLength: 5000 })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  brief?: string;
}

export class UpdateProjectDto extends PartialType(CreateProjectDto) {}

export class ChangeProjectStatusDto {
  @ApiProperty({ enum: ProjectStatus, description: '目标状态' })
  @IsEnum(ProjectStatus)
  status!: ProjectStatus;

  @ApiPropertyOptional({
    description: '变更原因。变更为「已取消」时必填（用于审计追溯）',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** 项目列表查询条件：与项目看板筛选栏一一对应 */
export class QueryProjectDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ProjectStatus, isArray: true, description: '状态多选' })
  @ToArray()
  @IsOptional()
  @IsEnum(ProjectStatus, { each: true })
  status?: ProjectStatus[];

  @ApiPropertyOptional({ description: '品牌 ID' })
  @IsOptional()
  @IsUUID('4')
  brandId?: string;

  @ApiPropertyOptional({ description: '达人 ID' })
  @IsOptional()
  @IsUUID('4')
  creatorId?: string;

  @ApiPropertyOptional({ description: '关键词：项目名称/编号/品牌名/达人名' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  keyword?: string;
}
