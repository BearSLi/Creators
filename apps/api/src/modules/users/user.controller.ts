import {
  Body,
  Controller,
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
  ChangeUserStatusDto,
  CreateUserDto,
  QueryUserDto,
  UpdateUserDto,
  UpdateUserPermissionsDto,
} from './dto/user.dto';
import { UserService } from './user.service';

@ApiTags('员工与权限')
@ApiBearerAuth()
@Controller('users')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.USER_READ)
  @ApiOperation({
    summary: '员工列表',
    description: '支持角色、状态与关键词（姓名/邮箱/手机号）过滤。仅管理员可见。',
  })
  async list(@CurrentUser() user: AuthUser, @Query() query: QueryUserDto) {
    return this.userService.list(user, query);
  }

  // 静态路径必须先于任何 :id 路径声明，否则会被当成 id 参数吃掉（Nest 按声明顺序匹配）
  @Get('permissions/catalog')
  @RequirePermissions(PERMISSIONS.USER_READ)
  @ApiOperation({
    summary: '权限点目录',
    description: '返回全部权限点及其中文名、所属分组与风险等级（高风险权限需重点复核），按分组排序。',
  })
  async permissionCatalog() {
    return this.userService.permissionCatalog();
  }

  @Get('roles')
  @RequirePermissions(PERMISSIONS.USER_READ)
  @ApiOperation({
    summary: '角色目录',
    description: '返回每个角色的默认权限点与默认数据范围（ALL/TEAM/OWN），用于权限矩阵可视化。',
  })
  async roleCatalog() {
    return this.userService.roleCatalog();
  }

  @Get('teams')
  @RequirePermissions(PERMISSIONS.USER_READ)
  @ApiOperation({ summary: '团队树', description: '返回 Team 自关联的嵌套结构，供组织架构与筛选器使用。' })
  async teams() {
    return this.userService.teamTree();
  }

  @Post()
  @RequirePermissions(PERMISSIONS.USER_WRITE)
  @Audit({ action: 'CREATE', resource: 'user', summary: '新建员工账号' })
  @ApiOperation({
    summary: '新建员工',
    description:
      '不传 password 时服务端生成强随机初始密码，并在响应中返回一次（库中只存 bcrypt 哈希，之后无法取回，请管理员当场保存）。',
  })
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateUserDto) {
    return this.userService.create(user, dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.USER_WRITE)
  @Audit({ action: 'UPDATE', resource: 'user', summary: '编辑员工资料' })
  @ApiOperation({
    summary: '编辑员工资料',
    description:
      '可改姓名/手机号/头像/团队/状态/角色。禁止修改自己的角色、禁止禁用自己的账号（防呆）。改为禁用时会撤销该员工全部会话。',
  })
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateUserDto,
  ) {
    return this.userService.update(user, id, dto);
  }

  @Post(':id/status')
  @RequirePermissions(PERMISSIONS.USER_WRITE)
  @Audit({ action: 'UPDATE', resource: 'user', summary: '变更员工账号状态' })
  @ApiOperation({
    summary: '变更账号状态',
    description:
      '禁用时同步调用 revokeAllSessions 撤销该员工全部会话，避免其用旧 refresh token 继续换发 access token（否则禁用形同虚设）。',
  })
  async changeStatus(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ChangeUserStatusDto,
  ) {
    return this.userService.changeStatus(user, id, dto.status);
  }

  @Post(':id/reset-password')
  @RequirePermissions(PERMISSIONS.USER_WRITE)
  @Audit({ action: 'UPDATE', resource: 'user', summary: '重置员工密码' })
  @ApiOperation({
    summary: '重置密码',
    description: '生成新的随机初始密码（仅本次响应返回）并撤销该员工全部会话，强制其用新密码重新登录。',
  })
  async resetPassword(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.userService.resetPassword(user, id);
  }

  @Patch(':id/permissions')
  @RequirePermissions(PERMISSIONS.ROLE_MANAGE)
  @Audit({ action: 'UPDATE', resource: 'user', summary: '变更员工权限覆盖' })
  @ApiOperation({
    summary: '变更员工权限',
    description:
      'permissionOverrides 中合法权限码表示额外授予，"-" 前缀表示撤销（撤销优先）。非法项整体拒绝并列明。变更后撤销该员工全部会话：access token 内嵌权限最长有 2h 滞后，必须重新登录才生效。',
  })
  async updatePermissions(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateUserPermissionsDto,
  ) {
    return this.userService.updatePermissions(user, id, dto);
  }
}
