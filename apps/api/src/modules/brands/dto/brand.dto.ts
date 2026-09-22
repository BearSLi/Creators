import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/utils/pagination';

/**
 * 客户等级。
 *
 * 为什么用字符串常量而不是枚举落库：等级口径是「商务/财务可以讨论着改」的业务规则
 * （比如新增「S+ 战略客户」），改枚举要动数据库类型与迁移；这里收敛成一处常量 + DTO 白名单，
 * 新等级只需在这里加一项，历史数据不会被约束卡住。
 * 等级直接参与报价与账期决策，所以非法等级必须在入口拦住，不能落库成脏值。
 */
export const BRAND_LEVELS = ['S', 'A', 'B', 'C', 'D'] as const;
export type BrandLevel = (typeof BRAND_LEVELS)[number];

export const BRAND_LEVEL_LABELS: Record<BrandLevel, string> = {
  S: 'S 级（战略客户）',
  A: 'A 级（重点客户）',
  B: 'B 级（常规客户）',
  C: 'C 级（小额/试单）',
  D: 'D 级（观察客户）',
};

export class CreateBrandDto {
  @ApiProperty({ description: '品牌/客户名称，全局唯一', maxLength: 128 })
  @IsString()
  @Length(1, 128, { message: '品牌名称长度需在 1-128 之间' })
  name!: string;

  @ApiPropertyOptional({ description: '所属行业，如 美妆/游戏/短剧', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  industry?: string;

  @ApiPropertyOptional({ description: '对接人姓名', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  contactName?: string;

  @ApiPropertyOptional({ description: '对接人电话（手机或座机，允许 - ( ) 空格）' })
  @IsOptional()
  @Matches(/^[\d+\-() ]{5,32}$/, { message: '联系电话格式不正确' })
  contactPhone?: string;

  @ApiPropertyOptional({ enum: BRAND_LEVELS, description: '客户等级，默认 B' })
  @IsOptional()
  @IsIn(BRAND_LEVELS as unknown as string[], { message: `level 只能是 ${BRAND_LEVELS.join('/')}` })
  level?: BrandLevel;

  @ApiPropertyOptional({ description: '默认账期天数（合同可覆盖）', minimum: 0, maximum: 365 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'paymentTermDays 必须为整数' })
  @Min(0)
  @Max(365, { message: '账期不得超过 365 天，超长账期请走专项审批' })
  paymentTermDays?: number;

  @ApiPropertyOptional({ description: '发票抬头', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  invoiceTitle?: string;

  @ApiPropertyOptional({ description: '纳税人识别号', maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  taxNo?: string;

  @ApiPropertyOptional({ description: '备注（报价习惯、决策链等）', maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  remark?: string;
}

export class UpdateBrandDto extends PartialType(CreateBrandDto) {}

/** 品牌列表查询条件：与品牌管理页筛选栏一一对应 */
export class QueryBrandDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '关键词：品牌名/对接人/发票抬头' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  keyword?: string;

  @ApiPropertyOptional({ enum: BRAND_LEVELS, description: '客户等级精确过滤' })
  @IsOptional()
  @IsIn(BRAND_LEVELS as unknown as string[])
  level?: BrandLevel;
}
