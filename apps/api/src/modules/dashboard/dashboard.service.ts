import { Injectable } from '@nestjs/common';
import { ContentStatus, CreatorStatus, Platform, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import { buildScopeFilter } from '../../common/utils/scope';
import { decimalToCents } from '../../common/utils/money';
import { extractCount } from '../../common/utils/group-count';

/**
 * 经营看板聚合服务。
 *
 * 设计取舍（面试常被问到的点）：为什么不用一条超大 SQL 或缓存宽表？
 *   - 内部工具的看板并发极低（几十人同时在线），实时聚合完全够用；
 *   - 宽表/物化视图会引入「数据延迟」的解释成本，运营看到数字与明细对不上会失去信任；
 *   - 这里用有限几条聚合查询 + 一次事务并发执行，P95 仍在毫秒级。
 * 如果未来数据量增长到千万级内容，再引入「按天预聚合表 + 缓存」，
 * 届时改动被限制在本 Service 内（上层接口契约不变）。
 */
@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  /** 看板总览：KPI + 漏斗 + 趋势 + 分布 + 排行榜 + 待办 */
  async overview(user: AuthUser, range: { from?: Date; to?: Date }) {
    const to = range.to ?? new Date();
    const from = range.from ?? new Date(to.getTime() - 29 * 86_400_000);
    const prevFrom = new Date(from.getTime() - (to.getTime() - from.getTime()));
    const prevTo = from;

    const scopeFilter = buildScopeFilter(user) as Prisma.CreatorWhereInput;
    const monthStart = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));

    /**
     * Settlement 模型上**没有** creator 关系字段（只有裸 creatorId），
     * 因此不能像 Creator/Content 那样直接把 scopeFilter 展开进 where，
     * 否则 Prisma 会报「'creator' does not exist in type SettlementWhereInput」。
     * 折中做法：先把范围内（ALL 范围时跳过查询）的达人 id 取出来，
     * 再用 creatorId: { in: ... } 过滤结算单。数据范围仍然严格生效。
     */
    const scopedCreatorIds = await this.resolveScopedCreatorIds(scopeFilter);

    const [
      creatorTotal,
      creatorActive,
      creatorSignedThisMonth,
      contentPublished,
      contentPublishedPrev,
      revenueAgg,
      revenuePrevAgg,
      settlementPending,
      engagementAgg,
      funnelRows,
      revenueTrendRows,
      platformRows,
      verticalRows,
      topCreatorRows,
      contractExpiring,
      contentPendingReview,
      settlementPendingApproval,
      aiFailed,
    ] = await this.prisma.$transaction([
      this.prisma.creator.count({ where: { deletedAt: null, ...scopeFilter } }),
      this.prisma.creator.count({
        where: { deletedAt: null, status: CreatorStatus.ACTIVE, ...scopeFilter },
      }),
      this.prisma.creator.count({
        where: { deletedAt: null, signedAt: { gte: monthStart }, ...scopeFilter },
      }),
      this.prisma.content.count({
        where: {
          deletedAt: null,
          status: ContentStatus.PUBLISHED,
          publishedAt: { gte: from, lte: to },
          creator: scopeFilter,
        },
      }),
      this.prisma.content.count({
        where: {
          deletedAt: null,
          status: ContentStatus.PUBLISHED,
          publishedAt: { gte: prevFrom, lte: prevTo },
          creator: scopeFilter,
        },
      }),
      this.prisma.content.aggregate({
        where: {
          deletedAt: null,
          status: ContentStatus.PUBLISHED,
          publishedAt: { gte: from, lte: to },
          creator: scopeFilter,
        },
        _sum: { revenueCents: true, viewCount: true },
      }),
      this.prisma.content.aggregate({
        where: {
          deletedAt: null,
          status: ContentStatus.PUBLISHED,
          publishedAt: { gte: prevFrom, lte: prevTo },
          creator: scopeFilter,
        },
        _sum: { revenueCents: true },
      }),
      this.prisma.settlement.aggregate({
        where: {
          deletedAt: null,
          status: { in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'] },
          creatorId: scopedCreatorIds,
        },
        _sum: { netPayable: true },
        _count: { _all: true },
      }),
      this.prisma.platformAccount.aggregate({
        // 软删除过滤 + 经 creator 关系做数据范围收敛（PlatformAccount 自身无 ownerId/teamId）
        where: { deletedAt: null, creator: scopeFilter },
        _avg: { engagementRateBp: true },
        _count: { _all: true },
      }),
      this.prisma.creator.groupBy({
        by: ['status'],
        where: { deletedAt: null, ...scopeFilter },
        // 用 { _all: true } 而不是 true：前者返回确定的 { _all: number }，
        // 后者的类型是 number | undefined（Prisma 无法静态确认 _count 一定会被填充），
        // 会在下游算术运算处产生一串 TS18048「possibly undefined」。
        _count: { _all: true },
        orderBy: { status: 'asc' },
      }),
      // 趋势按天聚合：用 PostgreSQL 的 date_trunc 在库内聚合，
      // 避免把明细拉到应用层再分组（内容量增长后这一步差别很大）。
      //
      // 注意列名必须写成**带双引号的 camelCase**：
      // 本项目 schema 没有给字段加 @map，所以 Prisma 建出来的列名就是 publishedAt、
      // revenueCents、deletedAt。而 PostgreSQL 会把**未加引号**的标识符折叠成小写，
      // 于是 c.published_at 既不对（名字本来就不是下划线），
      // 即使写 c.publishedAt 也会被折成 publishedat 而找不到列。
      // 原始 SQL 里引用驼峰列名，双引号是必需的。
      this.prisma.$queryRaw<Array<{ day: Date; revenueCents: bigint | null; contentCount: bigint }>>`
        SELECT date_trunc('day', c."publishedAt") AS day,
               SUM(c."revenueCents")               AS "revenueCents",
               COUNT(*)                            AS "contentCount"
        FROM contents c
        WHERE c."deletedAt" IS NULL
          AND c.status = 'PUBLISHED'
          AND c."publishedAt" >= ${from}
          AND c."publishedAt" <= ${to}
        GROUP BY 1
        ORDER BY 1 ASC
      `,
      this.prisma.content.groupBy({
        by: ['platform'],
        where: {
          deletedAt: null,
          status: ContentStatus.PUBLISHED,
          publishedAt: { gte: from, lte: to },
          creator: scopeFilter,
        },
        _count: { _all: true },
        _sum: { revenueCents: true },
        orderBy: { platform: 'asc' },
      }),
      this.prisma.creator.groupBy({
        by: ['verticals'],
        where: { deletedAt: null, ...scopeFilter },
        _count: { _all: true },
        orderBy: { verticals: 'asc' },
      }),
      this.prisma.content.groupBy({
        by: ['creatorId'],
        where: {
          deletedAt: null,
          status: ContentStatus.PUBLISHED,
          publishedAt: { gte: from, lte: to },
          creator: scopeFilter,
        },
        _sum: { revenueCents: true, viewCount: true },
        _count: { _all: true },
        orderBy: { _sum: { revenueCents: 'desc' } },
        take: 10,
      }),
      this.prisma.contract.count({
        where: {
          deletedAt: null,
          status: 'ACTIVE',
          effectiveTo: { lte: new Date(to.getTime() + 30 * 86_400_000) },
          creator: scopeFilter,
        },
      }),
      this.prisma.content.count({
        where: {
          deletedAt: null,
          status: { in: ['INTERNAL_REVIEW', 'PLATFORM_REVIEW'] },
          creator: scopeFilter,
        },
      }),
      this.prisma.settlement.count({
        where: { deletedAt: null, status: 'PENDING_APPROVAL', creatorId: scopedCreatorIds },
      }),
      this.prisma.aiTask.count({
        where: { status: 'FAILED', createdAt: { gte: from, lte: to } },
      }),
    ]);

    const revenueCents = Number(revenueAgg._sum.revenueCents ?? 0n);
    const revenuePrevCents = Number(revenuePrevAgg._sum.revenueCents ?? 0n);

    // 达人排行榜需要姓名，单独查一次（groupBy 无法 join）
    const creatorIds = topCreatorRows.map((row) => row.creatorId);
    const creators = creatorIds.length
      ? await this.prisma.creator.findMany({
          where: { id: { in: creatorIds } },
          select: { id: true, name: true, code: true, tier: true },
        })
      : [];
    const creatorMap = new Map(creators.map((item) => [item.id, item]));

    return {
      range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      kpi: {
        creatorTotal,
        creatorActive,
        creatorSignedThisMonth,
        contentPublished,
        contentPublishedDelta: contentPublished - contentPublishedPrev,
        revenueYuan: (revenueCents / 100).toFixed(2),
        revenueDeltaYuan: ((revenueCents - revenuePrevCents) / 100).toFixed(2),
        revenueGrowthPercent:
          revenuePrevCents > 0
            ? Number((((revenueCents - revenuePrevCents) / revenuePrevCents) * 100).toFixed(1))
            : null,
        totalViewCount: Number(revenueAgg._sum.viewCount ?? 0n).toString(),
        settlementPendingYuan: (settlementPending._sum?.netPayable ?? new Prisma.Decimal(0)).toFixed(2),
        settlementPendingCount: extractCount(settlementPending),
        avgEngagementRatePercent: Number(((engagementAgg._avg.engagementRateBp ?? 0) / 100).toFixed(2)),
      },
      /** 达人合作漏斗：线索 → 建联 → 评估 → 签约 → 合作中，用于看转化瓶颈 */
      funnel: buildFunnel(funnelRows),
      revenueTrend: revenueTrendRows.map((row) => ({
        date: row.day.toISOString().slice(0, 10),
        revenueYuan: (Number(row.revenueCents ?? 0n) / 100).toFixed(2),
        contentCount: Number(row.contentCount),
      })),
      platformDistribution: platformRows.map((row) => ({
        platform: row.platform,
        platformLabel: PLATFORM_LABELS[row.platform] ?? row.platform,
        contentCount: extractCount(row),
        revenueYuan: (Number(row._sum?.revenueCents ?? 0n) / 100).toFixed(2),
      })),
      verticalDistribution: verticalRows
        .flatMap((row) => {
          // 一个达人可能有多个垂类；没有垂类时归入 OTHER，避免看板出现空分类
          const count = extractCount(row);
          return row.verticals.length > 0
            ? row.verticals.map((vertical) => ({ vertical, creatorCount: count }))
            : [{ vertical: 'OTHER', creatorCount: count }];
        })
        .reduce<Array<{ vertical: string; creatorCount: number }>>((acc, item) => {
          // 多个达人共享同一垂类时累加，用于看公司产能结构
          const existing = acc.find((entry) => entry.vertical === item.vertical);
          if (existing) existing.creatorCount += item.creatorCount;
          else acc.push({ ...item });
          return acc;
        }, [])
        .sort((a, b) => b.creatorCount - a.creatorCount),
      topCreators: topCreatorRows.map((row) => {
        const contentCount = extractCount(row);
        const totalView = Number(row._sum?.viewCount ?? 0n);
        return {
          creatorId: row.creatorId,
          creatorName: creatorMap.get(row.creatorId)?.name ?? '已删除达人',
          creatorCode: creatorMap.get(row.creatorId)?.code ?? '-',
          tier: creatorMap.get(row.creatorId)?.tier ?? 'C',
          revenueYuan: (Number(row._sum?.revenueCents ?? 0n) / 100).toFixed(2),
          contentCount,
          avgViewCount: contentCount > 0 ? Math.round(totalView / contentCount) : 0,
        };
      }),
      pendingTodos: [
        {
          type: 'CONTRACT_EXPIRING',
          label: '30 天内到期的合同',
          count: contractExpiring,
          link: '/contracts?status=ACTIVE',
        },
        {
          type: 'CONTENT_REVIEW',
          label: '待审核内容',
          count: contentPendingReview,
          link: '/contents?status=INTERNAL_REVIEW',
        },
        {
          type: 'SETTLEMENT_DUE',
          label: '待审批结算单',
          count: settlementPendingApproval,
          link: '/settlements?status=PENDING_APPROVAL',
        },
        {
          type: 'ANOMALY_ALERT',
          label: 'AI 任务失败待排查',
          count: aiFailed,
          link: '/ai/tasks?status=FAILED',
        },
      ].filter((item) => item.count > 0),
    };
  }

  /**
   * 把「达人维度的数据范围条件」翻译成结算单可用的 creatorId 过滤条件。
   *
   * 背景：Settlement 模型上只有裸 creatorId，没有 creator 关系字段，
   * 所以不能像 Creator/Content 那样直接把 scopeFilter 展开进 where。
   * 这里显式解析出范围内的达人 id，避免为了「看起来统一」而去改数据模型
   * （给结算单加关系会带来额外的外键约束与迁移成本，收益不成正比）。
   *
   * ALL 范围（scopeFilter 为空）时返回 undefined，表示不加过滤 —— 少一次全表 id 查询。
   */
  private async resolveScopedCreatorIds(
    scopeFilter: Prisma.CreatorWhereInput,
  ): Promise<{ in: string[] } | undefined> {
    if (Object.keys(scopeFilter).length === 0) return undefined;
    const creators = await this.prisma.creator.findMany({
      where: { deletedAt: null, ...scopeFilter },
      select: { id: true },
    });
    return { in: creators.map((creator) => creator.id) };
  }

  /**
   * 达人贡献排行（带分页），支持按流水/内容数/播放量排序。
   * 与 overview 里的 topCreators 区别：这里是完整可分页的榜单，用于绩效考核场景。
   */
  async creatorRanking(
    user: AuthUser,
    params: { from: Date; to: Date; limit: number; metric: 'revenue' | 'content' | 'view' },
  ) {
    const scopeFilter = buildScopeFilter(user) as Prisma.CreatorWhereInput;
    const rows = await this.prisma.content.groupBy({
      by: ['creatorId'],
      where: {
        deletedAt: null,
        status: 'PUBLISHED',
        publishedAt: { gte: params.from, lte: params.to },
        creator: scopeFilter,
      },
      _sum: { revenueCents: true, viewCount: true, likeCount: true },
      _count: { _all: true },
      orderBy:
        params.metric === 'content'
          ? { _count: { creatorId: 'desc' } }
          : params.metric === 'view'
            ? { _sum: { viewCount: 'desc' } }
            : { _sum: { revenueCents: 'desc' } },
      take: params.limit,
    });

    const creators = await this.prisma.creator.findMany({      where: { id: { in: rows.map((row) => row.creatorId) } },
      select: { id: true, name: true, code: true, tier: true, score: true },
    });
    const creatorMap = new Map(creators.map((item) => [item.id, item]));

    return rows.map((row, index) => {
      const creator = creatorMap.get(row.creatorId);
      const contentCount = extractCount(row);
      return {
        rank: index + 1,
        creatorId: row.creatorId,
        creatorName: creator?.name ?? '已删除达人',
        creatorCode: creator?.code ?? '-',
        tier: creator?.tier ?? 'C',
        score: creator?.score ?? 0,
        revenueYuan: (Number(row._sum?.revenueCents ?? 0n) / 100).toFixed(2),
        contentCount,
        totalViewCount: Number(row._sum?.viewCount ?? 0n).toString(),
        totalLikeCount: Number(row._sum?.likeCount ?? 0n).toString(),
        avgRevenuePerContentYuan:
          contentCount > 0
            ? (decimalToCents(row._sum?.revenueCents ?? 0) / contentCount / 100).toFixed(2)
            : '0.00',
      };
    });
  }
}

