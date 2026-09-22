import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser, RequirePermissions } from '../../common/decorators/index';
import type { AuthUser } from '../auth/auth.types';
import { PERMISSIONS } from '../auth/permissions';
import { ContentService } from './content.service';
import {
  CreateContentDto,
  PublishContentDto,
  QueryContentDto,
  ReviewContentDto,
  UpdateContentDto,
} from './dto/content.dto';

@ApiTags('内容管理')
@ApiBearerAuth()
@Controller('contents')
export class ContentController {
  constructor(private readonly contentService: ContentService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.CONTENT_READ)
  @ApiOperation({
    summary: '内容列表',
    description:
      '支持达人/项目/平台/状态多选/关键词与发布时间区间过滤。数据范围经达人归属收敛：商务仅可见自己负责达人的内容。',
  })
  async list(@CurrentUser() user: AuthUser, @Query() query: QueryContentDto) {
    return this.contentService.list(user, query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.CONTENT_READ)
  @ApiOperation({
    summary: '内容详情',
    description: '返回脚本、AI 任务、达人/项目归属、结算明细与状态机可选下一步。',
  })
  async detail(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.contentService.findOne(user, id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.CONTENT_WRITE)
  @Audit({ action: 'CREATE', resource: 'content', summary: '新建内容' })
  @ApiOperation({
    summary: '新建内容',
    description:
      '校验达人可排期状态；项目必须未取消且与内容达人一致；账号必须是该达人在同平台的账号。初始状态仅允许选题/脚本中。',
  })
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateContentDto) {
    return this.contentService.create(user, dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.CONTENT_WRITE)
  @Audit({ action: 'UPDATE', resource: 'content', summary: '编辑内容' })
  @ApiOperation({
    summary: '编辑内容',
    description:
      '已发布内容不允许修改标题/平台/达人（会导致采集数据与结算归因错位）。complianceScore/complianceFlags 供 AI 合规预检回写。状态变更请走状态流转接口。',
  })
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateContentDto,
  ) {
    return this.contentService.update(user, id, dto);
  }

  @Post(':id/submit-review')
  @RequirePermissions(PERMISSIONS.CONTENT_REVIEW)
  @Audit({ action: 'UPDATE', resource: 'content', summary: '提交平台审核' })
  @ApiOperation({
    summary: '提交平台审核',
    description: '内部审核 → 平台审核，按状态机断言流转合法性。',
  })
  async submitReview(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.contentService.submitReview(user, id);
  }

  @Post(':id/review')
  @RequirePermissions(PERMISSIONS.CONTENT_REVIEW)
  @Audit({ action: 'APPROVE', resource: 'content', summary: '内容审核' })
  @ApiOperation({
    summary: '审核内容',
    description:
      'approved=true 时按当前状态推进（内部审核→平台审核，平台审核→已发布并回填发布时间）；false 时置「已驳回」并强制填写原因。记录 reviewerId。',
  })
  async review(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ReviewContentDto,
  ) {
    return this.contentService.review(user, id, dto);
  }

  @Post(':id/publish')
  @RequirePermissions(PERMISSIONS.CONTENT_PUBLISH)
  @Audit({ action: 'PUBLISH', resource: 'content', summary: '发布内容' })
  @ApiOperation({
    summary: '发布内容',
    description: '状态机必须允许到「已发布」；回填平台内容 ID/链接；publishedAt 不传取当前时间（支持补录）。',
  })
  async publish(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: PublishContentDto,
  ) {
    return this.contentService.publish(user, id, dto);
  }

  @Post(':id/sync-metrics')
  @RequirePermissions(PERMISSIONS.METRICS_SYNC)
  @Audit({ action: 'SYNC', resource: 'content', summary: '手动采集内容效果数据' })
  @ApiOperation({
    summary: '同步效果数据',
    description:
      '调用采集器刷新播放/互动/完播/流水。采集失败不抛异常，返回 { success:false, error } 供前端提示重试（单个内容失败不应让整批任务失败）。',
  })
  async syncMetrics(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.contentService.syncMetrics(user, id);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.CONTENT_WRITE)
  @Audit({ action: 'DELETE', resource: 'content', summary: '删除内容（软删除）' })
  @ApiOperation({
    summary: '删除内容',
    description: '软删除；已发布内容或已产生结算明细的内容拒绝删除（保留采集数据与结算归因链路）。',
  })
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.contentService.remove(user, id);
  }
}
