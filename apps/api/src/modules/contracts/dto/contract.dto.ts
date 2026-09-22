import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { ContractStatus, SettlementMode } from '@prisma/client';
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
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto, ToArray } from '../../../common/utils/pagination';

export class TieredShareDto {
  @ApiProperty({ description: '区间下界（分），含', example: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  from!: number;

  @ApiPropertyOptional({ description: '区间上界（分），不含；null 表示无上限', nullable: true })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  to?: number | null;

  @ApiProperty({ description: '达人分成率（基点，7000 = 70%）' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  talentShareBp!: number;
}

/**
 * 创建合同。
 *
 * 分润字段说明（务必与结算引擎口径一致）：
 *   platformFeeBp 平台抽成 → agencyShareBp 公司分成 → talentShareBp 达人分成 → taxWithholdBp 代扣税
 * 约束：agencyShareBp + talentShareBp <= 10000（公司与达人的分成不能超过可分配净额），
 * 该校验在 DTO 层做基础范围限制，在 Service 层做业务自洽校验，两层都不可省：
 * DTO 拦住明显非法的输入，Service 拦住「单字段合法但组合不自洽」的情况。
 */
export class CreateContractDto {
  @ApiProperty({ description: '合同标题', maxLength: 200 })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  title!: string;

  @ApiProperty({ description: '达人 ID' })
  @IsUUID('4')
  creatorId!: string;

  @ApiPropertyOptional({ description: '品牌/客户 ID' })
  @IsOptional()
  @IsUUID('4')
  brandId?: string;

  @ApiProperty({ enum: SettlementMode, description: '结算模式' })
  @IsEnum(SettlementMode, { message: '结算模式非法' })
  settlementMode!: SettlementMode;

  @ApiPropertyOptional({ description: '币种，默认 CNY' })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  currency?: string;

  @ApiPropertyOptional({ description: '保底/一口价金额（元，字符串）', example: '5000.00' })
  @IsOptional()
  @Matches(/^\d+(\.\d{1,2})?$/, { message: '金额需为最多两位小数的数字字符串' })
  fixedFee?: string;

  @ApiProperty({ description: '平台抽成（基点，1000 = 10%）', example: 1000 })
  @Type(() => Number)
  @IsInt({ message: '平台抽成必须为整数基点，例如 1000 表示 10%' })
  @Min(0)
  @Max(10_000)
  platformFeeBp!: number;

  @ApiProperty({ description: '公司分成（基点，3000 = 30%）', example: 3000 })
  @Type(() => Number)
  @IsInt({ message: '公司分成必须为整数基点' })
  @Min(0)
  @Max(10_000)
  agencyShareBp!: number;

  @ApiProperty({ description: '达人分成（基点，7000 = 70%）', example: 7000 })
  @Type(() => Number)
  @IsInt({ message: '达人分成必须为整数基点' })
  @Min(0)
  @Max(10_000)
  talentShareBp!: number;

  @ApiProperty({ description: '代扣税率（基点，600 = 6%）', example: 600 })
  @Type(() => Number)
  @IsInt({ message: '代扣税率必须为整数基点' })
  @Min(0)
  @Max(10_000)
  taxWithholdBp!: number;

  @ApiPropertyOptional({ description: 'CPA 单价（元/次转化）' })
  @IsOptional()
  @Matches(/^\d+(\.\d{1,2})?$/, { message: 'CPA 单价需为最多两位小数的数字字符串' })
  cpaUnitPrice?: string;

  @ApiPropertyOptional({ type: [TieredShareDto], description: '阶梯分成规则，命中后覆盖达人分成' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => TieredShareDto)
  tieredShares?: TieredShareDto[];

  @ApiProperty({ description: '生效开始日期（ISO）', example: '2026-01-01' })
  @IsDateString({}, { message: '生效开始日期格式不正确' })
  effectiveFrom!: string;

  @ApiProperty({ description: '生效结束日期（ISO）', example: '2026-12-31' })
  @IsDateString({}, { message: '生效结束日期格式不正确' })
  effectiveTo!: string;

  @ApiPropertyOptional({ description: '是否独家合作' })
  @IsOptional()
  @IsBoolean()
  exclusivity?: boolean;

  @ApiPropertyOptional({ description: '独家范围说明，如「美妆类目」' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  exclusivityScope?: string;

  @ApiPropertyOptional({ description: '交付要求：条数/平台/形式' })
  @IsOptional()
  deliverableSpec?: Record<string, unknown>;

  @ApiPropertyOptional({ description: '违约责任摘要' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  breachClause?: string;

  @ApiPropertyOptional({ type: [String], description: '附件地址列表' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(512, { each: true })
  attachmentUrls?: string[];
}

export class UpdateContractDto extends PartialType(CreateContractDto) {}

export class ApproveContractDto {
  @ApiProperty({ description: 'true 通过并生效；false 驳回退回草稿' })
  @IsBoolean()
  approved!: boolean;

  @ApiPropertyOptional({ description: '审核意见', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class TerminateContractDto {
  @ApiProperty({ description: '终止原因（必填，写入合同备注与审计日志）', maxLength: 500 })
  @IsString()
  @MinLength(2)
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({ description: '存在未结清结算单时是否强制终止（需财务确认）' })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

export class QueryContractDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ContractStatus, isArray: true })
  @ToArray()
  @IsOptional()
  @IsEnum(ContractStatus, { each: true })
  status?: ContractStatus[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('4')
  creatorId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('4')
  brandId?: string;

  @ApiPropertyOptional({ description: '关键词：合同编号/标题/达人姓名' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  keyword?: string;
}

export class PreviewSettlementQueryDto {
  @ApiPropertyOptional({ description: '账期 YYYY-MM', example: '2026-01' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}$/, { message: '账期格式应为 YYYY-MM' })
  month?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  periodStart?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  periodEnd?: string;
}
