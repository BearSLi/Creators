import { Injectable, Logger } from '@nestjs/common';
import { ContentStatus, ContentVertical, Prisma, ProjectStatus } from '@prisma/client';
import {
  BusinessException,
  ResourceNotFoundException,
  StateConflictException,
  UnprocessableException,
} from '../../common/exceptions/business.exception';
import { centsToDecimalString, decimalToCents } from '../../common/utils/money';
import { buildPaginated, PaginatedResult, resolveOrderBy } from '../../common/utils/pagination';
import { assertOwnership, buildScopeFilter, resolveScope } from '../../common/utils/scope';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import { DATA_SCOPE } from '../auth/permissions';
import { CodeGeneratorService, CODE_PREFIX } from '../common/code-generator.service';
import { CONTENT_STATUS_LABELS } from '../contents/content.service';
import { CreatorService } from '../creators/creator.service';
import {
  ChangeProjectStatusDto,
  CreateProjectDto,
  QueryProjectDto,
  UpdateProjectDto,
} from './dto/project.dto';

/**
 * 项目状态机。
 *
 * 项目是「一次内容交付的容器」，它的状态决定内容能否继续生产、能否结项结算：
 *   - 内容只能在 SCHEDULED 之后进入制作，因此内容侧会读项目状态；
 *   - 结项（COMPLETED）是成本归集与毛利结算的触发点，不能被随意回退。
 * 把合法流转固化成表 + 断言函数（与 contracts/contract.service.ts 同一写法），
 * 而不是允许前端任意 PUT 一个 status：
 *   自由改状态会绕过「审核→发布→结项」的顺序，出现「已结项但还有制作中内容」
 *   这种数据自相矛盾的状态，后续成本与结算口径全部失真。
 */
export const PROJECT_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  DRAFT: ['SCHEDULED', 'CANCELED'],
  SCHEDULED: ['IN_PRODUCTION', 'CANCELED'],
  IN_PRODUCTION: ['IN_REVIEW', 'CANCELED'],
  // 审核不通过要能打回制作，这是最常见的真实路径
  IN_REVIEW: ['PUBLISHED', 'IN_PRODUCTION', 'CANCELED'],
  PUBLISHED: ['COMPLETED', 'CANCELED'],
  // 已结项是终点：如需追加内容必须新建项目，否则历史成本口径会被篡改
  COMPLETED: [],
  CANCELED: [],
};

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  DRAFT: '草稿',
  SCHEDULED: '已排期',
  IN_PRODUCTION: '制作中',
  IN_REVIEW: '审核中',
  PUBLISHED: '已发布',
  COMPLETED: '已结项',
  CANCELED: '已取消',
};

export const CONTENT_VERTICAL_LABELS: Record<ContentVertical, string> = {
  SHORT_DRAMA: '短剧',
  LIFESTYLE: '生活',
  BEAUTY: '美妆',
  GAMING: '游戏',
  FOOD: '美食',
  TECH: '科技数码',
  KNOWLEDGE: '知识科普',
  FASHION: '时尚',
  FITNESS: '健身',
  OTHER: '其他',
};

/** 断言状态流转合法，不合法抛 409 并附上可选下一步，便于前端渲染按钮 */
export function assertProjectTransition(
  from: ProjectStatus,
  to: ProjectStatus,
  options: { reason?: string } = {},
): void {
  const allowed = PROJECT_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new StateConflictException(
      `项目不允许从「${PROJECT_STATUS_LABELS[from]}」变更为「${PROJECT_STATUS_LABELS[to]}」`,
      {
        from,
        to,
        allowedNext: allowed.map((status) => ({
          value: status,
          label: PROJECT_STATUS_LABELS[status],
        })),
      },
    );
  }
  // 取消是不可逆动作，必须留下原因：项目被取消往往意味着客户砍单或素材违规，
  // 事后复盘（谁在什么时候因为什么取消）只能靠这条原因，补不回来。
  if (to === ProjectStatus.CANCELED && !options.reason?.trim()) {
    throw new BusinessException(
      'REASON_REQUIRED',
      '取消项目必须填写原因（客户砍单/素材违规/延期等），用于后续复盘与审计',
      400,
      { requiresReason: true, field: 'reason' },
    );
  }
}

