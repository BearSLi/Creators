import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserRole, UserStatus } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../../common/utils/pagination';

export class CreateUserDto {
  @ApiProperty({ description: '登录邮箱（全局唯一）', maxLength: 128 })
  @IsEmail({}, { message: '邮箱格式不正确' })
  @MaxLength(128)
  email!: string;

  @ApiProperty({ description: '员工姓名', maxLength: 64 })
  @IsString()
  @Length(1, 64)
  name!: string;

  @ApiPropertyOptional({
    description:
      '初始密码。不传则由服务端生成随机初始密码（响应中返回一次）。密码强度：≥10 位且含大小写/数字/符号中的至少三类',
    minLength: 10,
    maxLength: 72,
  })
  @IsOptional()
  @IsString()
  @MinLength(10, { message: '密码长度至少 10 位' })
  @MaxLength(72, { message: '密码长度不能超过 72 字节（bcrypt 上限）' })
  password?: string;

  @ApiProperty({ enum: UserRole, description: '角色' })
  @IsEnum(UserRole)
  role!: UserRole;

  @ApiPropertyOptional({ description: '所属团队 ID' })
  @IsOptional()
  @IsUUID('4')
  teamId?: string;

  @ApiPropertyOptional({ description: '手机号' })
  @IsOptional()
  @Matches(/^1[3-9]\d{9}$|^\+\d{6,15}$/, { message: '手机号格式不正确' })
  phone?: string;
}

export class UpdateUserDto {
  @ApiPropertyOptional({ description: '员工姓名' })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  name?: string;

  @ApiPropertyOptional({ description: '手机号' })
  @IsOptional()
  @Matches(/^1[3-9]\d{9}$|^\+\d{6,15}$/, { message: '手机号格式不正确' })
  phone?: string;

  @ApiPropertyOptional({ description: '头像地址' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  avatarUrl?: string;

  @ApiPropertyOptional({ description: '所属团队 ID，传 null 表示移出团队' })
  @IsOptional()
  @IsUUID('4')
  teamId?: string | null;

  @ApiPropertyOptional({ enum: UserStatus, description: '账号状态' })
  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  @ApiPropertyOptional({
    enum: UserRole,
    description: '角色。禁止通过本接口修改自己的角色（防呆：避免管理员把自己降权后无人能管理系统）',
  })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;
}

export class ChangeUserStatusDto {
  @ApiProperty({ enum: UserStatus, description: '目标状态' })
  @IsEnum(UserStatus)
  status!: UserStatus;
}

export class UpdateUserPermissionsDto {
  @ApiProperty({
    type: [String],
    description:
      '权限覆盖项：合法权限码表示额外授予，"-" 前缀表示从角色默认权限中撤销（撤销优先于授予）。非法项会被整体拒绝并列明。',
    example: ['creator:export', '-settlement:export'],
  })
  @IsArray()
  @ArrayMaxSize(200, { message: '权限覆盖项过多，请确认是否误传' })
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  permissionOverrides!: string[];
}

/** 员工列表查询条件。该接口只对管理员开放，不做数据范围收敛 */
export class QueryUserDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: UserRole, description: '角色过滤' })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @ApiPropertyOptional({ enum: UserStatus, description: '状态过滤' })
  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  @ApiPropertyOptional({ description: '关键词：姓名/邮箱/手机号' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  keyword?: string;
}
