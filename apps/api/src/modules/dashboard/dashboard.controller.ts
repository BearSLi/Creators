import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { CurrentUser, RequirePermissions } from '../../common/decorators/index';
import type { AuthUser } from '../auth/auth.types';
import { PERMISSIONS } from '../auth/permissions';
import { DashboardService } from './dashboard.service';

class OverviewQueryDto {
  @IsOptional()
  @IsDateString({}, { message: 'from 需为 ISO 日期' })
  from?: string;

  @IsOptional()
  @IsDateString({}, { message: 'to 需为 ISO 日期' })
  to?: string;
}

class RankingQueryDto extends OverviewQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 10;

  @IsOptional()
  @IsIn(['revenue', 'content', 'view'])
  metric: 'revenue' | 'content' | 'view' = 'revenue';
}

@ApiTags('经营看板')
@ApiBearerAuth()
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('overview')
  @RequirePermissions(PERMISSIONS.DASHBOARD_READ)
  @ApiOperation({
    summary: '经营看板总览',
    description:
      'KPI、达人合作漏斗（累计口径）、流水趋势、平台/垂类分布、头部达人、待办事项。默认统计近 30 天。',
  })
  async overview(@CurrentUser() user: AuthUser, @Query() query: OverviewQueryDto) {
    const to = query.to ? new Date(query.to) : undefined;
    return this.dashboardService.overview(user, {
      from: query.from ? new Date(query.from) : undefined,
      to,
    });
  }

  @Get('creator-ranking')
  @RequirePermissions(PERMISSIONS.DASHBOARD_READ)
  @ApiOperation({ summary: '达人贡献榜（可按流水/内容数/播放量排序）' })
  async ranking(@CurrentUser() user: AuthUser, @Query() query: RankingQueryDto) {
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - 29 * 86_400_000);
    return this.dashboardService.creatorRanking(user, {
      from,
      to,
      limit: query.limit,
      metric: query.metric,
    });
  }
}
