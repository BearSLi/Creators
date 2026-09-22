import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthUser } from '../../modules/auth/auth.types';
import type { DataScope, Permission } from '../../modules/auth/permissions';

export const IS_PUBLIC_KEY = 'creatorops:isPublic';
export const PERMISSIONS_KEY = 'creatorops:permissions';
export const PERMISSION_MODE_KEY = 'creatorops:permissionMode';
export const DATA_SCOPE_KEY = 'creatorops:dataScope';

/**
 * 标记接口为公开访问（免登录）。
 * 仅用于登录、刷新令牌、健康检查、Swagger 文档等极少数接口。
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * 声明接口所需权限点。默认「全部满足」，可用 mode='any' 放宽为「任一满足」。
 * 例：@RequirePermissions(PERMISSIONS.CREATOR_READ)
 *     @RequirePermissions(PERMISSIONS.SETTLEMENT_EDIT, PERMISSIONS.SETTLEMENT_APPROVE)
 */
export const RequirePermissions = (required: Permission | Permission[], mode: 'all' | 'any' = 'all') =>
  (target: object, key?: string | symbol, descriptor?: PropertyDescriptor) => {
    SetMetadata(PERMISSIONS_KEY, Array.isArray(required) ? required : [required])(
      target,
      key as string,
      descriptor as PropertyDescriptor,
    );
    SetMetadata(PERMISSION_MODE_KEY, mode)(target, key as string, descriptor as PropertyDescriptor);
  };

/**
 * 声明接口的数据范围要求，供 Service 层读取并拼装 where 条件。
 * ALL=全部，TEAM=本团队，OWN=仅自己负责。
 */
export const DataScopeRule = (scope: DataScope) => SetMetadata(DATA_SCOPE_KEY, scope);

/**
 * 从请求上下文取出当前登录用户。
 * 用法：@CurrentUser() user: AuthUser ，或 @CurrentUser('id') userId: string
 */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<{ user?: AuthUser }>();
    const user = request.user;
    if (!user) return undefined;
    return field ? user[field] : user;
  },
);
