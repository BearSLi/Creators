import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SettlementStatus } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto, ToArray } from '../../../common/utils/pagination';

export class QuerySettlementDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: SettlementStatus, isArray: true })
  @ToArray()
  @IsOptional()
  @IsEnum(SettlementStatus, { each: true })
  status?: SettlementStatus[];

  @ApiPropertyOptional({ description: '达人 ID' })
  @IsOptional()
  @IsUUID('4')
  creatorId?: string;

  @ApiPropertyOptional({ description: '账期开始（ISO 日期）', example: '2026-01-01' })
  @IsOptional()
  @IsDateString({}, { message: 'periodStart 需为 ISO 日期' })
  periodStart?: string;

  @ApiPropertyOptional({ description: '账期结束（ISO 日期）', example: '2026-01-31' })
  @IsOptional()
  @IsDateString({}, { message: 'periodEnd 需为 ISO 日期' })
  periodEnd?: string;

  @ApiPropertyOptional({ description: '关键词：结算单号 / 达人姓名' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  keyword?: string;
}

export class GenerateSettlementDto {
  @ApiPropertyOptional({ description: '账期（YYYY-MM）。与 periodStart/periodEnd 二选一', example: '2026-01' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}$/, { message: '账期格式应为 YYYY-MM' })
  month?: string;

  @ApiPropertyOptional({ description: '自定义账期开始（ISO 日期）' })
  @IsOptional()
  @IsDateString({}, { message: 'periodStart 需为 ISO 日期' })
  periodStart?: string;

  @ApiPropertyOptional({ description: '自定义账期结束（ISO 日期）' })
  @IsOptional()
  @IsDateString({}, { message: 'periodEnd 需为 ISO 日期' })
  periodEnd?: string;

  @ApiPropertyOptional({ description: '仅生成指定达人的结算单（不传则全量扫描）', type: [String] })
  @ToArray()
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  creatorIds?: string[];
}

export class PreviewSettlementDto {
  @ApiProperty({ description: '达人 ID' })
  @IsUUID('4')
  creatorId!: string;

  @ApiPropertyOptional({ description: '账期（YYYY-MM）' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}$/)
  month?: string;

  @ApiPropertyOptional({ description: '账期开始' })
  @IsOptional()
  @IsDateString()
  periodStart?: string;

  @ApiPropertyOptional({ description: '账期结束' })
  @IsOptional()
  @IsDateString()
  periodEnd?: string;
}

export class AdjustSettlementDto {
  @ApiProperty({ description: '调整金额（元，字符串以保精度），正数为补款、负数为扣款', example: '-120.00' })
  @IsString()
  @Matches(/^-?\d+(\.\d{1,2})?$/, { message: '金额格式应为最多两位小数的数字/字符串' })
  @MinLength(1)
  @MaxLength(20)
  amount!: string;

  @ApiProperty({ description: '调整原因（必填，写入结算单与审计日志）', maxLength: 500 })
  @IsString()
  @MinLength(2, { message: '调整原因至少 2 个字' })
  @MaxLength(500)
  reason!: string;
}

export class PaySettlementDto {
  @ApiPropertyOptional({ description: '打款凭证地址（银行回单/截图）' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  paymentVoucherUrl?: string;
}

export class DisputeSettlementDto {
  @ApiProperty({ description: '争议原因', maxLength: 500 })
  @IsString()
  @MinLength(2)
  @MaxLength(500)
  reason!: string;
}

export class VoidSettlementDto {
  @ApiProperty({ description: '作废原因', maxLength: 500 })
  @IsString()
  @MinLength(2)
  @MaxLength(500)
  reason!: string;
}

/** 结算导出查询（不分页，导出全部命中的数据） */
export class ExportSettlementDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('4')
  creatorId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  periodStart?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  periodEnd?: string;

  @ApiPropertyOptional({ enum: SettlementStatus, isArray: true })
  @ToArray()
  @IsOptional()
  @IsEnum(SettlementStatus, { each: true })
  status?: SettlementStatus[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  keyword?: string;
}

/** 结算异常解释（AI 辅助）请求 */
export class ExplainSettlementDto {
  @ApiProperty({ description: '结算单 ID' })
  @IsUUID('4')
  settlementId!: string;

  @ApiPropertyOptional({ description: '达人或财务的疑问，例如「为什么这个月比上月少了 3000」' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  question?: string;
}
