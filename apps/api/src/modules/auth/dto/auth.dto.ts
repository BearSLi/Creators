import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'ops@juxingzhimei.com', description: '企业邮箱' })
  @IsEmail({}, { message: '请输入合法的邮箱地址' })
  @MaxLength(128)
  email!: string;

  @ApiProperty({ example: 'CreatorOps@2024', description: '登录密码' })
  @IsString()
  @IsNotEmpty({ message: '密码不能为空' })
  @MaxLength(128)
  password!: string;
}

export class RefreshTokenDto {
  @ApiProperty({ description: '登录或上一次刷新返回的 refreshToken' })
  @IsString()
  @IsNotEmpty({ message: 'refreshToken 不能为空' })
  refreshToken!: string;
}

export class ChangePasswordDto {
  @ApiProperty({ description: '原密码' })
  @IsString()
  @IsNotEmpty({ message: '原密码不能为空' })
  oldPassword!: string;

  @ApiProperty({ description: '新密码：至少 10 位，含大小写/数字/符号中至少三类' })
  @IsString()
  @MinLength(10, { message: '新密码长度至少 10 位' })
  @MaxLength(128)
  newPassword!: string;
}

export class UpdateProfileDto {
  @ApiPropertyOptional({ description: '姓名', maxLength: 64 })
  @IsString()
  @MaxLength(64)
  name?: string;

  @ApiPropertyOptional({ description: '手机号' })
  @IsString()
  @MaxLength(32)
  phone?: string;

  @ApiPropertyOptional({ description: '头像地址', maxLength: 512 })
  @IsString()
  @MaxLength(512)
  avatarUrl?: string;
}
