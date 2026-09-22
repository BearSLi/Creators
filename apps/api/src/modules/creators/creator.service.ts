import { Injectable, Logger } from '@nestjs/common';
import {
  ContentVertical,
  CreatorStatus,
  CreatorTier,
  DataSourceType,
  Platform,
  Prisma,
} from '@prisma/client';
import { env } from '../../config/index';
import {
  DuplicateOperationException,
  PermissionDeniedException,
  ResourceNotFoundException,
  UnprocessableException,
} from '../../common/exceptions/business.exception';
import { buildPaginated, PaginatedResult, resolveOrderBy } from '../../common/utils/pagination';
import { assertOwnership, buildScopeFilter } from '../../common/utils/scope';
import {
  decryptSensitive,
  encryptSensitive,
  maskIdCard,
  maskPhone,
  maskWechat,
} from '../../common/utils/crypto';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import { PERMISSIONS } from '../auth/permissions';
import { CodeGeneratorService, CODE_PREFIX } from '../common/code-generator.service';
import {
  assertCanBeScheduled,
  assertTransition,
  describeStatusMachine,
  CreatorStatusValue,
  CREATOR_STATUS_LABELS,
} from './creator-status.machine';
import {
  AssignCreatorDto,
  BatchImportCreatorDto,
  CreateCreatorDto,
  EvaluateCreatorDto,
  QueryCreatorDto,
  UpdateCreatorDto,
} from './dto/creator.dto';

/** 列表返回给前端的达人视图（敏感字段已按权限脱敏） */
export interface CreatorListItem {
  id: string;
  code: string;
  name: string;
  realName: string | null;
  phone: string | null;
  wechat: string | null;
  city: string | null;
  status: CreatorStatus;
  statusLabel: string;
  tier: CreatorTier;
  verticals: ContentVertical[];
  styleTags: string[];
  score: number;
  riskLevel: string;
  sourceChannel: string | null;
  agencyName: string | null;
  owner: { id: string; name: string } | null;
  team: { id: string; name: string } | null;
  tags: Array<{ id: string; name: string; color: string | null }>;
  accountCount: number;
  maxFollowers: number;
  platforms: Platform[];
  signedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** 敏感信息是否已脱敏，前端展示提示用 */
  masked: boolean;
}

export interface CreatorDetail extends CreatorListItem {
  email: string | null;
  agencyType: string | null;
  idCardMasked: string | null;
  remark: string | null;
  availability: unknown;
  accounts: Array<{
    id: string;
    platform: Platform;
    nickname: string;
    platformUid: string;
    profileUrl: string | null;
    followerCount: number;
    totalLikes: string;
    totalWorks: number;
    avgPlayCount: number;
    engagementRate: number;
    dataSource: DataSourceType;
    lastSyncedAt: string | null;
    isPrimary: boolean;
    syncError: string | null;
  }>;
  /** 合同与结算摘要：详情页头部卡片 */
  stats: {
    activeContracts: number;
    totalContents: number;
    publishedContents: number;
    totalRevenueYuan: number;
    pendingSettlementYuan: number;
  };
  statusMachine: ReturnType<typeof describeStatusMachine>;
}

@Injectable()
export class CreatorService {
  private readonly logger = new Logger(CreatorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly codeGenerator: CodeGeneratorService,
  ) {}

