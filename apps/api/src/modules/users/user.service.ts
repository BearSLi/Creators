import { Injectable, Logger } from '@nestjs/common';
import { Prisma, UserRole, UserStatus } from '@prisma/client';
import {
  BusinessException,
  DuplicateOperationException,
  ResourceNotFoundException,
  UnprocessableException,
} from '../../common/exceptions/business.exception';
import { buildPaginated, PaginatedResult, resolveOrderBy } from '../../common/utils/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import type { AuthUser } from '../auth/auth.types';
import {
  ALL_PERMISSIONS,
  PERMISSION_META,
  Permission,
  ROLE_DATA_SCOPE,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  resolvePermissions,
} from '../auth/permissions';
import {
  CreateUserDto,
  QueryUserDto,
  UpdateUserDto,
  UpdateUserPermissionsDto,
} from './dto/user.dto';

/**
 * 员工与权限管理服务。
 *
 * 业务定位：员工账号是「谁能操作系统、能看到多少钱」的源头，因此本模块只在管理员权限下开放
 * （USER_READ 查看 / USER_WRITE 维护 / ROLE_MANAGE 改权限），且所有会影响登录态的操作
 * 都必须连带撤销会话——这一点是本模块最重要的业务规则：
 *
 *   access token 里内嵌了权限快照（见 AuthService.issueTokens），默认 TTL 2 小时。
 *   如果禁用账号、重置密码、变更权限后不撤销 refresh token，被处理的人仍可用旧 token
 *   继续操作最长 2 小时——禁用就成了摆设，权限收回也形同虚设。
 *   所以本模块的禁用/重置/改权限三条路径都会调用 authService.revokeAllSessions()。
 *
 * 另一类是「防呆」规则：管理员不允许通过自助接口改自己的角色/权限/禁用自己。
 * 这不是权限问题（管理员本来就有权限），而是可用性问题：一旦把自己降权且系统里没有
 * 第二个管理员，整个系统就再也没人能改回来了，只能改库救火。
 */
