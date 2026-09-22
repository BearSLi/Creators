import { Injectable, Logger } from '@nestjs/common';
import { ContentStatus, Platform, Prisma } from '@prisma/client';
import {
  ResourceNotFoundException,
  StateConflictException,
  UnprocessableException,
} from '../../common/exceptions/business.exception';
import { centsToDecimalString } from '../../common/utils/money';
import { buildPaginated, PaginatedResult, resolveOrderBy } from '../../common/utils/pagination';
import { assertOwnership, buildScopeFilter } from '../../common/utils/scope';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import { CodeGeneratorService, CODE_PREFIX } from '../common/code-generator.service';
import { CreatorService } from '../creators/creator.service';
import {
  CreateContentDto,
  PublishContentDto,
  QueryContentDto,
  ReviewContentDto,
  UpdateContentDto,
} from './dto/content.dto';
import { MetricsCollectorService, SyncResult } from './metrics-collector.service';

/**
 * 内容状态机。
 *
 * 内容没有 CANCELED：内容是可以被驳回重做或下线的实体，不是「取消」掉的排期。
 * 各流转的存在理由（不写清楚很容易被后人「顺手放开」）：
 *   - IDEA → SCRIPTING/REJECTED：选题要么进入脚本，要么在选题阶段就被否掉；
 *   - EDITING → INTERNAL_REVIEW → PLATFORM_REVIEW：内部审核通过后才提交平台审核，
 *     跳过内部审核直接提交平台，等于把合规风险丢给平台（轻则退稿，重则封号）；
 *   - PLATFORM_REVIEW → PUBLISHED：只有平台审核通过才能发布，发布时间用于结算归因；
 *   - PUBLISHED → OFFLINE：已发布内容只能下线（不能删除，见 remove 的说明）；
 *   - OFFLINE → PUBLISHED：支持「误下线后恢复」，避免只能重建内容而丢掉全部效果数据。
 */
export const CONTENT_TRANSITIONS: Record<ContentStatus, ContentStatus[]> = {
  IDEA: ['SCRIPTING', 'REJECTED'],
  SCRIPTING: ['SHOOTING', 'IDEA'],
  SHOOTING: ['EDITING', 'SCRIPTING'],
  EDITING: ['INTERNAL_REVIEW', 'SHOOTING'],
  INTERNAL_REVIEW: ['PLATFORM_REVIEW', 'EDITING', 'REJECTED'],
  PLATFORM_REVIEW: ['PUBLISHED', 'EDITING', 'REJECTED'],
  PUBLISHED: ['OFFLINE'],
  REJECTED: ['EDITING', 'IDEA'],
  OFFLINE: ['PUBLISHED'],
};

export const CONTENT_STATUS_LABELS: Record<ContentStatus, string> = {
  IDEA: '选题',
  SCRIPTING: '脚本中',
  SHOOTING: '拍摄中',
  EDITING: '剪辑中',
  INTERNAL_REVIEW: '内部审核',
  PLATFORM_REVIEW: '平台审核',
  PUBLISHED: '已发布',
  REJECTED: '已驳回',
  OFFLINE: '已下线',
};

export const PLATFORM_LABELS: Record<Platform, string> = {
  DOUYIN: '抖音',
  XIAOHONGSHU: '小红书',
  BILIBILI: '哔哩哔哩',
  WECHAT_CHANNEL: '微信视频号',
  KUAISHOU: '快手',
  WEIBO: '微博',
  TIKTOK: 'TikTok',
  YOUTUBE: 'YouTube',
  INSTAGRAM: 'Instagram',
};

/** 断言内容状态流转合法，不合法抛 409 并给出可选下一步 */
export function assertContentTransition(from: ContentStatus, to: ContentStatus): void {
  const allowed = CONTENT_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new StateConflictException(
      `内容不允许从「${CONTENT_STATUS_LABELS[from]}」变更为「${CONTENT_STATUS_LABELS[to]}」`,
      {
        from,
        to,
        allowedNext: allowed.map((status) => ({
          value: status,
          label: CONTENT_STATUS_LABELS[status],
        })),
      },
    );
  }
}

