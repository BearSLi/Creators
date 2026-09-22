import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { env } from '../../config/index';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { MetricsCollectorService } from '../contents/metrics-collector.service';
import { SettlementService } from '../settlements/settlement.service';
import type { AuthUser } from '../auth/auth.types';
import { resolvePermissions } from '../auth/permissions';

/**
 * 定时任务。
 *
 * 设计原则：
 * 1) **每个任务必须幂等**。多实例部署时同一任务会被多个实例同时触发，
 *    因此幂等性不依赖「调度器只跑一次」，而依赖业务层的唯一约束与幂等键
 *    （结算按 (creatorId, periodStart, periodEnd) 唯一，快照按 (accountId, statDate) 唯一）。
 * 2) **失败不抛出到调度器**。任务内部捕获异常并落日志/告警，
 *    避免一个任务失败导致后续调度被中断。
 * 3) 生产环境应把调度交给独立 worker（或用 Redis 锁选主），
 *    这里的实现保持零外部依赖，便于本地一键跑起来；
 *    多实例生产部署需启用 SCHEDULER_ENABLED 单实例开关（见 docs/deployment.md）。
 */

/** 系统任务使用的虚拟身份：需要以某个用户身份调用 Service 的业务方法 */
function systemUser(): AuthUser {
  return {
    id: '00000000-0000-0000-0000-000000000000',
    email: 'system@creatorops.local',
    name: '系统任务',
    role: 'SUPER_ADMIN',
    teamId: null,
    permissions: resolvePermissions('SUPER_ADMIN'),
    sessionId: 'system',
  };
}

@Injectable()
export class ScheduledJobsService {
  private readonly logger = new Logger(ScheduledJobsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settlementService: SettlementService,
    private readonly auditService: AuditService,
    private readonly metricsCollector: MetricsCollectorService,
  ) {}

