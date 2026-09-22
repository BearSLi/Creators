import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { ContentVertical, CreatorStatus, CreatorTier, DataSourceType, Platform } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto, ToArray } from '../../../common/utils/pagination';

export class PlatformAccountDto {
  @ApiProperty({ enum: Platform, description: '平台' })
  @IsEnum(Platform)
  platform!: Platform;

  @ApiProperty({ description: '平台昵称', maxLength: 128 })
  @IsString()
  @MaxLength(128)
  nickname!: string;

  @ApiProperty({ description: '平台内唯一 ID（抖音 sec_uid / 小红书 user_id）', maxLength: 128 })
  @IsString()
  @MaxLength(128)
  platformUid!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(512)
  profileUrl?: string;

  @ApiPropertyOptional({ description: '主页链接' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  homeUrl?: string;

  @ApiPropertyOptional({ description: '粉丝数', minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(2_000_000_000)
  followerCount?: number;

  @ApiPropertyOptional({ description: '是否主账号（达人主页展示用）' })
  @IsOptional()
  isPrimary?: boolean;

  @ApiPropertyOptional({ enum: DataSourceType })
  @IsOptional()
  @IsEnum(DataSourceType)
  dataSource?: DataSourceType;
}

export class CreateCreatorDto {
  @ApiProperty({ description: '达人昵称/艺名', maxLength: 64 })
  @IsString()
  @Length(1, 64)
  name!: string;

  @ApiPropertyOptional({ description: '真实姓名（敏感，需 creator:sensitive:read 权限查看）' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  realName?: string;

  @ApiPropertyOptional({ description: '证件号（服务端加密存储）' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  idCard?: string;

  @ApiPropertyOptional({ description: '手机号' })
  @IsOptional()
  @Matches(/^1[3-9]\d{9}$|^\+\d{6,15}$/, { message: '手机号格式不正确' })
  phone?: string;

  @ApiPropertyOptional({ description: '微信号' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  wechat?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail({}, { message: '邮箱格式不正确' })
  @MaxLength(128)
  email?: string;

  @ApiPropertyOptional({ description: '常驻城市' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  city?: string;

  @ApiPropertyOptional({ enum: CreatorStatus, description: '初始状态，默认 LEAD' })
  @IsOptional()
  @IsEnum(CreatorStatus)
  status?: CreatorStatus;

  @ApiPropertyOptional({ enum: CreatorTier, description: '达人分级，默认 C' })
  @IsOptional()
  @IsEnum(CreatorTier)
  tier?: CreatorTier;

  @ApiPropertyOptional({ enum: ContentVertical, isArray: true, description: '内容垂类' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsEnum(ContentVertical, { each: true })
  verticals?: ContentVertical[];

  @ApiPropertyOptional({ type: [String], description: '人设/风格标签，用于 AI 匹配' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(24, { each: true })
  styleTags?: string[];

  @ApiPropertyOptional({ description: '机构合作类型：FULL_MCN / COMMERCIAL / INDEPENDENT' })
  @IsOptional()
  @IsIn(['FULL_MCN', 'COMMERCIAL', 'INDEPENDENT'])
  agencyType?: string;

  @ApiPropertyOptional({ description: '所属 MCN 机构名' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  agencyName?: string;

  @ApiPropertyOptional({ description: '招募渠道：DOUYIN_DM / REFERRAL / OFFLINE / SCHOOL ...' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sourceChannel?: string;

  @ApiPropertyOptional({ description: '综合评估分 0-100', minimum: 0, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  score?: number;

  @ApiPropertyOptional({ description: '负责人（员工）ID' })
  @IsOptional()
  @IsUUID('4')
  ownerId?: string;

  @ApiPropertyOptional({ description: '所属团队 ID' })
  @IsOptional()
  @IsUUID('4')
  teamId?: string;

  @ApiPropertyOptional({ description: '标签 ID 列表' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('4', { each: true })
  tagIds?: string[];

  @ApiPropertyOptional({ description: '备注' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  remark?: string;

  @ApiPropertyOptional({ description: '档期与合作偏好（结构化）' })
  @IsOptional()
  availability?: Record<string, unknown>;

  @ApiPropertyOptional({ type: [PlatformAccountDto], description: '平台账号（可一起创建）' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => PlatformAccountDto)
  accounts?: PlatformAccountDto[];
}

export class UpdateCreatorDto extends PartialType(CreateCreatorDto) {}

export class ChangeCreatorStatusDto {
  @ApiProperty({ enum: CreatorStatus, description: '目标状态' })
  @IsEnum(CreatorStatus)
  status!: CreatorStatus;

  @ApiPropertyOptional({
    description: '变更原因。黑名单/解约等高风险流转必填，用于审计追溯',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class AssignCreatorDto {
  @ApiProperty({ description: '负责人 ID' })
  @IsUUID('4')
  ownerId!: string;

  @ApiPropertyOptional({ description: '交接说明，会写入审计日志' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class EvaluateCreatorDto {
  @ApiProperty({ description: '内容能力 0-100' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  contentScore!: number;

  @ApiProperty({ description: '商业化能力 0-100' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  commercialScore!: number;

  @ApiProperty({ description: '配合度 0-100' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  cooperationScore!: number;

  @ApiProperty({ description: '数据表现 0-100' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  dataScore!: number;

  @ApiPropertyOptional({ description: '评估备注' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  remark?: string;
}

/** 达人列表查询条件：达人库页面的筛选栏一一对应 */
export class QueryCreatorDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '关键词：昵称/真实姓名/手机号/编号/平台昵称' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  keyword?: string;

  @ApiPropertyOptional({ enum: CreatorStatus, isArray: true })
  @ToArray()
  @IsOptional()
  @IsEnum(CreatorStatus, { each: true })
  status?: CreatorStatus[];

  @ApiPropertyOptional({ enum: CreatorTier, isArray: true })
  @ToArray()
  @IsOptional()
  @IsEnum(CreatorTier, { each: true })
  tier?: CreatorTier[];

  @ApiPropertyOptional({ enum: ContentVertical, isArray: true })
  @ToArray()
  @IsOptional()
  @IsEnum(ContentVertical, { each: true })
  vertical?: ContentVertical[];

  @ApiPropertyOptional({ enum: Platform, description: '按平台过滤（账号维度）' })
  @IsOptional()
  @IsEnum(Platform)
  platform?: Platform;

  @ApiPropertyOptional({ description: '负责人 ID' })
  @IsOptional()
  @IsUUID('4')
  ownerId?: string;

  @ApiPropertyOptional({ description: '标签 ID' })
  @IsOptional()
  @IsUUID('4')
  tagId?: string;

  @ApiPropertyOptional({ description: '最低粉丝数（取该达人最高粉丝账号）' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minFollowers?: number;

  @ApiPropertyOptional({ description: '最高粉丝数' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxFollowers?: number;

  @ApiPropertyOptional({ description: '最低评估分' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  minScore?: number;

  @ApiPropertyOptional({ description: '招募渠道' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sourceChannel?: string;
}

export class BatchImportCreatorDto {
  @ApiProperty({ type: [CreateCreatorDto], description: '批量导入的达人数组（最多 200 条）' })
  @IsArray()
  @ArrayMaxSize(200, { message: '单次最多导入 200 条' })
  @ValidateNested({ each: true })
  @Type(() => CreateCreatorDto)
  items!: CreateCreatorDto[];

  @ApiPropertyOptional({ description: '全部导入到该负责人名下' })
  @IsOptional()
  @IsUUID('4')
  ownerId?: string;
}
