import { api, buildParams } from './client';
import type {
  CreateUserRequest,
  CreateUserResponse,
  Paginated,
  ResetPasswordResponse,
  UpdateUserRequest,
  UserListItem,
  UserListQuery,
  UserPermissionCatalogItem,
  UserRoleDefinition,
  UserStatus,
} from './types';

/**
 * 员工与角色权限接口。
 *
 * 权限覆盖（permissionOverrides）语义与后端一致：
 *   'creator:write'   → 额外授予
 *   '-creator:export' → 撤销角色自带权限（最小权限原则下的临时收权）
 */

export function listUsers(query: UserListQuery = {}): Promise<Paginated<UserListItem>> {
  return api.get<Paginated<UserListItem>>('/users', buildParams(query));
}

export function createUser(body: CreateUserRequest): Promise<CreateUserResponse> {
  return api.post<CreateUserResponse>('/users', body);
}

export function updateUser(id: string, body: UpdateUserRequest): Promise<UserListItem> {
  return api.patch<UserListItem>(`/users/${id}`, body);
}

/** 重置密码：后端只在此刻返回一次明文初始密码，页面必须引导用户立即复制 */
export function resetUserPassword(id: string): Promise<ResetPasswordResponse> {
  return api.post<ResetPasswordResponse>(`/users/${id}/reset-password`);
}

export function updateUserStatus(id: string, status: UserStatus): Promise<UserListItem> {
  return api.post<UserListItem>(`/users/${id}/status`, { status });
}

export function updateUserPermissions(
  id: string,
  permissionOverrides: string[],
): Promise<UserListItem> {
  return api.patch<UserListItem>(`/users/${id}/permissions`, { permissionOverrides });
}

/** 权限点目录：用于角色编辑页渲染带分组与风险等级的勾选框 */
export function getPermissionCatalog(): Promise<UserPermissionCatalogItem[]> {
  return api.get<UserPermissionCatalogItem[]>('/users/permissions/catalog');
}

export function getRoles(): Promise<UserRoleDefinition[]> {
  return api.get<UserRoleDefinition[]>('/users/roles');
}