  /**
   * 每日账号与内容数据采集。
   *
   * 时间选在 06:30（平台数据通常凌晨完成结算与统计刷新），且刻意放在
   * 「结算生成（每月 3 日 02:00）」之前 —— 结算依赖快照表的收入数据，
   * 采集必须先跑完，否则会按陈旧数据出账。
   *
   * 并发控制：采集是外部 IO 密集型任务，串行执行虽然慢但避免了
   * 「同时打爆平台接口触发限流」。按批处理（每批 5 个）在速度与压力之间折中。
   * 单条失败不影响整批：采集器内部已捕获异常并写入 syncError。
   */
  @Cron('0 30 6 * * *', { name: 'daily-metrics-sync' })
  async syncDailyMetrics(): Promise<void> {
    try {
      const startedAt = Date.now();
      // 只采集「合作中/已签约」达人的账号：线索阶段的数据没有业务用途，
      // 全量采集既浪费平台配额也增加被限流风险。
      const accounts = await this.prisma.platformAccount.findMany({
        where: {
          deletedAt: null,
          creator: { deletedAt: null, status: { in: ['SIGNED', 'ACTIVE', 'PAUSED'] } },
        },
        select: { id: true, platform: true, nickname: true },
      });

      if (accounts.length === 0) {
        this.logger.log('每日采集：没有需要同步的账号');
        return;
      }

      let succeeded = 0;
      let failed = 0;
      const batchSize = 5;
      for (let index = 0; index < accounts.length; index += batchSize) {
        const batch = accounts.slice(index, index + batchSize);
        const results = await Promise.all(
          batch.map(async (account) => {
            try {
              const result = await this.metricsCollector.syncAccountMetrics(account.id);
              return { ok: result.success, account };
            } catch (error) {
              // 采集器设计为内部捕获异常，这里兜底以防未来改动破坏该约定
              this.logger.warn(
                `账号采集异常 account=${account.nickname}：${error instanceof Error ? error.message : String(error)}`,
              );
              return { ok: false, account };
            }
          }),
        );
        succeeded += results.filter((item) => item.ok).length;
        failed += results.filter((item) => !item.ok).length;
      }

      this.logger.log(
        `每日采集完成：成功 ${succeeded} 个账号，失败 ${failed} 个，耗时 ${Date.now() - startedAt}ms（失败账号已写 syncError，可在账号列表查看）`,
      );

      // 已发布内容的效果数据同样需要刷新，否则达人详情页的内容表现会停滞
      const contents = await this.prisma.content.findMany({
        where: {
          deletedAt: null,
          status: 'PUBLISHED',
          OR: [
            { metricsSyncedAt: null },
            // 只刷新 30 天内的内容：老内容数据基本稳定，重复采集没有收益
            { publishedAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
          ],
        },
        select: { id: true },
        take: 1000,
      });

      let contentSucceeded = 0;
      for (let index = 0; index < contents.length; index += batchSize) {
        const batch = contents.slice(index, index + batchSize);
        const results = await Promise.all(
          batch.map((content) =>
            this.metricsCollector
              .syncContentMetrics(content.id)
              .then((result) => result.success)
              .catch(() => false),
          ),
        );
        contentSucceeded += results.filter(Boolean).length;
      }
      this.logger.log(`每日采集：内容数据同步成功 ${contentSucceeded}/${contents.length} 条`);
    } catch (error) {
      this.logger.error('每日采集任务失败', error instanceof Error ? error.stack : String(error));
    }
  }

  /**
   * 每月结算单自动生成。
   * 默认每月 3 号凌晨 02:00 执行（上月账期），给数据同步留出缓冲时间：
   * 平台数据通常有 1-2 天延迟，月初就跑会漏掉月末内容的分成。
   */
  @Cron('0 2 3 * *', { name: 'monthly-settlement' })
  async generateMonthlySettlements(): Promise<void> {
    try {
      const now = new Date();
      // 上月账期
      const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 23, 59, 59, 999));

      this.logger.log(
        `开始自动生成结算单 账期=${periodStart.toISOString().slice(0, 10)} ~ ${periodEnd.toISOString().slice(0, 10)}`,
      );
      const result = await this.settlementService.generate(systemUser(), {
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
      });
      this.logger.log(
        `自动结算完成：生成 ${result.generated} 张，跳过 ${result.skipped} 个达人，应付合计 ${result.totalNetYuan} 元`,
      );

      // 有跳过且带原因时输出摘要，便于运营次日排查（合同冲突是最常见原因）
      if (result.skippedReasons.length > 0) {
        const summary = result.skippedReasons
          .slice(0, 10)
          .map((item) => `${item.creatorName}: ${item.reason}`)
          .join(' | ');
        this.logger.warn(`结算跳过明细（前 10 条）：${summary}`);
      }
    } catch (error) {
      this.logger.error(
        '自动生成结算单失败',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * 合同到期提醒。
   * 每天 09:30 执行（工作时间内，负责人能立刻处理），
   * 对 30/15/7 天内到期的合同生成通知，用 dedupeKey 保证同一合同同一阈值只提醒一次。
   */
  @Cron('0 30 9 * * *', { name: 'contract-expiry-reminder' })
  async remindContractExpiry(): Promise<void> {
    try {
      const now = new Date();
      const thresholds = [30, 15, 7];
      let created = 0;

      for (const days of thresholds) {
        const boundary = new Date(now.getTime() + days * 86_400_000);
        const contracts = await this.prisma.contract.findMany({
          where: {
            deletedAt: null,
            status: 'ACTIVE',
            effectiveTo: { gte: now, lte: boundary },
          },
          select: {
            id: true,
            code: true,
            title: true,
            effectiveTo: true,
            createdById: true,
            creator: { select: { id: true, name: true, ownerId: true } },
          },
        });

        for (const contract of contracts) {
          const userId = contract.creator.ownerId ?? contract.createdById;
          if (!userId) continue;
          const daysLeft = Math.ceil((contract.effectiveTo.getTime() - now.getTime()) / 86_400_000);
          const result = await this.prisma.notification
            .create({
              data: {
                userId,
                type: 'CONTRACT_EXPIRING',
                title: `合同 ${days} 天内到期：${contract.creator.name}`,
                content: `合同《${contract.title}》（${contract.code}）将于 ${contract.effectiveTo.toISOString().slice(0, 10)} 到期，剩余 ${daysLeft} 天，请及时沟通续约。`,
                link: `/contracts/${contract.id}`,
                dedupeKey: `contract-expiry:${contract.id}:${days}`,
              },
            })
            .then(() => true)
            // dedupeKey 唯一冲突说明已提醒过，属于预期行为
            .catch(() => false);
          if (result) created += 1;
        }
      }

      if (created > 0) this.logger.log(`合同到期提醒已生成 ${created} 条通知`);
    } catch (error) {
      this.logger.error('合同到期提醒任务失败', error instanceof Error ? error.stack : String(error));
    }
  }

  /**
   * 结算账期到期提醒。
   * 每天 10:00 检查已审批但超过账期未打款的结算单——这是财务最关心的风险点。
   */
  @Cron('0 0 10 * * *', { name: 'settlement-due-reminder' })
  async remindSettlementDue(): Promise<void> {
    try {
      const now = new Date();
      const overdue = await this.prisma.settlement.findMany({
        where: {
          deletedAt: null,
          status: 'APPROVED',
          dueDate: { lte: now },
        },
        select: {
          id: true,
          code: true,
          dueDate: true,
          netPayable: true,
          creator: { select: { name: true, ownerId: true } },
        },
        take: 200,
      });

      // 财务角色统一收提醒
      const financeUsers = await this.prisma.user.findMany({
        where: { deletedAt: null, status: 'ACTIVE', role: { in: ['FINANCE', 'SUPER_ADMIN'] } },
        select: { id: true },
      });

      let created = 0;
      for (const settlement of overdue) {
        const targets = new Set<string>(financeUsers.map((user) => user.id));
        if (settlement.creator.ownerId) targets.add(settlement.creator.ownerId);

        for (const userId of targets) {
          const ok = await this.prisma.notification
            .create({
              data: {
                userId,
                type: 'SETTLEMENT_DUE',
                title: `结算单已过账期未打款：${settlement.creator.name}`,
                content: `结算单 ${settlement.code} 应付 ${settlement.netPayable.toFixed(2)} 元，账期已于 ${settlement.dueDate?.toISOString().slice(0, 10)} 到期，请尽快安排打款。`,
                link: `/settlements/${settlement.id}`,
                dedupeKey: `settlement-overdue:${settlement.id}`,
              },
            })
            .then(() => true)
            .catch(() => false);
          if (ok) created += 1;
        }
      }

      if (created > 0) this.logger.warn(`账期超期提醒已生成 ${created} 条（涉及 ${overdue.length} 张结算单）`);
    } catch (error) {
      this.logger.error('账期提醒任务失败', error instanceof Error ? error.stack : String(error));
    }
  }

  /**
   * 内容进入审核超时提醒（每日 11:00）。
   * 内容卡在审核环节是产能浪费，超过 48 小时未处理则提醒相关负责人。
   */
  @Cron('0 0 11 * * *', { name: 'content-review-reminder' })
  async remindContentReview(): Promise<void> {
    try {
      const threshold = new Date(Date.now() - 48 * 3600 * 1000);
      const stuck = await this.prisma.content.findMany({
        where: {
          deletedAt: null,
          status: { in: ['INTERNAL_REVIEW', 'PLATFORM_REVIEW'] },
          updatedAt: { lte: threshold },
        },
        select: {
          id: true,
          title: true,
          status: true,
          updatedAt: true,
          creator: { select: { name: true, ownerId: true } },
        },
        take: 100,
      });

      let created = 0;
      for (const content of stuck) {
        if (!content.creator.ownerId) continue;
        const ok = await this.prisma.notification
          .create({
            data: {
              userId: content.creator.ownerId,
              type: 'CONTENT_REVIEW',
              title: `内容审核超时：${content.title}`,
              content: `达人「${content.creator.name}」的内容《${content.title}》已在审核环节停留超过 48 小时，请尽快处理。`,
              link: `/contents/${content.id}`,
              dedupeKey: `content-review-overdue:${content.id}`,
            },
          })
          .then(() => true)
          .catch(() => false);
        if (ok) created += 1;
      }

      if (created > 0) this.logger.warn(`内容审核超时提醒已生成 ${created} 条`);
    } catch (error) {
      this.logger.error('内容审核提醒任务失败', error instanceof Error ? error.stack : String(error));
    }
  }

  /**
   * 审计日志保留期清理（每月 1 日 03:00）。
   * 审计日志是高写入量表，无限增长会拖慢查询并推高存储成本；
   * 保留期由 AUDIT_LOG_RETENTION_DAYS 控制，默认 365 天，满足内部合规与复盘需求。
   */
  @Cron(CronExpression.EVERY_1ST_DAY_OF_MONTH_AT_MIDNIGHT, { name: 'audit-log-purge' })
  async purgeAuditLogs(): Promise<void> {
    try {
      const deleted = await this.auditService.purgeExpired(env.AUDIT_LOG_RETENTION_DAYS);
      if (deleted > 0) this.logger.log(`审计日志清理完成，删除 ${deleted} 条`);
    } catch (error) {
      this.logger.error('审计日志清理失败', error instanceof Error ? error.stack : String(error));
    }
  }
}
