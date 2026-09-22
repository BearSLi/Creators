import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { env } from '../../config/index';
import { CurrentUser, Public } from '../../common/decorators/index';
import { AuthService } from './auth.service';
import type { AuthUser, LoginResult } from './auth.types';
import { ChangePasswordDto, LoginDto, RefreshTokenDto } from './dto/auth.dto';

@ApiTags('认证')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  // 登录接口单独收紧限流，抵御撞库；按 IP 维度
  @Throttle({ default: { limit: env.LOGIN_THROTTLE_LIMIT, ttl: env.THROTTLE_TTL_SECONDS * 1000 } })
  @ApiOperation({
    summary: '账号密码登录',
    description: '返回 access/refresh 令牌与当前用户权限集合。连续 5 次失败锁定账号 15 分钟。',
  })
  async login(@Body() dto: LoginDto, @Req() request: Request): Promise<LoginResult> {
    return this.authService.login(dto.email, dto.password, {
      ip: clientIp(request),
      userAgent: request.headers['user-agent'],
    });
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '刷新令牌',
    description: 'refresh token 轮换：旧令牌立即失效，检测到重放会撤销整个会话族。',
  })
  async refresh(@Body() dto: RefreshTokenDto, @Req() request: Request): Promise<LoginResult> {
    return this.authService.refresh(dto.refreshToken, {
      ip: clientIp(request),
      userAgent: request.headers['user-agent'],
    });
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: '退出登录（撤销当前设备会话）' })
  async logout(@CurrentUser() user: AuthUser): Promise<{ revoked: number }> {
    return this.authService.logout(user.id, user.sessionId);
  }

  @Get('profile')
  @ApiBearerAuth()
  @ApiOperation({ summary: '获取当前登录用户信息与权限集合' })
  async profile(@CurrentUser('id') userId: string) {
    return this.authService.profile(userId);
  }

  @Patch('password')
  @ApiBearerAuth()
  @ApiOperation({
    summary: '修改密码',
    description: '校验原密码与强度后，撤销该用户全部会话，需重新登录。',
  })
  async changePassword(
    @CurrentUser('id') userId: string,
    @Body() dto: ChangePasswordDto,
  ): Promise<{ revokedSessions: number }> {
    return this.authService.changePassword(userId, dto.oldPassword, dto.newPassword);
  }
}

/** 取真实客户端 IP：受信任代理场景下优先 X-Forwarded-For 首个地址 */
function clientIp(request: Request): string | undefined {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0]!.trim();
  }
  return request.ip ?? request.socket?.remoteAddress ?? undefined;
}