  /** 达人列表（达人库主页面）。所有筛选条件下推到数据库，避免内存过滤 */
  async list(user: AuthUser, query: QueryCreatorDto): Promise<PaginatedResult<CreatorListItem>> {
    const scopeFilter = buildScopeFilter(user);

    const where: Prisma.CreatorWhereInput = {
      deletedAt: null,
      ...scopeFilter,
      status: query.status?.length ? { in: query.status } : undefined,
      tier: query.tier?.length ? { in: query.tier } : undefined,
      verticals: query.vertical?.length ? { hasSome: query.vertical } : undefined,
      ownerId: query.ownerId,
      sourceChannel: query.sourceChannel,
      score: query.minScore !== undefined ? { gte: query.minScore } : undefined,
      tags: query.tagId ? { some: { tagId: query.tagId } } : undefined,
      accounts: buildAccountFilter(query),
    };

    if (query.keyword) {
      const keyword = query.keyword.trim();
      // 关键词跨字段搜索：昵称 / 真实姓名 / 编号 / 手机号 / 平台昵称。
      // 手机号支持「后四位」模糊：业务上运营常只记得尾号。
      where.OR = [
        { name: { contains: keyword, mode: 'insensitive' } },
        { code: { contains: keyword, mode: 'insensitive' } },
        { realName: { contains: keyword, mode: 'insensitive' } },
        { phone: { contains: keyword } },
        { accounts: { some: { nickname: { contains: keyword, mode: 'insensitive' } } } },
      ];
    }

    const orderBy = resolveOrderBy(
      query.sortBy,
      query.sortOrder,
      ['createdAt', 'updatedAt', 'score', 'name', 'signedAt'] as const,
      'createdAt',
    );

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.creator.findMany({
        where,
        orderBy,
        skip: query.skip,
        take: query.take,
        include: {
          owner: { select: { id: true, name: true } },
          team: { select: { id: true, name: true } },
          tags: { include: { tag: true } },
          accounts: {
            where: { deletedAt: null },
            select: { platform: true, followerCount: true, isPrimary: true },
          },
        },
      }),
      this.prisma.creator.count({ where }),
    ]);

    const canSeeSensitive = user.permissions.has(PERMISSIONS.CREATOR_SENSITIVE_READ);
    const items = rows.map((row) => this.toListItem(row, canSeeSensitive));
    return buildPaginated(items, total, query.page, query.pageSize);
  }

  /** 达人详情：含账号矩阵、业务统计、状态机可选下一步 */
  async findOne(user: AuthUser, id: string): Promise<CreatorDetail> {
    const creator = await this.prisma.creator.findFirst({
      where: { id, deletedAt: null },
      include: {
        owner: { select: { id: true, name: true } },
        team: { select: { id: true, name: true } },
        tags: { include: { tag: true } },
        accounts: { where: { deletedAt: null }, orderBy: [{ isPrimary: 'desc' }, { followerCount: 'desc' }] },
      },
    });
    if (!creator) throw new ResourceNotFoundException('达人');

    assertOwnership(user, creator, { resourceName: '达人' });
    const canSeeSensitive = user.permissions.has(PERMISSIONS.CREATOR_SENSITIVE_READ);

    const [activeContracts, contentAgg, publishedContents, revenueAgg, pendingSettlement] =
      await this.prisma.$transaction([
        this.prisma.contract.count({
          where: { creatorId: id, deletedAt: null, status: 'ACTIVE' },
        }),
        this.prisma.content.count({ where: { creatorId: id, deletedAt: null } }),
        this.prisma.content.count({
          where: { creatorId: id, deletedAt: null, status: 'PUBLISHED' },
        }),
        this.prisma.content.aggregate({
          where: { creatorId: id, deletedAt: null },
          _sum: { revenueCents: true },
        }),
        this.prisma.settlement.aggregate({
          where: {
            creatorId: id,
            deletedAt: null,
            status: { in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'] },
          },
          _sum: { netPayable: true },
        }),
      ]);

    const listItem = this.toListItem(creator, canSeeSensitive);

    return {
      ...listItem,
      email: canSeeSensitive ? creator.email : null,
      agencyType: creator.agencyType,
      idCardMasked: canSeeSensitive
        ? maskIdCard(decryptSensitive(creator.idCardEncrypted, env.JWT_ACCESS_SECRET))
        : null,
      remark: creator.remark,
      availability: creator.availability,
      accounts: creator.accounts.map((account) => ({
        id: account.id,
        platform: account.platform,
        nickname: account.nickname,
        platformUid: account.platformUid,
        profileUrl: account.profileUrl,
        followerCount: account.followerCount,
        totalLikes: account.totalLikes.toString(),
        totalWorks: account.totalWorks,
        avgPlayCount: account.avgPlayCount,
        engagementRate: account.engagementRateBp / 100,
        dataSource: account.dataSource,
        lastSyncedAt: account.lastSyncedAt?.toISOString() ?? null,
        isPrimary: account.isPrimary,
        syncError: account.syncError,
      })),
      stats: {
        activeContracts,
        totalContents: contentAgg,
        publishedContents,
        totalRevenueYuan: (revenueAgg._sum.revenueCents ?? 0n) === 0n
          ? 0
          : Number(revenueAgg._sum.revenueCents ?? 0n) / 100,
        pendingSettlementYuan: Number(pendingSettlement._sum.netPayable ?? 0),
      },
      statusMachine: describeStatusMachine(creator.status as CreatorStatusValue),
    };
  }

  /** 新建达人（含可选的平台账号一起创建），编号在事务内分配 */
  async create(user: AuthUser, dto: CreateCreatorDto): Promise<CreatorDetail> {
    if (dto.ownerId && !user.permissions.has(PERMISSIONS.CREATOR_ASSIGN) && dto.ownerId !== user.id) {
      throw new PermissionDeniedException('只有具备「分配负责人」权限的角色才能指定他人为负责人');
    }

    const created = await this.prisma.withTransaction(async (tx) => {
      const code = await this.codeGenerator.next(CODE_PREFIX.CREATOR, tx);
      return tx.creator.create({
        data: {
          code,
          name: dto.name,
          realName: dto.realName ?? null,
          idCardEncrypted: encryptSensitive(dto.idCard, env.JWT_ACCESS_SECRET),
          phone: dto.phone ?? null,
          wechat: dto.wechat ?? null,
          email: dto.email ?? null,
          city: dto.city ?? null,
          status: (dto.status ?? 'LEAD') as CreatorStatus,
          tier: (dto.tier ?? 'C') as CreatorTier,
          verticals: dto.verticals ?? [],
          styleTags: dto.styleTags ?? [],
          agencyType: dto.agencyType ?? null,
          agencyName: dto.agencyName ?? null,
          sourceChannel: dto.sourceChannel ?? null,
          score: dto.score ?? 60,
          remark: dto.remark ?? null,
          availability: (dto.availability ?? undefined) as Prisma.InputJsonValue | undefined,
          ownerId: dto.ownerId ?? user.id,
          teamId: dto.teamId ?? user.teamId ?? null,
          createdById: user.id,
          tags: dto.tagIds?.length
            ? { create: dto.tagIds.map((tagId) => ({ tagId })) }
            : undefined,
          accounts: dto.accounts?.length
            ? {
                create: dto.accounts.map((account, index) => ({
                  platform: account.platform,
                  nickname: account.nickname,
                  platformUid: account.platformUid,
                  profileUrl: account.profileUrl ?? null,
                  homeUrl: account.homeUrl ?? null,
                  followerCount: account.followerCount ?? 0,
                  dataSource: account.dataSource ?? DataSourceType.MANUAL,
                  isPrimary: account.isPrimary ?? index === 0,
                })),
              }
            : undefined,
        },
        select: { id: true },
      });
    });

    this.logger.log(`新建达人 id=${created.id} name=${dto.name} by=${user.email}`);
    return this.findOne(user, created.id);
  }

  /** 更新达人基础信息（状态变更走 changeStatus，避免绕过状态机） */
  async update(user: AuthUser, id: string, dto: UpdateCreatorDto): Promise<CreatorDetail> {
    const existing = await this.prisma.creator.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new ResourceNotFoundException('达人');
    assertOwnership(user, existing, { resourceName: '达人' });

    await this.prisma.withTransaction(async (tx) => {
      await tx.creator.update({
        where: { id },
        data: {
          name: dto.name,
          realName: dto.realName,
          idCardEncrypted:
            dto.idCard === undefined ? undefined : encryptSensitive(dto.idCard, env.JWT_ACCESS_SECRET),
          phone: dto.phone,
          wechat: dto.wechat,
          email: dto.email,
          city: dto.city,
          tier: dto.tier as CreatorTier | undefined,
          verticals: dto.verticals,
          styleTags: dto.styleTags,
          agencyType: dto.agencyType,
          agencyName: dto.agencyName,
          sourceChannel: dto.sourceChannel,
          score: dto.score,
          remark: dto.remark,
          availability: (dto.availability ?? undefined) as Prisma.InputJsonValue | undefined,
          ownerId: dto.ownerId,
          teamId: dto.teamId,
          // status 刻意不在通用更新里放开：必须经状态机校验
        },
      });

      if (dto.tagIds) {
        await tx.creatorTag.deleteMany({ where: { creatorId: id } });
        if (dto.tagIds.length > 0) {
          await tx.creatorTag.createMany({
            data: dto.tagIds.map((tagId) => ({ creatorId: id, tagId })),
            skipDuplicates: true,
          });
        }
      }
    });

    return this.findOne(user, id);
  }

  /** 状态变更：状态机校验 + 原因必填校验 + 自动维护时间戳 */
  async changeStatus(
    user: AuthUser,
    id: string,
    nextStatus: CreatorStatus,
    reason?: string,
  ): Promise<CreatorDetail> {
    const existing = await this.prisma.creator.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new ResourceNotFoundException('达人');
    assertOwnership(user, existing, { resourceName: '达人' });

    assertTransition(existing.status as CreatorStatusValue, nextStatus as CreatorStatusValue, {
      reason,
    });

    const data: Prisma.CreatorUpdateInput = { status: nextStatus };
    // 签约成功自动记录签约时间；解约/拉黑清空，避免报表口径混乱
    if (nextStatus === CreatorStatus.SIGNED && !existing.signedAt) data.signedAt = new Date();
    // 显式标注数组元素类型：否则 TS 把字面量数组推断成
    // ('TERMINATED' | 'BLACKLIST')[]，再用 CreatorStatus 去 includes 会类型不兼容。
    const riskStatuses: CreatorStatus[] = [CreatorStatus.TERMINATED, CreatorStatus.BLACKLIST];
    if (riskStatuses.includes(nextStatus)) {
      data.riskLevel = nextStatus === CreatorStatus.BLACKLIST ? 'HIGH' : existing.riskLevel;
    }

    await this.prisma.creator.update({
      where: { id },
      data: {
        ...data,
        remark: reason
          ? `${existing.remark ? `${existing.remark}\n` : ''}[${new Date().toISOString().slice(0, 10)} 状态变更→${CREATOR_STATUS_LABELS[nextStatus as CreatorStatusValue]}] ${reason}`
          : existing.remark,
      },
    });

    this.logger.log(
      `达人状态变更 ${existing.code}: ${existing.status} → ${nextStatus} by=${user.email}${reason ? ` 原因=${reason}` : ''}`,
    );
    return this.findOne(user, id);
  }

  /** 综合评估打分：四个维度加权，结果写回 score（供 AI 匹配与资源倾斜使用） */
  async evaluate(user: AuthUser, id: string, dto: EvaluateCreatorDto): Promise<CreatorDetail> {
    const existing = await this.prisma.creator.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new ResourceNotFoundException('达人');
    assertOwnership(user, existing, { resourceName: '达人' });

    const weights = { content: 0.3, commercial: 0.3, cooperation: 0.2, data: 0.2 };
    const score = Math.round(
      dto.contentScore * weights.content +
        dto.commercialScore * weights.commercial +
        dto.cooperationScore * weights.cooperation +
        dto.dataScore * weights.data,
    );

    await this.prisma.creator.update({
      where: { id },
      data: {
        score,
        remark: dto.remark
          ? `${existing.remark ? `${existing.remark}\n` : ''}[评估 ${new Date().toISOString().slice(0, 10)}] 内容${dto.contentScore}/商务${dto.commercialScore}/配合${dto.cooperationScore}/数据${dto.dataScore} → 综合${score}。${dto.remark}`
          : existing.remark,
      },
    });
    return this.findOne(user, id);
  }

  /** 分配/交接负责人 */
  async assign(user: AuthUser, id: string, dto: AssignCreatorDto): Promise<CreatorDetail> {
    const existing = await this.prisma.creator.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new ResourceNotFoundException('达人');

    const target = await this.prisma.user.findFirst({
      where: { id: dto.ownerId, deletedAt: null, status: 'ACTIVE' },
      select: { id: true, name: true },
    });
    if (!target) throw new UnprocessableException('目标负责人不存在或已离职');

    await this.prisma.creator.update({ where: { id }, data: { ownerId: dto.ownerId } });
    this.logger.log(
      `达人交接 ${existing.code}: ${existing.ownerId ?? '-'} → ${target.name} by=${user.email}`,
    );
    return this.findOne(user, id);
  }

  /** 软删除。存在生效合同/内容时禁止删除，防止业务数据断链 */
  async remove(user: AuthUser, id: string): Promise<{ id: string; deleted: true }> {
    const existing = await this.prisma.creator.findFirst({
      where: { id, deletedAt: null },
      include: {
        _count: { select: { contracts: true, contents: true, settlementItems: true } },
      },
    });
    if (!existing) throw new ResourceNotFoundException('达人');
    assertOwnership(user, existing, { resourceName: '达人' });

    const blockers: string[] = [];
    if (existing._count.contracts > 0) blockers.push(`${existing._count.contracts} 份合同`);
    if (existing._count.contents > 0) blockers.push(`${existing._count.contents} 条内容`);
    if (existing._count.settlementItems > 0) blockers.push(`${existing._count.settlementItems} 笔结算明细`);
    if (blockers.length > 0) {
      throw new DuplicateOperationException(
        `该达人已关联 ${blockers.join('、')}，为保留业务链路不可删除。如需停止合作请变更为「已解约」`,
      );
    }

    await this.prisma.creator.update({ where: { id }, data: { deletedAt: new Date() } });
    return { id, deleted: true };
  }

  /** 批量导入：部分成功语义，返回逐条结果便于运营修正后重试 */
  async batchImport(
    user: AuthUser,
    dto: BatchImportCreatorDto,
  ): Promise<{ created: number; failed: Array<{ index: number; name: string; reason: string }> }> {
    const failed: Array<{ index: number; name: string; reason: string }> = [];
    let created = 0;

    // 逐条处理而非整批事务：一条脏数据不应让 200 条导入整体失败
    for (const [index, item] of dto.items.entries()) {
      try {
        const payload: CreateCreatorDto = { ...item, ownerId: dto.ownerId ?? item.ownerId };
        await this.create(user, payload);
        created += 1;
      } catch (error) {
        failed.push({
          index,
          name: item.name,
          reason: error instanceof Error ? error.message : '未知错误',
        });
      }
    }
    this.logger.log(`批量导入达人：成功 ${created} 条，失败 ${failed.length} 条 by=${user.email}`);
    return { created, failed };
  }

  /** 达人「可排期」校验的对外入口，供项目模块复用 */
  async assertSchedulable(creatorId: string): Promise<void> {
    const creator = await this.prisma.creator.findFirst({
      where: { id: creatorId, deletedAt: null },
      select: { status: true, name: true },
    });
    if (!creator) throw new ResourceNotFoundException('达人');
    assertCanBeScheduled(creator.status as CreatorStatusValue);
  }

  /** 内部映射：统一做脱敏与标签扁平化 */
  private toListItem(
    row: Prisma.CreatorGetPayload<{
      include: {
        owner: { select: { id: true; name: true } };
        team: { select: { id: true; name: true } };
        tags: { include: { tag: true } };
        accounts: { select: { platform: true; followerCount: true; isPrimary: true } };
      };
    }>,
    canSeeSensitive: boolean,
  ): CreatorListItem {
    const maxFollowers = row.accounts.reduce((max, account) => Math.max(max, account.followerCount), 0);
    const platforms = [...new Set(row.accounts.map((account) => account.platform))];

    return {
      id: row.id,
      code: row.code,
      name: row.name,
      realName: canSeeSensitive ? row.realName : null,
      phone: canSeeSensitive ? row.phone : maskPhone(row.phone),
      wechat: canSeeSensitive ? row.wechat : maskWechat(row.wechat),
      city: row.city,
      status: row.status,
      statusLabel: CREATOR_STATUS_LABELS[row.status as CreatorStatusValue],
      tier: row.tier,
      verticals: row.verticals,
      styleTags: row.styleTags,
      score: row.score,
      riskLevel: row.riskLevel,
      sourceChannel: row.sourceChannel,
      agencyName: row.agencyName,
      owner: row.owner,
      team: row.team,
      tags: row.tags.map((item) => ({
        id: item.tag.id,
        name: item.tag.name,
        color: item.tag.color,
      })),
      accountCount: row.accounts.length,
      maxFollowers,
      platforms,
      signedAt: row.signedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      masked: !canSeeSensitive,
    };
  }

  /** 供其他模块（项目/结算）复用的精简查询 */
  async findBriefByIds(ids: string[]): Promise<Map<string, { id: string; code: string; name: string; status: CreatorStatus }>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.creator.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, code: true, name: true, status: true },
    });
    return new Map(rows.map((row) => [row.id, row]));
  }
}

/** 账号维度筛选：粉丝数区间取「该达人任一账号命中」 */
function buildAccountFilter(query: QueryCreatorDto): Prisma.PlatformAccountListRelationFilter | undefined {
  const conditions: Prisma.PlatformAccountWhereInput[] = [{ deletedAt: null }];
  if (query.platform) conditions.push({ platform: query.platform });
  if (query.minFollowers !== undefined || query.maxFollowers !== undefined) {
    conditions.push({
      followerCount: {
        gte: query.minFollowers ?? undefined,
        lte: query.maxFollowers ?? undefined,
      },
    });
  }
  return conditions.length > 1 ? { some: { AND: conditions } } : undefined;
}