/** 前端渲染用：允许的下一步（含中文标签），用于把状态按钮渲染成合法动作 */
export function describeContentStatusMachine(from: ContentStatus) {
  return {
    current: { value: from, label: CONTENT_STATUS_LABELS[from] },
    allowedNext: (CONTENT_TRANSITIONS[from] ?? []).map((status) => ({
      value: status,
      label: CONTENT_STATUS_LABELS[status],
    })),
  };
}

/**
 * 内容服务。
 *
 * 业务定位：内容（视频/图文）是效果数据与结算归因的**最小单元**。
 * 具体表现：
 *   - 结算引擎按 contentId 逐条归因（见 settlements 模块），所以内容绝不能"换达人"；
 *   - 采集器把平台数据回填到内容上，因此已发布内容的标题/平台不能改，
 *     否则采集回来的数据会与另一条内容/另一个平台错位；
 *   - 内容状态必须严格按状态机流转，因为「已发布」意味着开始产生流水与结算义务。
 */
@Injectable()
export class ContentService {
  private readonly logger = new Logger(ContentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly codeGenerator: CodeGeneratorService,
    private readonly creatorService: CreatorService,
    private readonly metricsCollector: MetricsCollectorService,
  ) {}

  /** 内容列表。数据范围经达人归属收敛（与合同/结算模块口径一致：商务只看自己达人的内容） */
  async list(user: AuthUser, query: QueryContentDto): Promise<PaginatedResult<ContentListItem>> {
    // Content 没有 ownerId 列，数据范围必须经 creator 关联下推，否则商务能看到全部内容
    const scopeFilter = buildScopeFilter(user);

    const where: Prisma.ContentWhereInput = {
      deletedAt: null,
      creatorId: query.creatorId,
      projectId: query.projectId,
      platform: query.platform,
      status: query.status?.length ? { in: query.status } : undefined,
      // from/to 过滤发布时间：结算与周报都按发布月归因，这是最高频的时间维度
      publishedAt:
        query.from || query.to
          ? {
              gte: query.from ? new Date(query.from) : undefined,
              lte: query.to ? new Date(query.to) : undefined,
            }
          : undefined,
    };

    if (Object.keys(scopeFilter).length > 0) {
      where.creator = scopeFilter as Prisma.CreatorWhereInput;
    }

    if (query.keyword) {
      const keyword = query.keyword.trim();
      where.OR = [
        { title: { contains: keyword, mode: 'insensitive' } },
        { platformContentId: { contains: keyword, mode: 'insensitive' } },
      ];
    }

    const orderBy = resolveOrderBy(
      query.sortBy,
      query.sortOrder,
      [
        'createdAt',
        'updatedAt',
        'publishedAt',
        'scheduledAt',
        'viewCount',
        'likeCount',
        'revenueCents',
        'title',
      ] as const,
      'createdAt',
    );

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.content.findMany({
        where,
        orderBy,
        skip: query.skip,
        take: query.take,
        include: {
          creator: { select: { id: true, name: true } },
          project: { select: { id: true, name: true } },
        },
      }),
      this.prisma.content.count({ where }),
    ]);

    return buildPaginated(
      rows.map((row) => this.toListItem(row)),
      total,
      query.page,
      query.pageSize,
    );
  }

  /** 内容详情：脚本、归因、结算明细与状态机 */
  async findOne(user: AuthUser, id: string) {
    const content = await this.prisma.content.findFirst({
      where: { id, deletedAt: null },
      include: {
        creator: { select: { id: true, name: true, code: true, ownerId: true, teamId: true } },
        project: { select: { id: true, code: true, name: true, deletedAt: true } },
        settlementItems: {
          orderBy: { calculatedAt: 'desc' },
          take: 50,
          select: {
            id: true,
            netPayable: true,
            calculatedAt: true,
            settlement: { select: { code: true } },
          },
        },
      },
    });
    if (!content) throw new ResourceNotFoundException('内容');
    assertOwnership(
      user,
      { ownerId: content.creator.ownerId, teamId: content.creator.teamId },
      { resourceName: '内容' },
    );

    return {
      ...this.toListItem(content),
      script: content.script,
      aiTaskId: content.aiTaskId,
      accountId: content.accountId,
      coverUrl: content.coverUrl,
      platformContentId: content.platformContentId,
      creator: { id: content.creator.id, name: content.creator.name, code: content.creator.code },
      // 项目被软删除时对外视为「无项目」，避免详情页出现一个点不进去的幽灵项目
      project:
        content.project && !content.project.deletedAt
          ? { id: content.project.id, code: content.project.code, name: content.project.name }
          : null,
      settlementItems: content.settlementItems.map((item) => ({
        id: item.id,
        settlementCode: item.settlement.code,
        netPayable: item.netPayable.toFixed(2),
        calculatedAt: item.calculatedAt.toISOString(),
      })),
      statusMachine: describeContentStatusMachine(content.status),
    };
  }

  /**
   * 新建内容。
   *
   * 初始状态只允许 IDEA / SCRIPTING：其余状态都隐含了「已经过某道工序」的事实
   * （例如 INTERNAL_REVIEW 意味着已有成片），直接在创建时写入会让审核记录与状态自相矛盾。
   */
  async create(user: AuthUser, dto: CreateContentDto) {
    await this.creatorService.assertSchedulable(dto.creatorId);

    const initialStatus = dto.status ?? ContentStatus.IDEA;
    // 显式声明为 ContentStatus[]：数组字面量会被推断成窄联合类型，includes(ContentStatus) 过不了类型检查
    const allowedInitialStatuses: ContentStatus[] = [ContentStatus.IDEA, ContentStatus.SCRIPTING];
    if (!allowedInitialStatuses.includes(initialStatus)) {
      throw new UnprocessableException(
        `新建内容只允许初始状态为「${CONTENT_STATUS_LABELS.IDEA}」或「${CONTENT_STATUS_LABELS.SCRIPTING}」，其余状态必须通过状态流转接口推进`,
        { allowedInitial: allowedInitialStatuses },
      );
    }

    const project = await this.resolveProject(dto.projectId, dto.creatorId);
    await this.resolveAccount(dto.accountId, dto.creatorId, dto.platform);

    // 业务编号在事务内分配（与业务写入同事务，失败则编号回滚，不留空洞）。
    // 注意：Content 表当前没有 code 列（见 schema.prisma），因此该编号只用于返回给前端与日志，
    // 不落库；对外沟通仍以 id 为准。这一点已在交付说明中标注为 schema 缺口。
    let contentCode = '';
    const created = await this.prisma.withTransaction(async (tx) => {
      contentCode = await this.codeGenerator.next(CODE_PREFIX.CONTENT, tx);
      return tx.content.create({
        data: {
          projectId: project?.id ?? null,
          creatorId: dto.creatorId,
          accountId: dto.accountId ?? null,
          title: dto.title,
          script: dto.script ?? null,
          aiTaskId: dto.aiTaskId ?? null,
          platform: dto.platform,
          status: initialStatus,
          durationSec: dto.durationSec ?? 0,
          scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null,
        },
        select: { id: true },
      });
    });

    this.logger.log(
      `新建内容 id=${created.id} 编号=${contentCode} title=${dto.title} by=${user.email}`,
    );
    const detail = await this.findOne(user, created.id);
    return { ...detail, contentCode };
  }

  /**
   * 编辑内容。
   *
   * 已发布内容禁止改标题与平台：
   *   采集器是按「平台 + 平台内容 ID」拉数据的，标题/平台是运营对账时的识别依据。
   *   发布后改动会让同一条内容在周报里前后叫两个名字，或者让数据挂到另一个平台口径上，
   *   出现「明明没投小红书却有小红的播放」这类无法解释的差异。
   */
  async update(user: AuthUser, id: string, dto: UpdateContentDto) {
    const existing = await this.loadForWrite(id);
    assertOwnership(
      user,
      { ownerId: existing.creator.ownerId, teamId: existing.creator.teamId },
      { resourceName: '内容' },
    );

    if (existing.status === ContentStatus.PUBLISHED) {
      if (dto.title !== undefined && dto.title !== existing.title) {
        throw new StateConflictException(
          '已发布内容不允许修改标题：标题是采集数据与周报的识别依据，改动会导致已采集数据与内容对不上。如需更正请在内容备注中说明',
        );
      }
      if (dto.platform !== undefined && dto.platform !== existing.platform) {
        throw new StateConflictException(
          '已发布内容不允许修改平台：平台决定采集口径与结算平台费率，改动会让历史效果数据错位',
        );
      }
      if (dto.creatorId !== undefined && dto.creatorId !== existing.creatorId) {
        throw new StateConflictException(
          '已发布内容不允许更换达人：结算按内容归因到达人，换人会让已产生的结算义务与内容归属矛盾',
        );
      }
    }

    if (dto.creatorId && dto.creatorId !== existing.creatorId) {
      await this.creatorService.assertSchedulable(dto.creatorId);
      const settled = await this.prisma.settlementItem.count({ where: { contentId: id } });
      if (settled > 0) {
        throw new StateConflictException(
          `该内容已产生 ${settled} 笔结算明细，更换达人会让历史结算归属错乱，请改为新建内容`,
        );
      }
    }

    const project = await this.resolveProject(
      dto.projectId === undefined ? existing.projectId ?? undefined : dto.projectId,
      dto.creatorId ?? existing.creatorId,
    );
    const platform = dto.platform ?? existing.platform;
    await this.resolveAccount(
      dto.accountId === undefined ? existing.accountId ?? undefined : dto.accountId,
      dto.creatorId ?? existing.creatorId,
      platform,
    );

    await this.prisma.content.update({
      where: { id },
      data: {
        creatorId: dto.creatorId,
        projectId: project?.id,
        accountId: dto.accountId,
        title: dto.title,
        script: dto.script,
        platform: dto.platform,
        durationSec: dto.durationSec,
        scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : undefined,
        // AI 合规预检回写：分值 + 风险项一起写，避免只有分数没有依据
        complianceScore: dto.complianceScore,
        complianceFlags: dto.complianceFlags as unknown as Prisma.InputJsonValue | undefined,
      },
    });

    return this.findOne(user, id);
  }

  /** 提交平台审核：内部审核 → 平台审核（走状态机断言，避免跳过内部审核） */
  async submitReview(user: AuthUser, id: string) {
    const existing = await this.loadForWrite(id);
    assertOwnership(
      user,
      { ownerId: existing.creator.ownerId, teamId: existing.creator.teamId },
      { resourceName: '内容' },
    );

    assertContentTransition(existing.status, ContentStatus.PLATFORM_REVIEW);

    await this.prisma.content.update({
      where: { id },
      data: { status: ContentStatus.PLATFORM_REVIEW },
    });
    this.logger.log(`内容提交平台审核 id=${id} by=${user.email}`);
    return this.findOne(user, id);
  }

  /**
   * 审核。
   *
   * approved=true 时按当前状态推进：INTERNAL_REVIEW → PLATFORM_REVIEW，
   * PLATFORM_REVIEW → PUBLISHED 并回填 publishedAt（结算按发布时间归因，必须有值）。
   * approved=false 时置 REJECTED 并记录驳回原因 —— 原因会回显给内容团队，
   * 没有原因的驳回在生产上等于让创作者猜，返工率极高，因此强制填写。
   */
  async review(user: AuthUser, id: string, dto: ReviewContentDto) {
    const existing = await this.loadForWrite(id);
    assertOwnership(
      user,
      { ownerId: existing.creator.ownerId, teamId: existing.creator.teamId },
      { resourceName: '内容' },
    );

    const nextStatus = dto.approved
      ? this.resolveApprovedNext(existing.status)
      : ContentStatus.REJECTED;
    assertContentTransition(existing.status, nextStatus);

    if (!dto.approved && !dto.rejectReason?.trim() && !dto.note?.trim()) {
      throw new UnprocessableException(
        '驳回必须填写原因（rejectReason 或 note）：内容团队需要知道改什么才能重做',
        { field: 'rejectReason' },
      );
    }

    const now = new Date();
    await this.prisma.content.update({
      where: { id },
      data: {
        status: nextStatus,
        reviewerId: user.id,
        reviewNote: dto.note ?? existing.reviewNote,
        rejectReason: dto.approved ? null : (dto.rejectReason ?? dto.note ?? '审核驳回'),
        // 平台审核通过即视为发布：publishedAt 是结算归因与采集窗口的基准时间
        ...(nextStatus === ContentStatus.PUBLISHED
          ? { publishedAt: existing.publishedAt ?? now }
          : {}),
      },
    });

    this.logger.log(
      `内容审核 id=${id} ${existing.status} → ${nextStatus} by=${user.email}${dto.approved ? '' : ` 驳回原因=${dto.rejectReason ?? dto.note}`}`,
    );
    return this.findOne(user, id);
  }

  /** 发布：状态必须允许到 PUBLISHED（平台审核通过或从已下线恢复） */
  async publish(user: AuthUser, id: string, dto: PublishContentDto) {
    const existing = await this.loadForWrite(id);
    assertOwnership(
      user,
      { ownerId: existing.creator.ownerId, teamId: existing.creator.teamId },
      { resourceName: '内容' },
    );

    assertContentTransition(existing.status, ContentStatus.PUBLISHED);

    const publishedAt = dto.publishedAt ? new Date(dto.publishedAt) : new Date();
    if (Number.isNaN(publishedAt.getTime())) {
      throw new UnprocessableException('publishedAt 日期格式不正确');
    }

    await this.prisma.content.update({
      where: { id },
      data: {
        status: ContentStatus.PUBLISHED,
        platformContentId: dto.platformContentId ?? existing.platformContentId,
        publishedUrl: dto.publishedUrl ?? existing.publishedUrl,
        // 补录历史内容时允许指定发布时间，否则取当前时间
        publishedAt: existing.publishedAt ?? publishedAt,
      },
    });

    this.logger.log(`内容发布 id=${id} platformContentId=${dto.platformContentId ?? '-'} by=${user.email}`);
    return this.findOne(user, id);
  }

  /**
   * 手动触发一次效果数据采集。
   *
   * 采集失败不抛异常（返回 success:false）：接口层崩溃会让运营以为「系统坏了」，
   * 而真实原因往往只是某个平台临时限流；返回结构化的失败信息便于前端提示重试。
   */
  async syncMetrics(user: AuthUser, id: string): Promise<SyncResult & { metrics?: ContentMetricsView }> {
    const existing = await this.loadForWrite(id);
    assertOwnership(
      user,
      { ownerId: existing.creator.ownerId, teamId: existing.creator.teamId },
      { resourceName: '内容' },
    );

    const result = await this.metricsCollector.syncContentMetrics(id);
    if (!result.success) return result;

    const refreshed = await this.prisma.content.findUniqueOrThrow({
      where: { id },
      select: {
        viewCount: true,
        likeCount: true,
        commentCount: true,
        shareCount: true,
        collectCount: true,
        completionRateBp: true,
        revenueCents: true,
        conversions: true,
        metricsSyncedAt: true,
      },
    });

    return {
      ...result,
      metrics: {
        // BigInt 一律转字符串：JSON 序列化遇 BigInt 会抛错
        viewCount: refreshed.viewCount.toString(),
        likeCount: refreshed.likeCount.toString(),
        commentCount: refreshed.commentCount.toString(),
        shareCount: refreshed.shareCount.toString(),
        collectCount: refreshed.collectCount.toString(),
        completionRate: refreshed.completionRateBp / 100,
        revenueYuan: centsToDecimalString(Number(refreshed.revenueCents)),
        conversions: refreshed.conversions,
        metricsSyncedAt: refreshed.metricsSyncedAt?.toISOString() ?? null,
      },
    };
  }

  /**
   * 软删除内容。
   *
   * 已发布内容一律拒绝：它关联着采集到的效果数据与结算明细（SettlementItem.contentId），
   * 删除会让财务对账时找不到收入来源。需要停止对外展示请用「下线」。
   * 未发布但已进入结算明细的内容同样拒绝，理由一致。
   */
  async remove(user: AuthUser, id: string): Promise<{ id: string; deleted: true }> {
    const existing = await this.prisma.content.findFirst({
      where: { id, deletedAt: null },
      include: { creator: { select: { ownerId: true, teamId: true } } },
    });
    if (!existing) throw new ResourceNotFoundException('内容');
    assertOwnership(
      user,
      { ownerId: existing.creator.ownerId, teamId: existing.creator.teamId },
      { resourceName: '内容' },
    );

    if (existing.status === ContentStatus.PUBLISHED) {
      throw new StateConflictException(
        '已发布内容不允许删除：它关联着平台效果数据与结算明细，删除后财务无法追溯收入来源。如需停止展示请使用「下线」',
        { status: existing.status, allowedNext: CONTENT_TRANSITIONS[existing.status] },
      );
    }

    const settlementItems = await this.prisma.settlementItem.count({ where: { contentId: id } });
    if (settlementItems > 0) {
      throw new StateConflictException(
        `该内容已产生 ${settlementItems} 笔结算明细，删除会让结算归因失去载体，请先处理对应结算单`,
        { settlementItemCount: settlementItems },
      );
    }

    await this.prisma.content.update({ where: { id }, data: { deletedAt: new Date() } });
    this.logger.log(`软删除内容 id=${id} title=${existing.title} by=${user.email}`);
    return { id, deleted: true };
  }

  // -------------------------------------------------------------------------
  // 校验与内部工具
  // -------------------------------------------------------------------------

  /** 审核通过时的下一个状态；不在可审核状态时给出明确 409 */
  private resolveApprovedNext(current: ContentStatus): ContentStatus {
    if (current === ContentStatus.INTERNAL_REVIEW) return ContentStatus.PLATFORM_REVIEW;
    if (current === ContentStatus.PLATFORM_REVIEW) return ContentStatus.PUBLISHED;
    throw new StateConflictException(
      `内容当前为「${CONTENT_STATUS_LABELS[current]}」，该状态没有可执行的审核通过动作（审核只适用于内部审核/平台审核）`,
      { status: current },
    );
  }

  /**
   * 校验项目归属与状态。
   * 已取消的项目不允许新增内容：否则会出现「项目已取消，内容还在制作」的矛盾数据，
   * 成本归集时会算到一个不该再花钱的项目上。
   */
  private async resolveProject(
    projectId: string | undefined | null,
    creatorId: string,
  ): Promise<{ id: string } | null> {
    if (!projectId) return null;

    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { id: true, status: true, creatorId: true, code: true },
    });
    if (!project) throw new ResourceNotFoundException('项目', projectId);

    if (project.status === 'CANCELED') {
      throw new StateConflictException(
        `项目 ${project.code} 已取消，不允许再挂载内容`,
        { projectId: project.id, status: project.status },
      );
    }
    if (project.creatorId && project.creatorId !== creatorId) {
      throw new UnprocessableException(
        `项目 ${project.code} 归属的达人与内容达人不是同一人：内容结算按达人归因，挂错项目会导致成本与收入对不上`,
        { projectId: project.id, projectCreatorId: project.creatorId, creatorId },
      );
    }
    return { id: project.id };
  }

  /** 校验发布账号：必须是该达人自己在该平台上的账号，否则采集会把别人账号的数据算到本条内容上 */
  private async resolveAccount(
    accountId: string | undefined | null,
    creatorId: string,
    platform: Platform,
  ): Promise<{ id: string } | null> {
    if (!accountId) return null;

    const account = await this.prisma.platformAccount.findFirst({
      where: { id: accountId, deletedAt: null },
      select: { id: true, creatorId: true, platform: true },
    });
    if (!account) throw new ResourceNotFoundException('平台账号', accountId);
    if (account.creatorId !== creatorId) {
      throw new UnprocessableException('所选平台账号不属于该达人，请重新选择');
    }
    if (account.platform !== platform) {
      throw new UnprocessableException(
        `所选账号是「${PLATFORM_LABELS[account.platform]}」账号，与内容平台「${PLATFORM_LABELS[platform]}」不一致`,
      );
    }
    return { id: account.id };
  }

  private async loadForWrite(id: string) {
    const content = await this.prisma.content.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        title: true,
        status: true,
        platform: true,
        creatorId: true,
        projectId: true,
        accountId: true,
        publishedAt: true,
        publishedUrl: true,
        platformContentId: true,
        reviewNote: true,
        creator: { select: { ownerId: true, teamId: true } },
      },
    });
    if (!content) throw new ResourceNotFoundException('内容');
    return content;
  }

  private toListItem(row: ContentRow): ContentListItem {
    return {
      id: row.id,
      title: row.title,
      creatorId: row.creatorId,
      creatorName: row.creator.name,
      projectId: row.projectId,
      projectName: row.project?.name ?? null,
      platform: row.platform,
      platformLabel: PLATFORM_LABELS[row.platform],
      status: row.status,
      statusLabel: CONTENT_STATUS_LABELS[row.status],
      durationSec: row.durationSec,
      scheduledAt: row.scheduledAt?.toISOString() ?? null,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      // 大数指标统一转字符串：前端 JS 的 Number 精度只有 53 位，
      // 千万级播放量虽然安全，但粉丝/点赞上限不可控，统一字符串避免将来精度事故
      viewCount: row.viewCount.toString(),
      likeCount: row.likeCount.toString(),
      commentCount: row.commentCount.toString(),
      shareCount: row.shareCount.toString(),
      collectCount: row.collectCount.toString(),
      revenueYuan: centsToDecimalString(Number(row.revenueCents)),
      // 完播率以「百分数」返回（基点 / 100），前端直接展示不做换算
      completionRate: row.completionRateBp / 100,
      conversions: row.conversions,
      complianceScore: row.complianceScore,
      complianceFlags: row.complianceFlags,
      reviewNote: row.reviewNote,
      rejectReason: row.rejectReason,
      publishedUrl: row.publishedUrl,
      metricsSyncedAt: row.metricsSyncedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

export interface ContentListItem {
  id: string;
  title: string;
  creatorId: string;
  creatorName: string;
  projectId: string | null;
  projectName: string | null;
  platform: Platform;
  platformLabel: string;
  status: ContentStatus;
  statusLabel: string;
  durationSec: number;
  scheduledAt: string | null;
  publishedAt: string | null;
  viewCount: string;
  likeCount: string;
  commentCount: string;
  shareCount: string;
  collectCount: string;
  revenueYuan: string;
  completionRate: number;
  conversions: number;
  complianceScore: number | null;
  complianceFlags: Prisma.JsonValue | null;
  reviewNote: string | null;
  rejectReason: string | null;
  publishedUrl: string | null;
  metricsSyncedAt: string | null;
  createdAt: string;
}

export interface ContentMetricsView {
  viewCount: string;
  likeCount: string;
  commentCount: string;
  shareCount: string;
  collectCount: string;
  completionRate: number;
  revenueYuan: string;
  conversions: number;
  metricsSyncedAt: string | null;
}

interface ContentRow {
  id: string;
  title: string;
  creatorId: string;
  projectId: string | null;
  platform: Platform;
  status: ContentStatus;
  durationSec: number;
  scheduledAt: Date | null;
  publishedAt: Date | null;
  viewCount: bigint;
  likeCount: bigint;
  commentCount: bigint;
  shareCount: bigint;
  collectCount: bigint;
  completionRateBp: number;
  revenueCents: bigint;
  conversions: number;
  complianceScore: number | null;
  complianceFlags: Prisma.JsonValue | null;
  reviewNote: string | null;
  rejectReason: string | null;
  publishedUrl: string | null;
  metricsSyncedAt: Date | null;
  createdAt: Date;
  creator: { id: string; name: string };
  project: { id: string; name: string } | null;
}
