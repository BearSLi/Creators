import { Injectable, Logger } from '@nestjs/common';
import { DataSourceType, Platform, Prisma } from '@prisma/client';
import { env } from '../../config/index';
import {
  ResourceNotFoundException,
  UnprocessableException,
  UpstreamUnavailableException,
} from '../../common/exceptions/business.exception';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * 账号/内容数据采集器。
 *
 * 业务背景：效果数据（播放、互动、流水）是结算归因与达人复盘的输入。若数据靠人工填，
 * 一是慢（运营每天要抄几十个号），二是没有证据链——结算争议时无法解释数字从哪来。
 * 所以这里做「驱动可插拔」的采集层：
 *
 *   CollectorDriver（接口） ── MockCollectorDriver（默认，确定性伪随机）
 *                          └─ HttpCollectorDriver（真实模式骨架，调各平台开放接口）
 *
 * 为什么要有 Mock 驱动：平台开放接口的申请周期以周计，而排期、结算、看板全都依赖这份数据。
 * Mock 让整条链路（采集 → 快照 → 结算）在没有平台凭证时也能端到端跑通与联调，
 * 且用「输入哈希做种子」保证同一账号/内容重复采集结果一致——否则每次跑测试的数字都在变，
 * 无法写断言，也无法复现问题。
 *
 * 失败处理原则：单个账号采集失败绝不能让整批任务崩掉（几百个账号里挂一个就全军覆没，
 * 而且越靠前的账号越容易被反复重试）。因此 sync* 方法捕获异常、写入 syncError 并返回
 * { success: false }，由调用方决定是否告警；lastSyncedAt 保持上一次成功时间，
 * 「数据陈旧告警」才不会被一次失败刷新掉。
 */

// ---------------------------------------------------------------------------
// 采集数据契约
// ---------------------------------------------------------------------------

export interface AccountStats {
  followerCount: number;
  followingCount: number;
  totalLikes: bigint;
  totalWorks: number;
  /** 账号累计播放（用于推算平均播放） */
  playCount: bigint;
  likeCount: bigint;
  commentCount: bigint;
  shareCount: bigint;
  collectCount: bigint;
  /** 互动率，万分比（1250 = 12.50%） */
  engagementRateBp: number;
  /** 电商/分成口径收入（分） */
  revenueCents: bigint;
  dataSource: DataSourceType;
  rawPayload?: unknown;
}

export interface ContentStats {
  viewCount: bigint;
  likeCount: bigint;
  commentCount: bigint;
  shareCount: bigint;
  collectCount: bigint;
  /** 完播率，万分比 */
  completionRateBp: number;
  revenueCents: bigint;
  conversions: number;
  dataSource: DataSourceType;
  rawPayload?: unknown;
}

export interface AccountStatsInput {
  accountId: string;
  platform: Platform;
  platformUid: string;
  nickname: string;
}

export interface ContentStatsInput {
  contentId: string;
  platform: Platform;
  /** 平台侧内容 ID；未回填时退化为内部 ID 作为 Mock 种子 */
  platformContentId: string;
}

/**
 * 采集驱动契约。
 * 新增平台 = 新增一个实现并在 CollectorRegistry 注册，业务代码（结算/看板）无需改动。
 */
export interface CollectorDriver {
  readonly platform: Platform;
  /** 凭证是否齐备；未配置时 Registry 会回落到 Mock 驱动而不是直接报错 */
  isConfigured(): boolean;
  fetchAccountStats(input: AccountStatsInput): Promise<AccountStats>;
  fetchContentStats(input: ContentStatsInput): Promise<ContentStats>;
}

export type CollectorMode = 'mock' | 'live';

export const ALL_PLATFORMS = Object.values(Platform);

// ---------------------------------------------------------------------------
// Mock 驱动：确定性伪随机
// ---------------------------------------------------------------------------

/**
 * 确定性伪随机数据源。
 *
 * 关键点：种子来自业务 ID 的哈希，而不是 Math.random() 或时间戳。
 *   - 同一账号每次采集得到同样的粉丝数 → 幂等写入快照不会产生假增长；
 *   - 测试可以断言具体数值，联调时同事看到的数字与你一致；
 *   - 若用随机数，「粉丝日增」会出现正负乱跳的假数据，看板与告警全部失真。
 */
export class MockCollectorDriver implements CollectorDriver {
  constructor(readonly platform: Platform) {}

