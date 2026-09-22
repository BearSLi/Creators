import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DATA_SCOPE_KEY, PERMISSIONS_KEY, PERMISSION_MODE_KEY } from '../../../common/decorators/auth.decorators';
import { PermissionDeniedException } from '../../../common/exceptions/business.exception';
import type { AuthUser } from '../auth.types';
import { Permission } from '../permissions';

/**
 * 功能权限守卫：校验当前用户是否拥有接口所需权限点。
 *
 * 与 JwtAuthGuard 的配合：JwtAuthGuard 负责「你是谁」，本守卫负责「你能不能」。
 * 注意：本守卫不负责数据范围，那属于 Service 层的 where 条件拼装（见 scope.ts）。
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    const user = request.user;
    if (!user) throw new PermissionDeniedException('未获取到登录用户信息');

    const mode = this.reflector.getAllAndOverride<'all' | 'any'>(PERMISSION_MODE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) ?? 'all';

    const satisfied =
      mode === 'any'
        ? required.some((permission) => user.permissions.has(permission))
        : required.every((permission) => user.permissions.has(permission));

    if (!satisfied) {
      throw new PermissionDeniedException(
        `当前角色（${user.role}）缺少权限：${required.join(', ')}`,
        { required, mode, role: user.role },
      );
    }
    return true;
  }
}

/** 数据范围读取（供 Service 层使用，不做拦截，只作为元数据声明） */
export const dataScopeKey = DATA_SCOPE_KEY;