/** 前端渲染用：返回允许的下一步与中文标签 */
export function describeProjectStatusMachine(from: ProjectStatus) {
  return {
    current: { value: from, label: PROJECT_STATUS_LABELS[from] },
    allowedNext: (PROJECT_TRANSITIONS[from] ?? []).map((status) => ({
      value: status,
      label: PROJECT_STATUS_LABELS[status],
    })),
  };
}

/**
 * 项目服务。
 *
 * 业务定位：项目 = 品牌需求 + 合同 + 达人 + 一批内容。它是内容生产的编排单元，
 * 也是「预算 vs 实际成本」的经营单元，因此本模块承担三类职责：
 *   1) 创建时把品牌/合同/达人的引用关系校验干净（避免出现「合同是 A 达人的，项目挂 B 达人」）；
 *   2) 用状态机管控交付生命周期；
 *   3) 聚合内容维度的产出与流水，供项目详情页与毛利看板使用。
 */
@Injectable()
export class ProjectService {
  private readonly logger = new Logger(ProjectService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly codeGenerator: CodeGeneratorService,
    private readonly creatorService: CreatorService,
  ) {}

  /** 项目列表。内容条数用一个聚合查询批量算，避免每个项目单独 count（N+1） */
  async list(user: AuthUser, query: QueryProjectDto): Promise<PaginatedResult<ProjectListItem>> {
    const where: Prisma.ProjectWhereInput = {
      deletedAt: null,
      status: query.status?.length ? { in: query.status } : undefined,
      brandId: query.brandId,
      creatorId: query.creatorId,
      // 数据范围与关键词都用 AND 组合：避免把 scope 的 OR 覆盖掉（覆盖会造成越权可见）
      AND: [
        this.buildScopeWhere(user),
        query.keyword
          ? {
              OR: [
                { name: { contains: query.keyword, mode: 'insensitive' } },
                { code: { contains: query.keyword, mode: 'insensitive' } },
                { brand: { name: { contains: query.keyword, mode: 'insensitive' } } },
                { creator: { name: { contains: query.keyword, mode: 'insensitive' } } },
              ],
            }
          : {},
      ],
    };

    const orderBy = resolveOrderBy(
      query.sortBy,
      query.sortOrder,
      ['createdAt', 'updatedAt', 'dueDate', 'startDate', 'budget', 'name', 'status'] as const,
      'createdAt',
    );

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.project.findMany({
        where,
        orderBy,
        skip: query.skip,
        take: query.take,
        include: {
          brand: { select: { id: true, name: true } },
          creator: { select: { id: true, name: true } },
          contract: { select: { id: true, code: true } },
        },
      }),
      this.prisma.project.count({ where }),
    ]);

    // 项目表没有内容计数列，这里按当前页的项目 ID 批量聚合：
    // 两次 groupBy 覆盖「内容总数」与「已发布数」，比逐项目 count 少 N 倍往返。
    const projectIds = rows.map((row) => row.id);
    const [contentCounts, publishedCounts, ownerNames] = await Promise.all([
      this.loadContentCounts(projectIds, false),
      this.loadContentCounts(projectIds, true),
      this.loadOwnerNames(rows.map((row) => row.ownerId)),
    ]);

    const contentCountMap = new Map(
      contentCounts.map((item) => [item.projectId ?? '', item._count._all]),
    );
    const publishedCountMap = new Map(
      publishedCounts.map((item) => [item.projectId ?? '', item._count._all]),
    );

    const items = rows.map((row) =>
      this.toListItem(
        row,
        contentCountMap.get(row.id) ?? 0,
        publishedCountMap.get(row.id) ?? 0,
        row.ownerId ? ownerNames.get(row.ownerId) ?? null : null,
      ),
    );
    return buildPaginated(items, total, query.page, query.pageSize);
  }

  /** 项目详情：含最多 100 条内容与汇总统计 */
  async findOne(user: AuthUser, id: string): Promise<ProjectDetail> {
    const project = await this.prisma.project.findFirst({
      where: { id, deletedAt: null },
      include: {
        brand: { select: { id: true, name: true, level: true } },
        creator: { select: { id: true, name: true, code: true, status: true, teamId: true } },
        contract: {
          select: { id: true, code: true, title: true, status: true, effectiveFrom: true, effectiveTo: true },
        },
        contents: {
          where: { deletedAt: null },
          // 详情页只展示最近 100 条：项目内容可能上千条，全量返回会让详情接口超时
          orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
          take: 100,
          select: {
            id: true,
            title: true,
            platform: true,
            status: true,
            publishedAt: true,
            viewCount: true,
          },
        },
      },
    });
    if (!project) throw new ResourceNotFoundException('项目');

    // 团队维度用达人所属团队兜底：Project 表没有 teamId 列（见 buildScopeWhere 的说明）
    assertOwnership(
      user,
      { ownerId: project.ownerId, teamId: project.creator?.teamId ?? null },
      { resourceName: '项目' },
    );

    const [contentCount, publishedCount, contentAgg, ownerNames] = await Promise.all([
      this.prisma.content.count({ where: { projectId: id, deletedAt: null } }),
      this.prisma.content.count({
        where: { projectId: id, deletedAt: null, status: ContentStatus.PUBLISHED },
      }),
      this.prisma.content.aggregate({
        where: { projectId: id, deletedAt: null },
        _sum: { revenueCents: true, viewCount: true },
      }),
      this.loadOwnerNames([project.ownerId]),
    ]);

    const budgetCents = decimalToCents(project.budget);
    const actualCostCents = decimalToCents(project.actualCost);
    // 成本率用整数基点计算再转百分比，避免浮点除法带来的 33.330000000000004 这类脏数字
    const costRatePercent =
      budgetCents > 0 ? Math.round((actualCostCents * 10_000) / budgetCents) / 100 : 0;

    return {
      ...this.toListItem(
        project,
        contentCount,
        publishedCount,
        project.ownerId ? ownerNames.get(project.ownerId) ?? null : null,
      ),
      brief: project.brief,
      completedAt: project.completedAt?.toISOString() ?? null,
      brand: project.brand,
      creator: project.creator
        ? {
            id: project.creator.id,
            name: project.creator.name,
            code: project.creator.code,
            status: project.creator.status,
          }
        : null,
      contract: project.contract
        ? {
            id: project.contract.id,
            code: project.contract.code,
            title: project.contract.title,
            status: project.contract.status,
            effectiveFrom: project.contract.effectiveFrom.toISOString().slice(0, 10),
            effectiveTo: project.contract.effectiveTo.toISOString().slice(0, 10),
          }
        : null,
      contents: project.contents.map((content) => ({
        id: content.id,
        title: content.title,
        platform: content.platform,
        status: content.status,
        // 内容状态中文名复用内容模块的常量：两处各维护一份必然漂移
        statusLabel: CONTENT_STATUS_LABELS[content.status],
        publishedAt: content.publishedAt?.toISOString() ?? null,
        // BigInt 必须转字符串：JSON.stringify 遇到 BigInt 会直接抛 TypeError
        viewCount: content.viewCount.toString(),
      })),
      stats: {
        contentCount,
        publishedCount,
        totalRevenueYuan: centsToDecimalString(Number(contentAgg._sum.revenueCents ?? 0n)),
        totalViewCount: (contentAgg._sum.viewCount ?? 0n).toString(),
        budget: project.budget.toFixed(2),
        actualCost: project.actualCost.toFixed(2),
        costRatePercent,
      },
      statusMachine: describeProjectStatusMachine(project.status),
    };
  }

  /**
   * 新建项目。
   *
   * 引用关系校验是这个方法的重点：项目同时挂着品牌、合同、达人三个外部主数据，
   * 一旦出现「合同属于 A 达人，项目却挂 B 达人」，后续内容结算会按 B 达人出账，
   * 而合同分润规则是 A 达人的——出错时已经发了内容，无法回滚。
   */
  async create(user: AuthUser, dto: CreateProjectDto): Promise<ProjectDetail> {
    const { creatorId, contract } = await this.resolveReferences(dto);
    await this.assertOwnerExists(dto.ownerId);
    const { startDate, dueDate } = this.resolveDateRange(dto.startDate, dto.dueDate);

    const created = await this.prisma.withTransaction(async (tx) => {
      const code = await this.codeGenerator.next(CODE_PREFIX.PROJECT, tx);
      return tx.project.create({
        data: {
          code,
          name: dto.name,
          brandId: dto.brandId ?? contract?.brandId ?? null,
          contractId: contract?.id ?? null,
          creatorId: creatorId ?? null,
          status: ProjectStatus.DRAFT,
          vertical: dto.vertical ?? ContentVertical.SHORT_DRAMA,
          budget: dto.budget ?? '0',
          actualCost: '0',
          ownerId: dto.ownerId ?? user.id,
          startDate,
          dueDate,
          brief: dto.brief ?? null,
        },
        select: { id: true },
      });
    });

    this.logger.log(`新建项目 id=${created.id} name=${dto.name} by=${user.email}`);
    return this.findOne(user, created.id);
  }

  /** 编辑项目。状态变更不在这里，必须走 changeStatus 以通过状态机 */
  async update(user: AuthUser, id: string, dto: UpdateProjectDto): Promise<ProjectDetail> {
    const existing = await this.loadForWrite(id);
    assertOwnership(
      user,
      { ownerId: existing.ownerId, teamId: existing.creator?.teamId ?? null },
      { resourceName: '项目' },
    );

    // 已结项/已取消的项目不允许再改排期与预算：历史口径一旦被改，毛利报表无法复现
    if (existing.status === ProjectStatus.COMPLETED || existing.status === ProjectStatus.CANCELED) {
      throw new StateConflictException(
        `项目当前为「${PROJECT_STATUS_LABELS[existing.status]}」，不允许修改。如需追加交付请新建项目`,
      );
    }

    let creatorId = existing.creatorId;
    let contractId = existing.contractId;
    let brandId = existing.brandId;

    if (dto.creatorId !== undefined || dto.contractId !== undefined) {
      const resolved = await this.resolveReferences({
        brandId: dto.brandId,
        creatorId: dto.creatorId ?? existing.creatorId ?? undefined,
        contractId: dto.contractId ?? existing.contractId ?? undefined,
      });
      creatorId = resolved.creatorId ?? null;
      contractId = resolved.contract?.id ?? null;
      if (contractId) brandId = resolved.contract?.brandId ?? brandId;
    }
    if (dto.brandId !== undefined) {
      await this.assertBrandExists(dto.brandId);
      brandId = dto.brandId;
    }
    if (dto.ownerId !== undefined) await this.assertOwnerExists(dto.ownerId);

    const { startDate, dueDate } = this.resolveDateRange(
      dto.startDate ?? existing.startDate?.toISOString(),
      dto.dueDate ?? existing.dueDate?.toISOString(),
    );

    await this.prisma.project.update({
      where: { id },
      data: {
        name: dto.name,
        brandId,
        contractId,
        creatorId,
        vertical: dto.vertical,
        budget: dto.budget,
        ownerId: dto.ownerId,
        startDate,
        dueDate,
        brief: dto.brief,
      },
    });

    this.logger.log(`更新项目 id=${id} code=${existing.code} by=${user.email}`);
    return this.findOne(user, id);
  }

  /**
   * 变更项目状态。
   * 取消原因不落库在 project 表（该表没有备注列），而是通过 @Audit 装饰器写进审计日志；
   * 这样既避免污染 brief（brief 是给内容团队看的交付说明），又保证原因可追溯。
   */
  async changeStatus(
    user: AuthUser,
    id: string,
    dto: ChangeProjectStatusDto,
  ): Promise<ProjectDetail> {
    const existing = await this.loadForWrite(id);
    assertOwnership(
      user,
      { ownerId: existing.ownerId, teamId: existing.creator?.teamId ?? null },
      { resourceName: '项目' },
    );

    assertProjectTransition(existing.status, dto.status, { reason: dto.reason });

    const data: Prisma.ProjectUpdateInput = { status: dto.status };
    if (dto.status === ProjectStatus.COMPLETED) {
      // 结项时间用于「按期交付率」统计，只在这里写，不允许前端传
      data.completedAt = new Date();
    }

    await this.prisma.project.update({ where: { id }, data });
    this.logger.log(
      `项目状态变更 ${existing.code}: ${existing.status} → ${dto.status} by=${user.email}${dto.reason ? ` 原因=${dto.reason}` : ''}`,
    );
    return this.findOne(user, id);
  }

  /**
   * 软删除项目。
   *
   * 只有在内容全部处于「已驳回/已下线」这类终止态时才允许删除：
   * 还有制作中或已发布的内容时删除项目，会让这些内容失去归属（详情页项目为空），
   * 排期表与结算归因都会出现孤儿数据。已发布内容更是关联着采集数据与结算明细。
   */
  async remove(user: AuthUser, id: string): Promise<{ id: string; deleted: true }> {
    const existing = await this.loadForWrite(id);
    assertOwnership(
      user,
      { ownerId: existing.ownerId, teamId: existing.creator?.teamId ?? null },
      { resourceName: '项目' },
    );

    const activeContents = await this.prisma.content.count({
      where: {
        projectId: id,
        deletedAt: null,
        status: { notIn: [ContentStatus.REJECTED, ContentStatus.OFFLINE] },
      },
    });
    if (activeContents > 0) {
      throw new StateConflictException(
        `该项目还有 ${activeContents} 条未终止的内容（非「已驳回/已下线」），删除后这些内容会失去项目归属。请先取消/下线这些内容，或改用「取消项目」`,
        { activeContentCount: activeContents, allowForce: false },
      );
    }

    await this.prisma.project.update({ where: { id }, data: { deletedAt: new Date() } });
    this.logger.log(`软删除项目 id=${id} code=${existing.code} by=${user.email}`);
    return { id, deleted: true };
  }

  // -------------------------------------------------------------------------
  // 校验与内部工具
  // -------------------------------------------------------------------------

  /**
   * 解析并校验外部引用（达人 / 合同 / 品牌）。
   *
   * 规则：
   *   - 给了 creatorId：达人必须存在且状态可排期（调用 CreatorService.assertSchedulable，
   *     复用达人模块的规则，避免两处各写一份「什么算可排期」）；
   *   - 给了 contractId：合同必须存在且未删除；若同时给了 creatorId，两者达人必须一致，
   *     否则直接 422——这是「钱与人对不上」的源头；
   *   - 只给 contractId 时，达人从合同推导，保证项目一定挂在合同对应的达人上。
   */
  private async resolveReferences(dto: {
    brandId?: string;
    creatorId?: string;
    contractId?: string;
  }): Promise<{
    creatorId?: string;
    contract: { id: string; code: string; creatorId: string; brandId: string | null } | null;
  }> {
    if (dto.brandId) await this.assertBrandExists(dto.brandId);

    let contract: { id: string; code: string; creatorId: string; brandId: string | null } | null =
      null;
    if (dto.contractId) {
      contract = await this.prisma.contract.findFirst({
        where: { id: dto.contractId, deletedAt: null },
        select: { id: true, code: true, creatorId: true, brandId: true },
      });
      if (!contract) throw new ResourceNotFoundException('合同', dto.contractId);
    }

    let creatorId = dto.creatorId;
    if (creatorId && contract && contract.creatorId !== creatorId) {
      const [expected, actual] = await Promise.all([
        this.prisma.creator.findUnique({ where: { id: contract.creatorId }, select: { name: true } }),
        this.prisma.creator.findUnique({ where: { id: creatorId }, select: { name: true } }),
      ]);
      throw new UnprocessableException(
        `合同 ${contract.code} 属于达人「${expected?.name ?? contract.creatorId}」，与所选达人「${actual?.name ?? creatorId}」不一致。项目必须挂在合同对应的达人下，否则结算归因会出错`,
        { contractId: contract.id, contractCreatorId: contract.creatorId, creatorId },
      );
    }
    if (!creatorId && contract) creatorId = contract.creatorId;

    if (creatorId) {
      // 不存在会抛 ResourceNotFoundException，状态不可排期会抛 StateConflictException
      await this.creatorService.assertSchedulable(creatorId);
    }

    return { creatorId, contract };
  }

  private async assertBrandExists(brandId: string): Promise<void> {
    const brand = await this.prisma.brand.findFirst({
      where: { id: brandId, deletedAt: null },
      select: { id: true },
    });
    if (!brand) throw new ResourceNotFoundException('品牌', brandId);
  }

  private async assertOwnerExists(ownerId?: string): Promise<void> {
    if (!ownerId) return;
    const owner = await this.prisma.user.findFirst({
      where: { id: ownerId, deletedAt: null, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!owner) throw new UnprocessableException('指定的项目负责人不存在或已离职');
  }

  /** 日期区间校验：截止日必须晚于开始日，否则排期表与「是否延期」统计全部失效 */
  private resolveDateRange(
    startDate?: string,
    dueDate?: string,
  ): { startDate: Date | null; dueDate: Date | null } {
    const start = startDate ? new Date(startDate) : null;
    const due = dueDate ? new Date(dueDate) : null;

    if (start && Number.isNaN(start.getTime())) throw new UnprocessableException('开始日期格式不正确');
    if (due && Number.isNaN(due.getTime())) throw new UnprocessableException('截止日期格式不正确');
    if (start && due && due <= start) {
      throw new UnprocessableException('截止日期必须晚于开始日期，请核对排期');
    }
    return { startDate: start, dueDate: due };
  }

  private async loadForWrite(id: string) {
    const project = await this.prisma.project.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        code: true,
        status: true,
        ownerId: true,
        brandId: true,
        contractId: true,
        creatorId: true,
        startDate: true,
        dueDate: true,
        creator: { select: { teamId: true } },
      },
    });
    if (!project) throw new ResourceNotFoundException('项目');
    return project;
  }

  /**
   * 批量统计当前页项目的内容条数。
   * 一次 groupBy 覆盖整页，避免「每行一次 count」的 N+1（列表页 20 行就是 20 次往返）。
   */
  private async loadContentCounts(
    projectIds: string[],
    onlyPublished: boolean,
  ): Promise<Array<{ projectId: string | null; _count: { _all: number } }>> {
    if (projectIds.length === 0) return [];
    /**
     * 这里对 `where` 做一次类型断言，绕开 Prisma 的一个类型推断缺口：
     * 当 `by` 为可空字段（`projectId: String?`）且 `_count: { _all: true }` 时，
     * groupBy 的重载无法收窄到「返回数组」的那个签名，报
     * `is missing the following properties: length, pop, push, concat...`。
     * 断言只作用于入参类型，不改运行时行为；返回类型仍由本函数的签名约束，
     * 因此调用方拿到的类型依然是安全的。
     */
    const grouped = await this.prisma.content.groupBy({
      by: ['projectId'],
      where: {
        projectId: { in: projectIds },
        deletedAt: null,
        ...(onlyPublished ? { status: ContentStatus.PUBLISHED } : {}),
      },
      _count: { _all: true },
      orderBy: { projectId: 'asc' },
    } as never);
    return grouped as Array<{ projectId: string | null; _count: { _all: number } }>;
  }

  /** 只查当前页涉及的负责人姓名：Project.ownerId 没有建关系列，无法 include，只能批量补一次查询 */
  private async loadOwnerNames(ownerIds: Array<string | null>): Promise<Map<string, string>> {
    const ids = [...new Set(ownerIds.filter((value): value is string => Boolean(value)))];
    if (ids.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    return new Map(users.map((user) => [user.id, user.name]));
  }

  /**
   * 项目的数据范围条件。
   *
   * Project 表只有 ownerId，没有 teamId 列，所以不能直接照搬默认的 buildScopeFilter：
   * 默认 TEAM 分支会生成 `{ teamId }`，而 projects 表没有这个列，Prisma 会直接抛
   * 「Unknown argument teamId」把整个列表接口打成 500。
   * 这里 OWN 分支复用 buildScopeFilter（保证「只认负责人」的口径与达人模块一致），
   * TEAM 分支用「负责人是我，或项目所挂达人属于本团队」表达，语义等价且不会打到不存在的列。
   */
  private buildScopeWhere(user: AuthUser): Prisma.ProjectWhereInput {
    const scope = resolveScope(user);
    if (scope === DATA_SCOPE.ALL) return {};
    if (scope === DATA_SCOPE.TEAM) {
      return {
        OR: [
          { ownerId: user.id },
          ...(user.teamId ? [{ creator: { teamId: user.teamId } }] : []),
        ],
      };
    }
    return buildScopeFilter(user, { ownerField: 'ownerId' }) as Prisma.ProjectWhereInput;
  }

  private toListItem(
    row: ProjectRow,
    contentCount: number,
    publishedCount: number,
    ownerName: string | null,
  ): ProjectListItem {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      status: row.status,
      statusLabel: PROJECT_STATUS_LABELS[row.status],
      vertical: row.vertical,
      verticalLabel: CONTENT_VERTICAL_LABELS[row.vertical],
      brandId: row.brandId,
      brandName: row.brand?.name ?? null,
      creatorId: row.creatorId,
      creatorName: row.creator?.name ?? null,
      contractId: row.contractId,
      contractCode: row.contract?.code ?? null,
      budget: row.budget.toFixed(2),
      actualCost: row.actualCost.toFixed(2),
      ownerId: row.ownerId,
      ownerName,
      startDate: row.startDate?.toISOString().slice(0, 10) ?? null,
      dueDate: row.dueDate?.toISOString().slice(0, 10) ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      contentCount,
      publishedCount,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

export interface ProjectListItem {
  id: string;
  code: string;
  name: string;
  status: ProjectStatus;
  statusLabel: string;
  vertical: ContentVertical;
  verticalLabel: string;
  brandId: string | null;
  brandName: string | null;
  creatorId: string | null;
  creatorName: string | null;
  contractId: string | null;
  contractCode: string | null;
  /** 金额一律字符串（元，两位小数）：前端不做浮点运算，后端不做浮点计算 */
  budget: string;
  actualCost: string;
  ownerId: string | null;
  ownerName: string | null;
  startDate: string | null;
  dueDate: string | null;
  completedAt: string | null;
  contentCount: number;
  publishedCount: number;
  createdAt: string;
}

export interface ProjectDetail extends ProjectListItem {
  brief: string | null;
  brand: { id: string; name: string; level: string } | null;
  creator: { id: string; name: string; code: string; status: string } | null;
  contract: {
    id: string;
    code: string;
    title: string;
    status: string;
    effectiveFrom: string;
    effectiveTo: string;
  } | null;
  contents: Array<{
    id: string;
    title: string;
    platform: string;
    status: ContentStatus;
    statusLabel: string;
    publishedAt: string | null;
    viewCount: string;
  }>;
  stats: {
    contentCount: number;
    publishedCount: number;
    totalRevenueYuan: string;
    totalViewCount: string;
    budget: string;
    actualCost: string;
    costRatePercent: number;
  };
  statusMachine: ReturnType<typeof describeProjectStatusMachine>;
}

interface ProjectRow {
  id: string;
  code: string;
  name: string;
  status: ProjectStatus;
  vertical: ContentVertical;
  brandId: string | null;
  creatorId: string | null;
  contractId: string | null;
  budget: Prisma.Decimal;
  actualCost: Prisma.Decimal;
  ownerId: string | null;
  startDate: Date | null;
  dueDate: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  brand: { id: string; name: string } | null;
  creator: { id: string; name: string } | null;
  contract: { id: string; code: string } | null;
}