@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
  ) {}

  /** 员工列表。仅管理员可见，不做数据范围收敛（否则管理员会看不到下属） */
  async list(_user: AuthUser, query: QueryUserDto): Promise<PaginatedResult<UserListItem>> {
    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      role: query.role,
      status: query.status,
    };

    if (query.keyword) {
      const keyword = query.keyword.trim();
      where.OR = [
        { name: { contains: keyword, mode: 'insensitive' } },
        { email: { contains: keyword, mode: 'insensitive' } },
        { phone: { contains: keyword } },
      ];
    }

    const orderBy = resolveOrderBy(
      query.sortBy,
      query.sortOrder,
      ['createdAt', 'updatedAt', 'name', 'email', 'lastLoginAt', 'role', 'status'] as const,
      'createdAt',
    );

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        orderBy,
        skip: query.skip,
        take: query.take,
        include: { team: { select: { id: true, name: true } } },
      }),
      this.prisma.user.count({ where }),
    ]);

    return buildPaginated(
      rows.map((row) => this.toListItem(row)),
      total,
      query.page,
      query.pageSize,
    );
  }

  /**
   * 新建员工。
   *
   * 初始密码策略：管理员可以不传密码，由服务端生成一个强随机初始密码，
   * 在响应里返回一次。库中只存 bcrypt 哈希，因此这个明文「只返回一次」是物理事实：
   * 之后无论谁调用任何接口都无法再取回，只能重置。这也是为什么前端必须提示管理员当场保存。
   */
  async create(
    user: AuthUser,
    dto: CreateUserDto,
  ): Promise<UserDetail & { initialPassword: string }> {
    await this.assertEmailAvailable(dto.email);
    if (dto.phone) await this.assertPhoneAvailable(dto.phone);
    if (dto.teamId) await this.assertTeamExists(dto.teamId);

    const plainPassword = dto.password ?? this.authService.generateInitialPassword();
    // hashPassword 内部会做密码强度校验（长度/字符类别/重复字符），弱密码在这里直接 400
    const passwordHash = await this.authService.hashPassword(plainPassword);

    const created = await this.createUserRow({
      email: dto.email.trim().toLowerCase(),
      name: dto.name,
      phone: dto.phone ?? null,
      role: dto.role,
      teamId: dto.teamId ?? null,
      passwordHash,
    });

    this.logger.log(
      `新建员工 id=${created.id} email=${dto.email} role=${dto.role} by=${user.email}`,
    );

    const detail = await this.loadDetail(created.id);
    return { ...detail, initialPassword: plainPassword };
  }

  /** 编辑员工资料。角色变更走这里会做「不能改自己」的防呆校验 */
  async update(user: AuthUser, id: string, dto: UpdateUserDto): Promise<UserDetail> {
    const existing = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        teamId: true,
        permissionOverrides: true,
      },
    });
    if (!existing) throw new ResourceNotFoundException('员工');

    // 防呆 1：不允许改自己的角色。管理员把自己从 SUPER_ADMIN 降为 AUDITOR 后，
    // 若系统内没有第二个管理员，角色矩阵将永远无法恢复（只能改库）。
    if (dto.role && dto.role !== existing.role && id === user.id) {
      throw new BusinessException(
        'SELF_ROLE_CHANGE_FORBIDDEN',
        '不允许修改自己的角色：管理员误将自己降权后可能导致系统无人可管理。请由其他管理员操作',
        400,
        { currentRole: existing.role, attemptedRole: dto.role },
      );
    }
    // 防呆 2：同理不允许禁用自己（禁用后连登录都进不来）
    if (dto.status === UserStatus.DISABLED && id === user.id) {
      throw new BusinessException(
        'SELF_DISABLE_FORBIDDEN',
        '不允许禁用自己的账号：禁用后将无法登录系统，请由其他管理员操作',
        400,
      );
    }
    // User.phone 也有唯一索引，必须在这里拦成业务可读的 409，而不是抛数据库原始错误
    if (dto.phone) await this.assertPhoneAvailable(dto.phone, id);
    if (dto.teamId) await this.assertTeamExists(dto.teamId);

    await this.prisma.user.update({
      where: { id },
      data: {
        name: dto.name,
        phone: dto.phone,
        avatarUrl: dto.avatarUrl,
        // teamId 显式传 null 表示移出团队，undefined 表示不改：Prisma 里两者语义不同
        teamId: dto.teamId === undefined ? undefined : dto.teamId,
        status: dto.status,
        role: dto.role,
      },
    });

    // 通过资料接口顺手禁用账号时，同样必须撤销会话，否则「禁用」不生效（详见类注释）
    if (dto.status === UserStatus.DISABLED && existing.status !== UserStatus.DISABLED) {
      await this.authService.revokeAllSessions(id, '账号被禁用');
    }

    this.logger.log(`更新员工 id=${id} by=${user.email}`);
    return this.loadDetail(id);
  }

  /** 变更账号状态。禁用时必须撤销全部会话 */
  async changeStatus(user: AuthUser, id: string, status: UserStatus): Promise<UserDetail> {
    const existing = await this.loadStateOrThrow(id);

    if (existing.status === status) {
      // 幂等：重复点击「禁用」不应报错，但也无需再撤销一次（revokeAllSessions 本身也是幂等的）
      return this.loadDetail(id);
    }
    if (status === UserStatus.DISABLED && id === user.id) {
      throw new BusinessException(
        'SELF_DISABLE_FORBIDDEN',
        '不允许禁用自己的账号：禁用后将无法登录系统，请由其他管理员操作',
        400,
      );
    }

    await this.prisma.user.update({
      where: { id },
      data: {
        status,
        // 启用时顺带解锁：管理员手动启用往往就是为了让人立刻能登录
        ...(status === UserStatus.ACTIVE ? { failedLoginCount: 0, lockedUntil: null } : {}),
      },
    });

    if (status === UserStatus.DISABLED) {
      const revoked = await this.authService.revokeAllSessions(id, '账号被禁用');
      this.logger.warn(
        `禁用员工 email=${existing.email}，已撤销 ${revoked} 个会话 by=${user.email}`,
      );
    }

    return this.loadDetail(id);
  }

  /**
   * 重置密码。
   * 重置后必须撤销全部会话：密码被重置通常意味着「原密码可能已泄露」或「员工离职交接」，
   * 旧设备上的 refresh token 必须失效，否则拿到旧 token 的人仍可持续换发 access token。
   */
  async resetPassword(
    user: AuthUser,
    id: string,
  ): Promise<{ initialPassword: string; revokedSessions: number }> {
    const existing = await this.loadStateOrThrow(id);
    const initialPassword = this.authService.generateInitialPassword();
    const passwordHash = await this.authService.hashPassword(initialPassword);

    await this.prisma.user.update({
      where: { id },
      data: {
        passwordHash,
        passwordUpdatedAt: new Date(),
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });

    const revokedSessions = await this.authService.revokeAllSessions(id, '管理员重置密码');
    this.logger.warn(
      `重置员工密码 email=${existing.email}，撤销会话 ${revokedSessions} 个 by=${user.email}`,
    );
    return { initialPassword, revokedSessions };
  }

  /**
   * 更新权限覆盖项。
   *
   * 为什么更新后要撤销会话：权限点被内嵌进 access token（最长 2h 滞后），
   * 若只改库不撤销，被收回权限的人在这 2 小时内仍能执行敏感操作（例如继续导出达人手机号）。
   * 撤销 refresh token 后，其 access token 到期即无法续期，从而实现「权限变更需重新登录生效」。
   */
  async updatePermissions(
    user: AuthUser,
    id: string,
    dto: UpdateUserPermissionsDto,
  ): Promise<UserDetail & { revokedSessions: number }> {
    const existing = await this.loadStateOrThrow(id);

    if (id === user.id) {
      throw new BusinessException(
        'SELF_PERMISSION_CHANGE_FORBIDDEN',
        '不允许修改自己的权限：请由其他管理员操作，避免误操作把自己锁在系统外',
        400,
      );
    }

    const overrides = this.normalizeOverrides(dto.permissionOverrides);

    await this.prisma.user.update({
      where: { id },
      data: { permissionOverrides: overrides },
    });

    const revokedSessions = await this.authService.revokeAllSessions(id, '权限变更');
    this.logger.warn(
      `变更员工权限 email=${existing.email} overrides=[${overrides.join(',')}]，撤销会话 ${revokedSessions} 个 by=${user.email}`,
    );

    const detail = await this.loadDetail(id);
    return { ...detail, revokedSessions };
  }

  /** 权限点目录：前端「角色权限」页渲染勾选框用，按分组排序便于扫读 */
  async permissionCatalog(): Promise<
    Array<{ code: string; label: string; group: string; risk: 'low' | 'medium' | 'high' }>
  > {
    return ALL_PERMISSIONS.map((code) => ({
      code,
      label: PERMISSION_META[code].label,
      group: PERMISSION_META[code].group,
      risk: PERMISSION_META[code].risk,
    })).sort((a, b) => a.group.localeCompare(b.group, 'zh-Hans-CN') || a.code.localeCompare(b.code));
  }

  /** 角色目录：角色 → 默认权限点 + 默认数据范围，用于「这个角色到底能干什么」的可解释展示 */
  async roleCatalog(): Promise<
    Array<{ role: UserRole; label: string; permissions: string[]; dataScope: string }>
  > {
    return (Object.keys(ROLE_PERMISSIONS) as UserRole[]).map((role) => ({
      role,
      label: ROLE_LABELS[role],
      permissions: [...ROLE_PERMISSIONS[role]],
      dataScope: ROLE_DATA_SCOPE[role],
    }));
  }

  /** 团队树。Team 表自关联（parentId），一次性取全量在内存里组装，避免递归查询打爆数据库 */
  async teamTree(): Promise<TeamNode[]> {
    const teams = await this.prisma.team.findMany({
      select: { id: true, name: true, code: true, parentId: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });

    const nodeMap = new Map<string, TeamNode>(
      teams.map((team) => [
        team.id,
        { id: team.id, name: team.name, code: team.code, parentId: team.parentId, children: [] },
      ]),
    );

    const roots: TeamNode[] = [];
    for (const team of teams) {
      const node = nodeMap.get(team.id)!;
      const parent = team.parentId ? nodeMap.get(team.parentId) : undefined;
      if (parent) {
        parent.children.push(node);
      } else {
        // parentId 指向已不存在的团队时按根节点处理，避免整棵树丢节点
        roots.push(node);
      }
    }
    return roots;
  }

  // -------------------------------------------------------------------------
  // 内部工具
  // -------------------------------------------------------------------------

  private async createUserRow(data: {
    email: string;
    name: string;
    phone: string | null;
    role: UserRole;
    teamId: string | null;
    passwordHash: string;
  }): Promise<{ id: string }> {
    try {
      return await this.prisma.user.create({
        data: {
          ...data,
          status: UserStatus.ACTIVE,
          // 初始不加权也不收权：角色默认权限 + 空覆盖，权限来源清晰可解释
          permissionOverrides: [],
        },
        select: { id: true },
      });
    } catch (error) {
      // 并发下「先查后写」仍可能撞唯一索引，这里兜底成业务可读的 409
      if (this.isUniqueViolation(error)) {
        throw new DuplicateOperationException('邮箱或手机号已被其他员工占用，请检查后重试');
      }
      throw error;
    }
  }

  private async loadStateOrThrow(id: string): Promise<{
    id: string;
    email: string;
    status: UserStatus;
    role: UserRole;
  }> {
    const user = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, email: true, status: true, role: true },
    });
    if (!user) throw new ResourceNotFoundException('员工');
    return user;
  }

  private async loadDetail(id: string): Promise<UserDetail> {
    const row = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      include: { team: { select: { id: true, name: true } } },
    });
    if (!row) throw new ResourceNotFoundException('员工');

    return {
      ...this.toListItem(row),
      permissionOverrides: row.permissionOverrides,
      // 有效权限 = 角色矩阵 + 授予 - 撤销，直接复用 auth 模块的解析函数，保证与鉴权口径完全一致
      effectivePermissions: [...resolvePermissions(row.role, row.permissionOverrides)],
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async assertEmailAvailable(email: string, excludeId?: string): Promise<void> {
    const duplicated = await this.prisma.user.findFirst({
      where: {
        email: email.trim().toLowerCase(),
        id: excludeId ? { not: excludeId } : undefined,
      },
      select: { id: true, deletedAt: true },
    });
    if (duplicated) {
      throw new DuplicateOperationException(
        duplicated.deletedAt
          ? `邮箱 ${email} 被一个已删除的历史账号占用，请改用其他邮箱或联系管理员恢复该账号`
          : `邮箱 ${email} 已被使用，请勿重复创建`,
        { userId: duplicated.id, softDeleted: Boolean(duplicated.deletedAt) },
      );
    }
  }

  private async assertPhoneAvailable(phone: string, excludeId?: string): Promise<void> {
    const duplicated = await this.prisma.user.findFirst({
      where: { phone, id: excludeId ? { not: excludeId } : undefined },
      select: { id: true },
    });
    if (duplicated) {
      throw new DuplicateOperationException(`手机号 ${phone} 已被其他员工使用`);
    }
  }

  private async assertTeamExists(teamId: string): Promise<void> {
    const team = await this.prisma.team.findUnique({ where: { id: teamId }, select: { id: true } });
    if (!team) throw new ResourceNotFoundException('团队', teamId);
  }

  /**
   * 校验并规范化权限覆盖项。
   *
   * 只接受两种形态：合法权限码（授予）与 '-' + 合法权限码（撤销）。
   * 非法项整体拒绝而不是静默丢弃：静默丢弃会让管理员以为「已经收权成功」，
   * 实际上权限还在，这是典型的权限事故来源（resolvePermissions 在读取侧是容错的，
   * 但写入侧必须严格）。
   */
  private normalizeOverrides(overrides: string[]): string[] {
    const invalid = overrides.filter((item) => {
      if (typeof item !== 'string' || item.length === 0) return true;
      const code = item.startsWith('-') ? item.slice(1) : item;
      return !ALL_PERMISSIONS.includes(code as Permission);
    });

    if (invalid.length > 0) {
      throw new UnprocessableException(
        `存在 ${invalid.length} 个非法权限码：${invalid.map((item) => `「${item}」`).join('、')}。权限码必须是系统已定义的权限点，撤销请使用 "-" 前缀（如 -creator:export）`,
        { invalid, allowedCount: ALL_PERMISSIONS.length },
      );
    }

    // 去重但保留顺序：同一权限既授予又撤销时，由 resolvePermissions 保证「撤销优先」
    return [...new Set(overrides.map((item) => item.trim()))];
  }

  private isUniqueViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }

  private toListItem(row: UserRow): UserListItem {
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      phone: row.phone,
      role: row.role,
      roleLabel: ROLE_LABELS[row.role],
      status: row.status,
      avatarUrl: row.avatarUrl,
      team: row.team,
      lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

export interface UserListItem {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  role: UserRole;
  /** 角色中文名，取自 ROLE_LABELS，避免前端各写一份映射导致文案不一致 */
  roleLabel: string;
  status: UserStatus;
  avatarUrl: string | null;
  team: { id: string; name: string } | null;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface UserDetail extends UserListItem {
  permissionOverrides: string[];
  effectivePermissions: string[];
  updatedAt: string;
}

export interface TeamNode {
  id: string;
  name: string;
  code: string;
  parentId: string | null;
  children: TeamNode[];
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  role: UserRole;
  status: UserStatus;
  avatarUrl: string | null;
  team: { id: string; name: string } | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  permissionOverrides: string[];
  updatedAt: Date;
}