  isConfigured(): boolean {
    // Mock 永远可用：它是兜底路径，不是真实凭证路径
    return true;
  }

  async fetchAccountStats(input: AccountStatsInput): Promise<AccountStats> {
    const random = createSeededRandom(`account:${this.platform}:${input.platformUid || input.accountId}`);

    const followerCount = random.int(5_000, 3_000_000);
    const totalWorks = random.int(30, 900);
    const avgPlay = Math.round(followerCount * random.float(0.15, 1.6));
    const playCount = BigInt(avgPlay) * BigInt(totalWorks);
    const likeCount = playCount / BigInt(random.int(12, 40));
    const commentCount = likeCount / BigInt(random.int(20, 80));
    const shareCount = likeCount / BigInt(random.int(40, 200));
    const collectCount = likeCount / BigInt(random.int(15, 90));
    const engagementRateBp = random.int(300, 2_500);

    return {
      followerCount,
      followingCount: random.int(50, 2_000),
      totalLikes: likeCount,
      totalWorks,
      playCount,
      likeCount,
      commentCount,
      shareCount,
      collectCount,
      engagementRateBp,
      revenueCents: BigInt(random.int(0, 5_000_000)),
      // 刻意标记为 MANUAL 而不是假装成 API_OFFICIAL：Mock 数据不能作为结算争议的证据，
      // 前端与结算链路据此展示「数据来源：人工/模拟」，避免有人拿模拟数据去对账。
      dataSource: DataSourceType.MANUAL,
      rawPayload: { driver: 'mock', seedKey: `account:${this.platform}:${input.platformUid}` },
    };
  }

  async fetchContentStats(input: ContentStatsInput): Promise<ContentStats> {
    const random = createSeededRandom(
      `content:${this.platform}:${input.platformContentId || input.contentId}`,
    );

    const viewCount = BigInt(random.int(1_000, 4_000_000));
    const likeCount = viewCount / BigInt(random.int(10, 60));
    const commentCount = likeCount / BigInt(random.int(20, 120));
    const shareCount = likeCount / BigInt(random.int(30, 300));
    const collectCount = likeCount / BigInt(random.int(10, 80));

    return {
      viewCount,
      likeCount,
      commentCount,
      shareCount,
      collectCount,
      completionRateBp: random.int(1_500, 9_500),
      revenueCents: BigInt(random.int(0, 300_000)),
      conversions: random.int(0, 500),
      dataSource: DataSourceType.MANUAL,
      rawPayload: { driver: 'mock', seedKey: `content:${this.platform}:${input.platformContentId}` },
    };
  }
}

// ---------------------------------------------------------------------------
// Http 驱动：真实平台接口骨架
// ---------------------------------------------------------------------------

interface PlatformCredential {
  appId: string;
  appSecret: string;
}

/**
 * 真实采集驱动骨架。
 *
 * 之所以保留完整骨架而不是留 TODO 抛错：
 *   1) 超时、重试、错误转换这三件事与平台无关，必须一次写好，否则接第一个平台时
 *      很容易写出「上游 5s 不响应 → 采集任务全量挂起」的实现；
 *   2) 未配置凭证时抛 UpstreamUnavailableException（503）而不是 500，
 *      让调用方知道「这是外部依赖不可用，可重试/可降级」，而不是系统内部错误。
 * 各平台返回体字段差异很大，因此在 mapAccount/mapContent 里做防御式解析：
 * 缺字段取 0，绝不因为上游多返回一个 null 就让整批采集失败。
 */
export class HttpCollectorDriver implements CollectorDriver {
  private readonly logger = new Logger(HttpCollectorDriver.name);

  constructor(
    readonly platform: Platform,
    private readonly credential: PlatformCredential,
    private readonly options: { timeoutMs?: number; retries?: number } = {},
  ) {}

  isConfigured(): boolean {
    return Boolean(this.credential.appId && this.credential.appSecret);
  }

  async fetchAccountStats(input: AccountStatsInput): Promise<AccountStats> {
    this.assertConfigured();
    const payload = await this.request('account', input.platformUid);
    return this.mapAccount(payload);
  }