export const PLATFORM_LABELS: Record<Platform, string> = {
  DOUYIN: '抖音',
  XIAOHONGSHU: '小红书',
  BILIBILI: '哔哩哔哩',
  WECHAT_CHANNEL: '视频号',
  KUAISHOU: '快手',
  WEIBO: '微博',
  TIKTOK: 'TikTok',
  YOUTUBE: 'YouTube',
  INSTAGRAM: 'Instagram',
};

export const CREATOR_STATUS_LABELS_FOR_FUNNEL: Array<{ status: CreatorStatus; label: string }> = [
  { status: CreatorStatus.LEAD, label: '线索' },
  { status: CreatorStatus.CONTACTING, label: '建联中' },
  { status: CreatorStatus.EVALUATING, label: '评估中' },
  { status: CreatorStatus.SIGNED, label: '已签约' },
  { status: CreatorStatus.ACTIVE, label: '合作中' },
];

/**
 * 漏斗按累计口径计算（不是各状态人数简单罗列）：
 * 「合作中」的达人必然经历过线索与签约，所以每层应包含更后层的人数，
 * 否则漏斗会出现「下层比上层多」的荒谬结果（很多系统的看板就犯这个错）。
 */
function buildFunnel(rows: Array<{ status: CreatorStatus; _count?: unknown }>): Array<{
  stage: string;
  label: string;
  count: number;
  conversionFromPrevPercent: number | null;
}> {
  // _count 的类型由 extractCount 统一收敛，避免把 Prisma 的类型退化带到业务逻辑里
  const countMap = new Map(rows.map((row) => [row.status, extractCount(row)]));
  const cumulative: number[] = [];
  for (let index = 0; index < CREATOR_STATUS_LABELS_FOR_FUNNEL.length; index += 1) {
    // 从当前阶段到最后一阶段的累计人数
    const total = CREATOR_STATUS_LABELS_FOR_FUNNEL.slice(index).reduce(
      (sum, entry) => sum + (countMap.get(entry.status) ?? 0),
      0,
    );
    cumulative.push(total);
  }

  return CREATOR_STATUS_LABELS_FOR_FUNNEL.map((entry, index) => ({
    stage: entry.status,
    label: entry.label,
    count: cumulative[index] ?? 0,
    conversionFromPrevPercent:
      index === 0 || !cumulative[index - 1]
        ? null
        : Number((((cumulative[index] ?? 0) / (cumulative[index - 1] ?? 1)) * 100).toFixed(1)),
  }));
}
