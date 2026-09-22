import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsBooleanString, IsDateString, IsOptional, IsString, IsUUID } from 'class-validator';
import { RequirePermissions } from '../../common/decorators/index';
import { PaginationQueryDto } from '../../common/utils/pagination';
import { PERMISSIONS } from '../auth/permissions';
import { AuditService } from './audit.service';

class AuditQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID('4', { message: 'userId 需为 UUID' })
  userId?: string;

  @IsOptional()
  @IsString()
  resource?: string;

  @IsOptional()
  @IsString()
  resourceId?: string;

  @IsOptional()
  @IsString()
  action?: string;

  @IsOptional()
  @IsBooleanString()
  success?: string;

  @IsOptional()
  @IsDateString({}, { message: 'from 需为 ISO 日期字符串' })
  from?: string;

  @IsOptional()
  @IsDateString({}, { message: 'to 需为 ISO 日期字符串' })
  to?: string;
}

@ApiTags('审计日志')
@ApiBearerAuth()
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.AUDIT_READ)
  @ApiOperation({ summary: '查询审计日志（支持按人/资源/动作/时间过滤）' })
  async list(@Query() query: AuditQueryDto) {
    return this.auditService.query({
      page: query.page,
      pageSize: query.pageSize,
      userId: query.userId,
      resource: query.resource,
      resourceId: query.resourceId,
      action: query.action,
      success: query.success === undefined ? undefined : query.success === 'true',
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    });
  }

  @Get(':resource/:id/timeline')
  @RequirePermissions(PERMISSIONS.AUDIT_READ)
  @ApiOperation({ summary: '某条业务资源的完整操作记录（详情页操作记录）' })
  async timeline(
    @Param('resource') resource: string,
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    return this.auditService.timelineFor(resource, id, limit ? Number.parseInt(limit, 10) : 50);
  }
}