  async fetchContentStats(input: ContentStatsInput): Promise<ContentStats> {
    this.assertConfigured();
    if (!input.platformContentId) {
      throw new UnprocessableException(
        '内容尚未回填平台内容 ID，无法调用平台接口采集。请先完成发布并回填 platformContentId',
      );
    }
    const payload = await this.request('content', input.platformContentId);
    return this.mapContent(payload);
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new UpstreamUnavailableException(`${this.platform} 开放接口`, {
        reason: '未配置平台凭证',
        platform: this.platform,
      });
    }
  }

  /** 平台接口地址骨架：真实接入时只需替换这里的 baseUrl 与鉴权方式 */
  private request(kind: 'account' | 'content', platformId: string): Promise<Record<string, unknown>> {
    const baseUrl = PLATFORM_ENDPOINTS[this.platform];
    if (!baseUrl) {
      throw new UpstreamUnavailableException(`${this.platform} 开放接口`, {
        reason: '该平台暂未接入采集器',
        platform: this.platform,
      });
    }
    const url = `${baseUrl}/${kind === 'account' ? 'user/stats' : 'item/stats'}?id=${encodeURIComponent(platformId)}`;

    return this.fetchWithRetry(url, {
      method: 'GET',
      headers: {
        'X-App-Id': this.credential.appId,
        Authorization: `Bearer ${this.credential.appSecret}`,
      },
    });
  }

  /** 带超时与有限重试的 fetch：网络抖动不应把一次采集变成一次事故 */
  private async fetchWithRetry(
    url: string,
    init: RequestInit,
  ): Promise<Record<string, unknown>> {
    const timeoutMs = this.options.timeoutMs ?? 10_000;
    const retries = this.options.retries ?? 2;
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, { ...init, signal: controller.signal });
        if (!response.ok) {
          // 4xx 是请求本身的问题（凭证失效/内容不存在），重试无意义；5xx 才退避重试
          if (response.status < 500) {
            throw new UpstreamUnavailableException(`${this.platform} 开放接口`, {
              status: response.status,
              url,
            });
          }
          lastError = new Error(`HTTP ${response.status}`);
        } else {
          return (await response.json()) as Record<string, unknown>;
        }
      } catch (error) {
        if (error instanceof UpstreamUnavailableException) throw error;
        lastError = error;
      } finally {
        clearTimeout(timer);
      }

      if (attempt < retries) {
        await sleep(200 * 2 ** attempt);
      }
    }

    this.logger.error(
      `采集失败 platform=${this.platform} url=${url} 原因=${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
    // 统一转换成 503：让上层把「外部依赖不可用」与「系统内部 bug」区分开
    throw new UpstreamUnavailableException(`${this.platform} 开放接口`, {
      url,
      reason: lastError instanceof Error ? lastError.message : '未知错误',
    });
  }

  private mapAccount(payload: Record<string, unknown>): AccountStats {
    const data = pickObject(payload, ['data', 'result', 'user']);
    return {
      followerCount: pickInt(data, ['follower_count', 'fans', 'followerCount']),
      followingCount: pickInt(data, ['following_count', 'followingCount']),
      totalLikes: BigInt(pickInt(data, ['total_favorited', 'totalLikes', 'like_count'])),
      totalWorks: pickInt(data, ['aweme_count', 'works', 'item_count']),
      playCount: BigInt(pickInt(data, ['play_count', 'totalPlay', 'view_count'])),
      likeCount: BigInt(pickInt(data, ['like_count', 'likes'])),
      commentCount: BigInt(pickInt(data, ['comment_count', 'comments'])),
      shareCount: BigInt(pickInt(data, ['share_count', 'shares'])),
      collectCount: BigInt(pickInt(data, ['collect_count', 'favorite_count'])),
      engagementRateBp: pickInt(data, ['engagement_rate_bp', 'engagementRateBp']),
      revenueCents: BigInt(pickInt(data, ['revenue_cents', 'revenueCents'])),
      dataSource: DataSourceType.API_OFFICIAL,
      rawPayload: payload as Prisma.InputJsonValue,
    };
  }

  private mapContent(payload: Record<string, unknown>): ContentStats {
    const data = pickObject(payload, ['data', 'result', 'item']);
    return {
      viewCount: BigInt(pickInt(data, ['view_count', 'play_count', 'views'])),
      likeCount: BigInt(pickInt(data, ['digg_count', 'like_count'])),
      commentCount: BigInt(pickInt(data, ['comment_count'])),
      shareCount: BigInt(pickInt(data, ['share_count'])),
      collectCount: BigInt(pickInt(data, ['collect_count'])),
      completionRateBp: pickInt(data, ['completion_rate_bp', 'completionRateBp']),
      revenueCents: BigInt(pickInt(data, ['revenue_cents', 'revenueCents'])),
      conversions: pickInt(data, ['conversions', 'convert_count']),
      dataSource: DataSourceType.API_OFFICIAL,
      rawPayload: payload as Prisma.InputJsonValue,
    };
  }
}

/** 各平台开放接口 baseUrl。真实接入时在这里补全，其余代码无需改动 */
const PLATFORM_ENDPOINTS: Partial<Record<Platform, string>> = {
  DOUYIN: 'https://open.douyin.com/api/douyin/v1',
  XIAOHONGSHU: 'https://ark.xiaohongshu.com/api/open/v1',
  BILIBILI: 'https://api.bilibili.com/x/space',
  TIKTOK: 'https://open.tiktokapis.com/v2',
  YOUTUBE: 'https://www.googleapis.com/youtube/v3',
  KUAISHOU: 'https://open.kuaishou.com/openapi',
  WECHAT_CHANNEL: 'https://api.weixin.qq.com/channels',
  WEIBO: 'https://api.weibo.com/2',
  INSTAGRAM: 'https://graph.instagram.com/v19.0',
};

// ---------------------------------------------------------------------------
// 驱动注册表
// ---------------------------------------------------------------------------

/**
 * 驱动注册表。
 *
 * 选择策略（这也是「不这样做会出什么问题」的地方）：
 *   1) 显式 COLLECTOR_MODE=mock → 一律用 Mock。开发/演示环境绝不能打真实平台接口：
 *      真实接口有配额与费用，误触发会烧掉配额甚至触发风控封号。
 *   2) COLLECTOR_MODE=live 且该平台凭证齐备 → 用 Http 驱动。
 *   3) live 但该平台没凭证 → 回落 Mock，而不是报错。原因是采集任务通常覆盖多个平台，
 *      只签了抖音却让整个任务因为小红书没凭证而失败，是把「部分可用」变成「完全不可用」。
 *      回落的事实通过 dataSource 字段（MANUAL vs API_OFFICIAL）暴露给前端与结算证据链。
 */
export class CollectorRegistry {
  private readonly httpDrivers = new Map<Platform, HttpCollectorDriver>();
  private readonly mockDrivers = new Map<Platform, MockCollectorDriver>();

  constructor(private readonly mode: CollectorMode = env.COLLECTOR_MODE) {
    for (const platform of ALL_PLATFORMS) {
      this.mockDrivers.set(platform, new MockCollectorDriver(platform));
      this.httpDrivers.set(platform, new HttpCollectorDriver(platform, credentialOf(platform)));
    }
  }

  resolve(platform: Platform): CollectorDriver {
    const http = this.httpDrivers.get(platform);
    if (this.mode === 'live' && http?.isConfigured()) return http;
    return this.mockDrivers.get(platform) ?? new MockCollectorDriver(platform);
  }

  /** 运维自检用：一眼看出每个平台当前走的是 Mock 还是真实接口 */
  describe(): Array<{ platform: Platform; mode: CollectorMode; driver: string; configured: boolean }> {
    return ALL_PLATFORMS.map((platform) => {
      const http = this.httpDrivers.get(platform);
      const configured = Boolean(http?.isConfigured());
      return {
        platform,
        mode: this.mode,
        driver: this.mode === 'live' && configured ? 'http' : 'mock',
        configured,
      };
    });
  }
}

// ---------------------------------------------------------------------------
// 采集服务
// ---------------------------------------------------------------------------

export interface SyncResult {
  success: boolean;
  accountId?: string;
  contentId?: string;
  error?: string;
  followerDelta?: number;
  statDate?: string;
  dataSource?: DataSourceType;
}

@Injectable()
export class MetricsCollectorService {
  private readonly logger = new Logger(MetricsCollectorService.name);
  private readonly registry = new CollectorRegistry();

  constructor(private readonly prisma: PrismaService) {}

  /** 采集账号指标（不落库）。供需要「先看一眼」的场景（如采集前预览）复用 */
  async collectAccount(accountId: string): Promise<AccountStats> {
    const account = await this.prisma.platformAccount.findFirst({
      where: { id: accountId, deletedAt: null },
      select: { id: true, platform: true, platformUid: true, nickname: true },
    });
    if (!account) throw new ResourceNotFoundException('平台账号', accountId);

    const driver = this.registry.resolve(account.platform);
    const stats = await driver.fetchAccountStats({
      accountId: account.id,
      platform: account.platform,
      platformUid: account.platformUid,
      nickname: account.nickname,
    });

    // 直接透传驱动返回值，而不是逐字段挑拣：
    // 之前手写字段列表漏了 followingCount / totalLikes / totalWorks，
    // 导致返回类型与 AccountStats 不匹配（TS2739），而且容易在驱动新增字段时再次漏掉。
    return stats;
  }

  /** 采集单条内容指标（不落库） */
  async collectContent(contentId: string): Promise<ContentStats> {
    const content = await this.prisma.content.findFirst({
      where: { id: contentId, deletedAt: null },
      select: { id: true, platform: true, platformContentId: true },
    });
    if (!content) throw new ResourceNotFoundException('内容', contentId);

    const driver = this.registry.resolve(content.platform);
    return driver.fetchContentStats({
      contentId: content.id,
      platform: content.platform,
      // 未回填平台内容 ID 时退化为内部 ID：Mock 仍能产出确定数据，Http 驱动会明确报错
      platformContentId: content.platformContentId ?? content.id,
    });
  }

  /**
   * 同步账号指标并写入快照。
   *
   * 幂等设计（本方法最关键的一点）：
   *   MetricsSnapshot 上有 @@unique([accountId, statDate])，而 statDate 被归一化为
   *   「当天 UTC 00:00」。因此同一天无论跑多少次采集任务，都只会 upsert 同一行，
   *   不会产生多条快照。若不做归一化（直接用 capturedAt 的精确时间做键），
   *   一天内跑 10 次就会留下 10 行，趋势图与「日增粉丝」统计立刻失真。
   *
   * followerDelta 与上一条快照比较：
   *   - 找不到上一条时记 0 而不是粉丝总数，否则新账号第一天会出现「暴涨几万」的假信号，
   *     触发无意义的异常告警。
   */
  async syncAccountMetrics(accountId: string): Promise<SyncResult> {
    try {
      const stats = await this.collectAccount(accountId);
      const now = new Date();
      const statDate = normalizeStatDate(now);

      const previous = await this.prisma.metricsSnapshot.findFirst({
        where: { accountId, statDate: { lt: statDate } },
        orderBy: { statDate: 'desc' },
        select: { followerCount: true },
      });
      const followerDelta = previous ? stats.followerCount - previous.followerCount : 0;

      const account = await this.prisma.platformAccount.findUniqueOrThrow({
        where: { id: accountId },
        select: { totalWorks: true },
      });
      // 平均播放 = 累计播放 / 作品数；用整数除法后取整，字段是 Int，不能塞浮点
      const avgPlayCount = clampInt(
        account.totalWorks > 0 ? Number(stats.playCount) / account.totalWorks : 0,
      );

      const snapshotData = {
        capturedAt: now,
        statDate,
        followerCount: stats.followerCount,
        followerDelta,
        playCount: stats.playCount,
        likeCount: stats.likeCount,
        commentCount: stats.commentCount,
        shareCount: stats.shareCount,
        collectCount: stats.collectCount,
        engagementRateBp: stats.engagementRateBp,
        revenueCents: stats.revenueCents,
        rawPayload: (stats.rawPayload ?? undefined) as Prisma.InputJsonValue | undefined,
        dataSource: stats.dataSource,
      };

      await this.prisma.withTransaction(async (tx) => {
        await tx.platformAccount.update({
          where: { id: accountId },
          data: {
            followerCount: stats.followerCount,
            totalLikes: stats.totalLikes,
            avgPlayCount,
            engagementRateBp: stats.engagementRateBp,
            dataSource: stats.dataSource,
            lastSyncedAt: now,
            // 采集成功必须清掉上一次的错误，否则前端会一直显示过期的失败状态
            syncError: null,
          },
        });

        await tx.metricsSnapshot.upsert({
          where: { accountId_statDate: { accountId, statDate } },
          create: { accountId, ...snapshotData },
          // 同一天重跑 = 覆盖当天数据（最后一版为准），保证「重跑任务」不产生脏数据
          update: snapshotData,
        });
      });

      this.logger.log(
        `账号指标同步成功 account=${accountId} 粉丝=${stats.followerCount} 日增=${followerDelta} 来源=${stats.dataSource}`,
      );
      return {
        success: true,
        accountId,
        statDate: statDate.toISOString(),
        followerDelta,
        dataSource: stats.dataSource,
      };
    } catch (error) {
      // 刻意不 rethrow：采集任务通常批量执行，一个账号失败（凭证过期/平台限流）
      // 不应让整批任务中断，也不应把 503 抛给接口层导致前端整页报错
      const message = error instanceof Error ? error.message : '未知采集错误';
      await this.prisma.platformAccount
        .update({
          where: { id: accountId },
          data: {
            syncError: message.slice(0, 500),
            // 不动 lastSyncedAt：它表示「最后一次成功时间」，被失败刷新后
            // 「数据陈旧」告警就永远不触发了，问题会被永久掩盖
          },
        })
        // 账号可能已被删除，写错误信息失败不应再抛异常
        .catch(() => undefined);
      this.logger.warn(`账号指标同步失败 account=${accountId} 原因=${message}`);
      return { success: false, accountId, error: message };
    }
  }

  /**
   * 同步内容效果数据。
   * 与账号同步同构：失败只记录并返回 { success: false }。
   * Content 表没有 syncError 列，因此失败信息只进日志——这也是刻意的：
   * 内容数据缺失是可容忍的（下次采集补上），不需要在内容详情页展示技术错误。
   */
  async syncContentMetrics(contentId: string): Promise<SyncResult> {
    try {
      const stats = await this.collectContent(contentId);
      const now = new Date();

      await this.prisma.content.update({
        where: { id: contentId },
        data: {
          viewCount: stats.viewCount,
          likeCount: stats.likeCount,
          commentCount: stats.commentCount,
          shareCount: stats.shareCount,
          collectCount: stats.collectCount,
          completionRateBp: stats.completionRateBp,
          revenueCents: stats.revenueCents,
          conversions: stats.conversions,
          metricsSyncedAt: now,
        },
      });

      this.logger.log(
        `内容指标同步成功 content=${contentId} 播放=${stats.viewCount} 流水分=${stats.revenueCents} 来源=${stats.dataSource}`,
      );
      return { success: true, contentId, dataSource: stats.dataSource };
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知采集错误';
      this.logger.warn(`内容指标同步失败 content=${contentId} 原因=${message}`);
      return { success: false, contentId, error: message };
    }
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/**
 * 归一化采集归属日到当天 UTC 00:00。
 * 这是快照幂等的关键：唯一键 [accountId, statDate] 只有在 statDate 粒度是「天」时才起作用。
 */
export function normalizeStatDate(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** FNV-1a 32 位哈希：把业务 ID 稳定映射成随机种子（同一字符串永远同一结果） */
function hashSeed(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32：小而稳定的伪随机数发生器，保证「同种子同序列」 */
function createSeededRandom(seedKey: string): {
  int: (min: number, max: number) => number;
  float: (min: number, max: number) => number;
} {
  let state = hashSeed(seedKey) || 1;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    float: (min, max) => min + next() * (max - min),
  };
}

/** 平台凭证从环境变量读取；未配置返回空串，由 isConfigured() 决定是否回落 Mock */
function credentialOf(platform: Platform): PlatformCredential {
  switch (platform) {
    case Platform.DOUYIN:
      return { appId: env.DOUYIN_APP_ID, appSecret: env.DOUYIN_APP_SECRET };
    case Platform.XIAOHONGSHU:
      return { appId: env.XIAOHONGSHU_APP_ID, appSecret: env.XIAOHONGSHU_APP_SECRET };
    case Platform.BILIBILI:
      return { appId: env.BILIBILI_APP_ID, appSecret: env.BILIBILI_APP_SECRET };
    case Platform.TIKTOK:
      return { appId: env.TIKTOK_CLIENT_KEY, appSecret: env.TIKTOK_CLIENT_SECRET };
    case Platform.YOUTUBE:
      return { appId: env.YOUTUBE_API_KEY, appSecret: env.YOUTUBE_API_KEY };
    default:
      // 其余平台暂未提供凭证配置项，视为未配置（采集走 Mock）
      return { appId: '', appSecret: '' };
  }
}

/** 从上游返回体里取嵌套对象，兼容 data/result/user 等不同包装 */
function pickObject(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  for (const key of keys) {
    const value = source[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return source;
}

/** 从上游返回体里取整数字段，缺失/非法一律取 0（防御式解析） */
function pickInt(source: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return Math.trunc(Number(value));
    }
  }
  return 0;
}

/** 夹到 Int32 范围内：Prisma Int 列溢出会直接抛错，宁可截断也不能让采集任务崩掉 */
function clampInt(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(2_147_483_647, Math.max(0, Math.round(value)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
