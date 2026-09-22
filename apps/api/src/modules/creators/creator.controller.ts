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
import { CreatorService } from './creator.service';
import {
  AssignCreatorDto,
  BatchImportCreatorDto,
  ChangeCreatorStatusDto,
  CreateCreatorDto,
  EvaluateCreatorDto,
  QueryCreatorDto,
  UpdateCreatorDto,
} from './dto/creator.dto';

@ApiTags('达人管理')
@ApiBearerAuth()
@Controller('creators')
export class CreatorController {
  constructor(private readonly creatorService: CreatorService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.CREATOR_READ)
  @ApiOperation({
    summary: '达人列表',
    description:
      '支持关键词（昵称/真名/手机号/编号/平台昵称）、状态、分级、垂类、平台、负责人、标签、粉丝区间多维筛选。数据范围：商务仅可见自己负责的达人。',
  })
  async list(@CurrentUser() user: AuthUser, @Query() query: QueryCreatorDto) {
    return this.creatorService.list(user, query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.CREATOR_READ)
  @ApiOperation({ summary: '达人详情（含账号矩阵、业务统计、状态机可选动作）' })
  async detail(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.creatorService.findOne(user, id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.CREATOR_WRITE)
  @Audit({ action: 'CREATE', resource: 'creator', summary: '新建达人' })
  @ApiOperation({ summary: '新建达人（可同时录入平台账号）' })
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateCreatorDto) {
    return this.creatorService.create(user, dto);
  }

  @Post('batch-import')
  @RequirePermissions(PERMISSIONS.CREATOR_WRITE)
  @Audit({ action: 'IMPORT', resource: 'creator', summary: '批量导入达人' })
  @ApiOperation({
    summary: '批量导入达人',
    description: '部分成功语义：返回成功条数与逐条失败原因，便于修正后重试。',
  })
  async batchImport(@CurrentUser() user: AuthUser, @Body() dto: BatchImportCreatorDto) {
    return this.creatorService.batchImport(user, dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.CREATOR_WRITE)
  @Audit({ action: 'UPDATE', resource: 'creator', summary: '编辑达人资料' })
  @ApiOperation({ summary: '编辑达人资料（状态变更请用 /status 接口）' })
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateCreatorDto,
  ) {
    return this.creatorService.update(user, id, dto);
  }

  @Patch(':id/status')
  @RequirePermissions(PERMISSIONS.CREATOR_WRITE)
  @Audit({ action: 'UPDATE', resource: 'creator', summary: '变更达人合作状态' })
  @ApiOperation({
    summary: '变更达人合作状态',
    description:
      '按状态机校验流转合法性；解约/拉黑等高风险流转必须填写 reason，并写入备注与审计日志。',
  })
  async changeStatus(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ChangeCreatorStatusDto,
  ) {
    return this.creatorService.changeStatus(user, id, dto.status, dto.reason);
  }

  @Post(':id/evaluate')
  @RequirePermissions(PERMISSIONS.CREATOR_WRITE)
  @Audit({ action: 'UPDATE', resource: 'creator', summary: '达人综合评估打分' })
  @ApiOperation({
    summary: '达人综合评估',
    description: '四维度加权（内容30%/商务30%/配合20%/数据20%）计算综合分并写回。',
  })
  async evaluate(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: EvaluateCreatorDto,
  ) {
    return this.creatorService.evaluate(user, id, dto);
  }

  @Post(':id/assign')
  @RequirePermissions(PERMISSIONS.CREATOR_ASSIGN)
  @Audit({ action: 'UPDATE', resource: 'creator', summary: '达人负责人交接' })
  @ApiOperation({ summary: '分配/交接负责人' })
  async assign(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: AssignCreatorDto,
  ) {
    return this.creatorService.assign(user, id, dto);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.CREATOR_DELETE)
  @Audit({ action: 'DELETE', resource: 'creator', summary: '删除达人（软删除）' })
  @ApiOperation({
    summary: '删除达人',
    description: '软删除；若已关联合同/内容/结算则拒绝，保证业务链路完整。',
  })
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.creatorService.remove(user, id);
  }
}
