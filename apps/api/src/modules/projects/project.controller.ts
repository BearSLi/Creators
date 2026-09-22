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
import {
  ChangeProjectStatusDto,
  CreateProjectDto,
  QueryProjectDto,
  UpdateProjectDto,
} from './dto/project.dto';
import { ProjectService } from './project.service';

@ApiTags('项目管理')
@ApiBearerAuth()
@Controller('projects')
export class ProjectController {
  constructor(private readonly projectService: ProjectService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.PROJECT_READ)
  @ApiOperation({
    summary: '项目列表',
    description:
      '支持状态多选、品牌、达人与关键词（项目名/编号/品牌名/达人名）过滤。数据范围：商务仅可见自己负责的项目（或自己达人的项目）。',
  })
  async list(@CurrentUser() user: AuthUser, @Query() query: QueryProjectDto) {
    return this.projectService.list(user, query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.PROJECT_READ)
  @ApiOperation({
    summary: '项目详情',
    description: '返回最多 100 条内容、预算/实际成本/成本率与内容流水汇总，以及状态机可选下一步。',
  })
  async detail(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.projectService.findOne(user, id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.PROJECT_WRITE)
  @Audit({ action: 'CREATE', resource: 'project', summary: '新建项目' })
  @ApiOperation({
    summary: '新建项目',
    description:
      '校验达人可排期状态、合同归属达人一致性、品牌与负责人有效性、截止日晚于开始日；项目编号在事务内分配。',
  })
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateProjectDto) {
    return this.projectService.create(user, dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.PROJECT_WRITE)
  @Audit({ action: 'UPDATE', resource: 'project', summary: '编辑项目' })
  @ApiOperation({
    summary: '编辑项目',
    description: '已结项/已取消的项目不允许修改（保留历史成本口径）。状态变更请走 /status 接口。',
  })
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateProjectDto,
  ) {
    return this.projectService.update(user, id, dto);
  }

  @Post(':id/status')
  @RequirePermissions(PERMISSIONS.PROJECT_WRITE)
  @Audit({ action: 'UPDATE', resource: 'project', summary: '变更项目状态' })
  @ApiOperation({
    summary: '变更项目状态',
    description:
      '按状态机校验流转；变更为「已结项」时回填 completedAt；变更为「已取消」必须填写 reason（原因写入审计日志）。',
  })
  async changeStatus(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ChangeProjectStatusDto,
  ) {
    return this.projectService.changeStatus(user, id, dto);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.PROJECT_WRITE)
  @Audit({ action: 'DELETE', resource: 'project', summary: '删除项目（软删除）' })
  @ApiOperation({
    summary: '删除项目',
    description: '软删除；存在未终止内容（非「已驳回/已下线」）时拒绝，并给出内容条数。',
  })
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.projectService.remove(user, id);
  }
}
