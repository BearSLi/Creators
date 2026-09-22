import { Injectable, Logger } from '@nestjs/common';
import { Prisma, SettlementStatus } from '@prisma/client';
import { env } from '../../config';
import {
  BusinessException,
  ResourceNotFoundException,
  StateConflictException,
  UnprocessableException,
} from '../../common/exceptions/business.exception';
import { buildPaginated, PaginatedResult, resolveOrderBy } from '../../common/utils/pagination';
import { buildScopeFilter } from '../../common/utils/scope';
import { centsToDecimalString, decimalToCents } from '../../common/utils/money';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import { CodeGeneratorService, CODE_PREFIX } from '../common/code-generator.service';
import { assertCanBeSettled, CreatorStatusValue } from '../creators/creator-status.machine';
import {
  calculateSettlement,
  resolvePeriod,
  SettlementBreakdown,
  SettlementRule,
  sumBreakdowns,
} from './settlement.calculator';
import {
  AdjustSettlementDto,
  GenerateSettlementDto,
  PaySettlementDto,
  QuerySettlementDto,
} from './dto/settlement.dto';

/** 结算单状态机：金额一经审批即冻结，任何修改都必须回到草稿态重新走审批 */
export const SETTLEMENT_TRANSITIONS: Record<SettlementStatus, SettlementStatus[]> = {
  DRAFT: ['PENDING_APPROVAL', 'VOID'],
  PENDING_APPROVAL: ['APPROVED', 'DRAFT', 'DISPUTED', 'VOID'],
  APPROVED: ['PAID', 'DISPUTED', 'VOID'],
  PAID: ['DISPUTED'],
  DISPUTED: ['DRAFT', 'VOID'],
  VOID: [],
};

export function assertSettlementTransition(from: SettlementStatus, to: SettlementStatus): void {
  const allowed = SETTLEMENT_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new StateConflictException(
      `结算单不允许从「${SETTLEMENT_STATUS_LABELS[from]}」变更为「${SETTLEMENT_STATUS_LABELS[to]}」`,
      { from, to, allowedNext: allowed },
    );
  }
}

export const SETTLEMENT_STATUS_LABELS: Record<SettlementStatus, string> = {
  DRAFT: '草稿',
  PENDING_APPROVAL: '待审批',
  APPROVED: '已审批',
  PAID: '已打款',
  DISPUTED: '有争议',
  VOID: '已作废',
};

export interface SettlementListItem {
  id: string;
  code: string;
  creatorId: string;
  creatorName: string;
  periodStart: string;
  periodEnd: string;
  status: SettlementStatus;
  statusLabel: string;
  currency: string;
  grossAmount: string;
  platformFee: string;
  agencyShare: string;
  talentGross: string;
  taxWithheld: string;
  netPayable: string;
  adjustmentAmount: string;
  dueDate: string | null;
  approvedAt: string | null;
  paidAt: string | null;
  itemCount: number;
  createdAt: string;
}

export interface GenerateResult {
  generated: number;
  skipped: number;
  totalNetYuan: string;
  settlements: Array<{ id: string; code: string; creatorName: string; netPayable: string }>;
  skippedReasons: Array<{ creatorId: string; creatorName: string; reason: string }>;
  warnings: string[];
}

@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly codeGenerator: CodeGeneratorService,
  ) {}

  // -------------------------------------------------------------------------
  // 查询
  // -------------------------------------------------------------------------

  async list(user: AuthUser, query: QuerySettlementDto): Promise<PaginatedResult<SettlementListItem>> {
    const where: Prisma.SettlementWhereInput = {
      deletedAt: null,
      // 结算含金额，数据范围一律按达人归属收敛（商务只看自己达人的结算）
      creator: buildScopeFilter(user) as Prisma.CreatorWhereInput,
      status: query.status?.length ? { in: query.status } : undefined,
      creatorId: query.creatorId,
      periodStart: query.periodStart ? { gte: new Date(query.periodStart) } : undefined,
      periodEnd: query.periodEnd ? { lte: new Date(query.periodEnd) } : undefined,
      OR: query.keyword
        ? [
            { code: { contains: query.keyword, mode: 'insensitive' } },
            { creator: { name: { contains: query.keyword, mode: 'insensitive' } } },
          ]
        : undefined,
    };

    const orderBy = resolveOrderBy(
      query.sortBy,
      query.sortOrder,
      ['createdAt', 'periodStart', 'netPayable', 'dueDate'] as const,
      'periodStart',
    );

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.settlement.findMany({
        where,
        orderBy,
        skip: query.skip,
        take: query.take,
        include: {
          creator: { select: { id: true, name: true, code: true } },
          _count: { select: { items: true } },
        },
      }),
      this.prisma.settlement.count({ where }),
    ]);

    return buildPaginated(
      rows.map((row) => this.toListItem(row)),
      total,
      query.page,
      query.pageSize,
    );
  }

  async findOne(user: AuthUser, id: string) {
    const settlement = await this.prisma.settlement.findFirst({
      where: { id, deletedAt: null },
      include: {
        creator: { select: { id: true, name: true, code: true, status: true, tier: true } },
        approvedBy: { select: { id: true, name: true } },
        items: {
          orderBy: { calculatedAt: 'asc' },
          include: {
            contract: { select: { id: true, code: true } },
            content: { select: { id: true, title: true, platform: true, publishedAt: true } },
          },
        },
      },
    });
    if (!settlement) throw new ResourceNotFoundException('结算单');

    // 数据范围校验：结算涉及他人金额，必须逐条校验而不是只看列表权限
    const scopeFilter = buildScopeFilter(user);
    if (Object.keys(scopeFilter).length > 0) {
      const visible = await this.prisma.creator.findFirst({
        where: { id: settlement.creatorId, ...scopeFilter },
        select: { id: true },
      });
      if (!visible) throw new ResourceNotFoundException('结算单');
    }

    return {
      ...this.toListItem({ ...settlement, _count: { items: settlement.items.length } }),
      creator: {
        id: settlement.creator.id,
        name: settlement.creator.name,
        code: settlement.creator.code,
        status: settlement.creator.status,
        tier: settlement.creator.tier,
      },
      approvedBy: settlement.approvedBy,
      dueDate: settlement.dueDate?.toISOString().slice(0, 10) ?? null,
      paymentVoucherUrl: settlement.paymentVoucherUrl,
      disputeReason: settlement.disputeReason,
      remark: settlement.remark,
      adjustmentReason: settlement.adjustmentReason,
      calculationTrace: settlement.calculationTrace,
      items: settlement.items.map((item) => ({
        id: item.id,
        itemType: item.itemType,
        description: item.description,
        grossAmount: item.grossAmount.toFixed(2),
        platformFeeBp: item.platformFeeBp,
        platformFee: item.platformFee.toFixed(2),
        agencyShareBp: item.agencyShareBp,
        agencyShare: item.agencyShare.toFixed(2),
        talentShareBp: item.talentShareBp,
        talentGross: item.talentGross.toFixed(2),
        taxWithholdBp: item.taxWithholdBp,
        taxWithheld: item.taxWithheld.toFixed(2),
        netPayable: item.netPayable.toFixed(2),
        contractId: item.contractId,
        contractCode: item.contract?.code ?? null,
        contentId: item.contentId,
        contentTitle: item.content?.title ?? null,
        platform: item.content?.platform ?? null,
        publishedAt: item.content?.publishedAt?.toISOString() ?? null,
        calculatedAt: item.calculatedAt.toISOString(),
      })),
      statusMachine: {
        allowedNext: (SETTLEMENT_TRANSITIONS[settlement.status] ?? []).map((status) => ({
          value: status,
          label: SETTLEMENT_STATUS_LABELS[status],
        })),
      },
    };
  }

  // -------------------------------------------------------------------------
  // 生成（核心）
  // -------------------------------------------------------------------------

  /**
   * 按账期批量生成结算单。
   *
   * 幂等保证：
   *   1) settlement 表对 (creatorId, periodStart, periodEnd) 有唯一约束；
   *   2) settlement_item 表的 idempotencyKey 唯一，重复执行只会跳过已有明细；
   *   3) 已存在且非草稿/已作废的结算单直接跳过，不会覆盖已审批金额。
   * 因此该接口可安全地被定时任务重复调用（补跑、重试均不会重复出账）。
   *
   * 归因口径：REVENUE_SHARE 按「内容发布月」归因，一条内容只在一个账期结算一次，
   * 避免跨月重复计算。CPA 模式按内容的 conversions 计算。
   */
  async generate(user: AuthUser, dto: GenerateSettlementDto): Promise<GenerateResult> {
    const period = this.resolvePeriodOrFail({
      month: dto.month,
      periodStart: dto.periodStart,
      periodEnd: dto.periodEnd,
    });

    const candidates = await this.prisma.creator.findMany({
      where: {
        deletedAt: null,
        // 只有进入合作流程的达人才结算；线索/黑名单不产生应付
        status: { in: ['SIGNED', 'ACTIVE', 'PAUSED', 'TERMINATED'] },
        id: dto.creatorIds?.length ? { in: dto.creatorIds } : undefined,
      },
      select: { id: true, name: true, code: true, status: true },
      take: dto.creatorIds?.length ? dto.creatorIds.length : 5000,
    });

    const result: GenerateResult = {
      generated: 0,
      skipped: 0,
      totalNetYuan: '0.00',
      settlements: [],
      skippedReasons: [],
      warnings: [],
    };
    let totalNetCents = 0;

    for (const creator of candidates) {
      try {
        const created = await this.generateForCreator(
          creator,
          period.start,
          period.end,
          user.id,
        );
        if (!created) {
          result.skipped += 1;
          result.skippedReasons.push({
            creatorId: creator.id,
            creatorName: creator.name,
            reason: '账期内无可结算流水或已存在结算单',
          });
          continue;
        }
        result.generated += 1;
        totalNetCents += created.netPayableCents;
        result.settlements.push({
          id: created.id,
          code: created.code,
          creatorName: creator.name,
          netPayable: centsToDecimalString(created.netPayableCents),
        });
        result.warnings.push(...created.warnings);
      } catch (error) {
        result.skipped += 1;
        const reason = error instanceof Error ? error.message : '未知错误';
        result.skippedReasons.push({ creatorId: creator.id, creatorName: creator.name, reason });
        this.logger.warn(`结算生成跳过 creator=${creator.code} 原因=${reason}`);
      }
    }

    result.totalNetYuan = centsToDecimalString(totalNetCents);
    this.logger.log(
      `结算生成完成 账期=${period.label} 生成=${result.generated} 跳过=${result.skipped} 应付合计=${result.totalNetYuan} by=${user.email}`,
    );
    return result;
  }

  /**
   * 单个达人的结算生成（独立事务）。
   * 返回 null 表示没有可结算内容；抛错表示数据异常（合同非法等），由上层收集为 skippedReasons。
   */
  private async generateForCreator(
    creator: { id: string; name: string; code: string; status: string },
    periodStart: Date,
    periodEnd: Date,
    /// 操作人 ID：用于写入结算单的 createdById（审计与「创建人不能自审」双人复核判断都依赖它）
    operatorId: string,
  ): Promise<{ id: string; code: string; netPayableCents: number; warnings: string[] } | null> {
    assertCanBeSettled(creator.status as CreatorStatusValue);

    const existing = await this.prisma.settlement.findFirst({
      where: { creatorId: creator.id, periodStart, periodEnd },
      select: { id: true, code: true, status: true },
    });
    if (existing) {
      if (existing.status === 'VOID') {
        // 已作废的结算单允许重新生成，但需先软删除旧单以释放唯一约束
        await this.prisma.settlement.update({
          where: { id: existing.id },
          data: { deletedAt: new Date() },
        });
      } else {
        return null;
      }
    }

    // 账期内生效的合同（取生效起始日落在账期前后的合同，区间有交集即可）
    const contracts = await this.prisma.contract.findMany({
      where: {
        creatorId: creator.id,
        deletedAt: null,
        status: 'ACTIVE',
        effectiveFrom: { lte: periodEnd },
        effectiveTo: { gte: periodStart },
      },
      orderBy: { effectiveFrom: 'asc' },
    });

    if (contracts.length === 0) return null;
    if (contracts.length > 1) {
      throw new UnprocessableException(
        `达人存在 ${contracts.length} 份账期内生效的合同（${contracts.map((c) => c.code).join('、')}），存在结算口径歧义，请先关闭冲突合同`,
      );
    }
    const contract = contracts[0]!;

    const rule: SettlementRule = {
      settlementMode: contract.settlementMode,
      fixedFeeCents: decimalToCents(contract.fixedFee),
      platformFeeBp: contract.platformFeeBp,
      agencyShareBp: contract.agencyShareBp,
      talentShareBp: contract.talentShareBp,
      taxWithholdBp: contract.taxWithholdBp,
      tieredShares: parseTieredShares(contract.tieredShares),
      cpaUnitPriceCents: decimalToCents(contract.cpaUnitPrice),
    };

    // 归因载体：账期内发布且未结算过的内容
    const contents = await this.prisma.content.findMany({
      where: {
        creatorId: creator.id,
        deletedAt: null,
        status: { in: ['PUBLISHED', 'OFFLINE'] },
        publishedAt: { gte: periodStart, lte: periodEnd },
        revenueCents: { gt: 0n },
        settlementItems: { none: {} },
      },
      select: {
        id: true,
        title: true,
        platform: true,
        publishedAt: true,
        revenueCents: true,
        conversions: true,
      },
    });

    const itemPlans: Array<{
      breakdown: SettlementBreakdown;
      idempotencyKey: string;
      itemType: string;
      contentId: string | null;
      description: string;
    }> = [];

    if (rule.settlementMode === 'FIXED_FEE' || rule.settlementMode === 'HYBRID') {
      // 一口价/保底：按合同在账期内固定结算一次
      const breakdown = calculateSettlement({
        rule,
        grossCents: 0,
        description: `${contract.code} 合同固定费用`,
      });
      itemPlans.push({
        breakdown,
        idempotencyKey: `STI:${creator.id}:${contract.id}:FIXED:${periodStart.toISOString().slice(0, 10)}`,
        itemType: 'FIXED_FEE',
        contentId: null,
        description: `${contract.code} ${rule.settlementMode === 'HYBRID' ? '保底费用' : '合同一口价'}`,
      });
    }

    if (rule.settlementMode === 'REVENUE_SHARE' || rule.settlementMode === 'HYBRID') {
      for (const content of contents) {
        const breakdown = calculateSettlement({
          rule,
          grossCents: Number(content.revenueCents),
          description: content.title,
        });
        itemPlans.push({
          breakdown,
          idempotencyKey: `STI:${creator.id}:${contract.id}:${content.id}`,
          itemType: 'REVENUE',
          contentId: content.id,
          description: `${content.platform} 内容《${content.title}》分成`,
        });
      }
    }

    if (rule.settlementMode === 'CPA') {
      for (const content of contents) {
        if (content.conversions <= 0) continue;
        const breakdown = calculateSettlement({
          rule,
          grossCents: 0,
          conversions: content.conversions,
          description: content.title,
        });
        itemPlans.push({
          breakdown,
          idempotencyKey: `STI:${creator.id}:${contract.id}:CPA:${content.id}`,
          itemType: 'CPA',
          contentId: content.id,
          description: `${content.platform} 内容《${content.title}》效果付费（${content.conversions} 次转化）`,
        });
      }
    }

    if (itemPlans.length === 0) return null;

    const totals = sumBreakdowns(itemPlans.map((plan) => plan.breakdown));
    const warnings = itemPlans.flatMap((plan) =>
      plan.breakdown.warnings.map((warning) => `${creator.name}：${warning}`),
    );

    const created = await this.prisma.withTransaction(async (tx) => {
      const code = await this.codeGenerator.next(CODE_PREFIX.SETTLEMENT, tx);
      const settlement = await tx.settlement.create({
        data: {
          code,
          creatorId: creator.id,
          periodStart,
          periodEnd,
          status: 'DRAFT',
          currency: contract.currency,
          grossAmount: centsToDecimalString(totals.grossCents),
          platformFee: centsToDecimalString(totals.platformFeeCents),
          agencyShare: centsToDecimalString(totals.agencyShareCents),
          talentGross: centsToDecimalString(totals.talentGrossCents),
          taxWithheld: centsToDecimalString(totals.taxWithheldCents),
          netPayable: centsToDecimalString(totals.netPayableCents),
          dueDate: new Date(periodEnd.getTime() + env.SETTLEMENT_PAYMENT_TERM_DAYS * 86_400_000),
          calculationTrace: {
            contractCode: contract.code,
            settlementMode: contract.settlementMode,
            periodStart: periodStart.toISOString(),
            periodEnd: periodEnd.toISOString(),
            itemCount: itemPlans.length,
            generatedAt: new Date().toISOString(),
            items: itemPlans.map((plan) => ({
              key: plan.idempotencyKey,
              description: plan.description,
              trace: plan.breakdown.trace,
              warnings: plan.breakdown.warnings,
            })),
          } as Prisma.InputJsonValue,
          createdById: operatorId,
        },
        select: { id: true, code: true },
      });

      await tx.settlementItem.createMany({
        data: itemPlans.map((plan) => ({
          settlementId: settlement.id,
          creatorId: creator.id,
          contractId: contract.id,
          contentId: plan.contentId,
          itemType: plan.itemType,
          description: plan.description.slice(0, 200),
          grossAmount: centsToDecimalString(plan.breakdown.grossCents),
          platformFeeBp: plan.breakdown.effective.platformFeeBp,
          platformFee: centsToDecimalString(plan.breakdown.platformFeeCents),
          agencyShareBp: plan.breakdown.effective.agencyShareBp,
          agencyShare: centsToDecimalString(plan.breakdown.agencyShareCents),
          talentShareBp: plan.breakdown.effective.talentShareBp,
          talentGross: centsToDecimalString(plan.breakdown.talentGrossCents),
          taxWithholdBp: plan.breakdown.effective.taxWithholdBp,
          taxWithheld: centsToDecimalString(plan.breakdown.taxWithheldCents),
          netPayable: centsToDecimalString(plan.breakdown.netPayableCents),
          idempotencyKey: plan.idempotencyKey,
        })),
        skipDuplicates: true,
      });

      return settlement;
    });

    return {
      id: created.id,
      code: created.code,
      netPayableCents: totals.netPayableCents,
      warnings,
    };
  }

  // -------------------------------------------------------------------------
  // 状态流转
  // -------------------------------------------------------------------------

  async submit(user: AuthUser, id: string) {
    const settlement = await this.loadForWrite(id);
    assertSettlementTransition(settlement.status, 'PENDING_APPROVAL');
    await this.assertItemIntegrity(settlement.id);
    await this.prisma.settlement.update({
      where: { id },
      data: { status: 'PENDING_APPROVAL' },
    });
    return this.findOne(user, id);
  }

  async adjust(user: AuthUser, id: string, dto: AdjustSettlementDto) {
    const settlement = await this.loadForWrite(id);
    // 金额调整只能在草稿/争议态进行；已审批金额必须冻结
    if (!['DRAFT', 'DISPUTED'].includes(settlement.status)) {
      throw new StateConflictException(
        `结算单当前为「${SETTLEMENT_STATUS_LABELS[settlement.status]}」，只有草稿或有争议状态允许调整金额`,
        { allowedFrom: ['DRAFT', 'DISPUTED'] },
      );
    }

    const adjustmentCents = decimalToCents(dto.amount);
    if (adjustmentCents === 0) throw new BusinessException('INVALID_ADJUSTMENT', '调整金额不能为 0');

    const netCents = decimalToCents(settlement.netPayable);
    const adjustedNet = netCents + adjustmentCents;
    if (adjustedNet < 0) {
      throw new BusinessException(
        'INVALID_ADJUSTMENT',
        `调整后应付金额为负（${centsToDecimalString(adjustedNet)} 元），请检查调整金额`,
      );
    }

    await this.prisma.settlement.update({
      where: { id },
      data: {
        adjustmentAmount: centsToDecimalString(adjustmentCents),
        adjustmentReason: dto.reason,
        // netPayable 保持「明细汇总值」不变，实际支付额 = netPayable + adjustmentAmount，
        // 这样明细与合同口径始终可复算，调整原因单独留痕。
      },
    });
    return this.findOne(user, id);
  }

  async approve(user: AuthUser, id: string) {
    const settlement = await this.loadForWrite(id);
    assertSettlementTransition(settlement.status, 'APPROVED');
    await this.assertItemIntegrity(settlement.id);

    // 审批与提交人不能是同一人（双人复核），资金类操作的基本内控要求
    if (settlement.createdById && settlement.createdById === user.id) {
      const hasIndependentApprover = await this.prisma.user.count({
        where: { id: { not: user.id }, role: { in: ['FINANCE', 'SUPER_ADMIN'] }, status: 'ACTIVE' },
      });
      if (hasIndependentApprover > 0) {
        throw new BusinessException(
          'APPROVAL_SEGREGATION',
          '结算单创建人不能审批自己生成的单据，请由其他财务同事审批（双人复核）',
          403,
        );
      }
    }

    await this.prisma.settlement.update({
      where: { id },
      data: { status: 'APPROVED', approvedById: user.id, approvedAt: new Date() },
    });
    return this.findOne(user, id);
  }

  async pay(user: AuthUser, id: string, dto: PaySettlementDto) {
    const settlement = await this.loadForWrite(id);
    assertSettlementTransition(settlement.status, 'PAID');
    await this.prisma.settlement.update({
      where: { id },
      data: {
        status: 'PAID',
        paidAt: new Date(),
        paymentVoucherUrl: dto.paymentVoucherUrl ?? settlement.paymentVoucherUrl,
      },
    });
    // 打款后通知达人负责人，便于其跟进达人确认收款
    await this.notifyPayment(settlement.creatorId, settlement.code);
    return this.findOne(user, id);
  }

  async dispute(user: AuthUser, id: string, reason: string) {
    const settlement = await this.loadForWrite(id);
    assertSettlementTransition(settlement.status, 'DISPUTED');
    await this.prisma.settlement.update({
      where: { id },
      data: { status: 'DISPUTED', disputeReason: reason },
    });
    return this.findOne(user, id);
  }

  async void(user: AuthUser, id: string, reason: string) {
    const settlement = await this.loadForWrite(id);
    assertSettlementTransition(settlement.status, 'VOID');
    await this.prisma.settlement.update({
      where: { id },
      data: { status: 'VOID', remark: `作废原因：${reason}` },
    });
    return this.findOne(user, id);
  }

  // -------------------------------------------------------------------------
  // 导出
  // -------------------------------------------------------------------------

  /** 导出 CSV。加 BOM 保证 Excel 打开不乱码——财务实际使用 Excel 对账 */
  async exportCsv(user: AuthUser, query: QuerySettlementDto): Promise<{ filename: string; content: string }> {
    const listQuery = { ...query, page: 1, pageSize: 100 } as QuerySettlementDto;
    const all: SettlementListItem[] = [];
    let page = 1;
    // 分页拉取，避免一次性把全量结算读进内存
    for (;;) {
      const pageResult = await this.list(user, { ...listQuery, page } as QuerySettlementDto);
      all.push(...pageResult.items);
      if (!pageResult.hasNext || page >= 200) break;
      page += 1;
    }

    const header = [
      '结算单号',
      '达人',
      '账期开始',
      '账期结束',
      '状态',
      '总流水(元)',
      '平台抽成(元)',
      '公司分成(元)',
      '达人分成(元)',
      '代扣税(元)',
      '应付金额(元)',
      '调整(元)',
      '实际支付(元)',
      '账期截止',
      '打款时间',
    ];
    const rows = all.map((item) => {
      const actual = Number(item.netPayable) + Number(item.adjustmentAmount);
      return [
        item.code,
        item.creatorName,
        item.periodStart.slice(0, 10),
        item.periodEnd.slice(0, 10),
        item.statusLabel,
        item.grossAmount,
        item.platformFee,
        item.agencyShare,
        item.talentGross,
        item.taxWithheld,
        item.netPayable,
        item.adjustmentAmount,
        actual.toFixed(2),
        item.dueDate ?? '',
        item.paidAt?.slice(0, 10) ?? '',
      ];
    });

    const csv = [header, ...rows]
      .map((row) => row.map(csvCell).join(','))
      .join('\r\n');
    return {
      filename: `settlements-${new Date().toISOString().slice(0, 10)}.csv`,
      content: `\uFEFF${csv}`,
    };
  }

  // -------------------------------------------------------------------------
  // 内部工具
  // -------------------------------------------------------------------------

  private async loadForWrite(id: string) {
    const settlement = await this.prisma.settlement.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        code: true,
        status: true,
        creatorId: true,
        createdById: true,
        netPayable: true,
        paymentVoucherUrl: true,
      },
    });
    if (!settlement) throw new ResourceNotFoundException('结算单');
    return settlement;
  }

  /**
   * 明细完整性校验：审批/提交前确认「明细汇总 = 单据头部金额」。
   * 这能拦住手改数据库、并发调整、历史迁移造成的静默不一致——资金单据的最后一道闸。
   */
  private async assertItemIntegrity(settlementId: string): Promise<void> {
    const items = await this.prisma.settlementItem.findMany({
      where: { settlementId },
      select: { netPayable: true, grossAmount: true },
    });
    if (items.length === 0) {
      throw new UnprocessableException('结算单没有任何明细，无法提交/审批');
    }
    const settlement = await this.prisma.settlement.findUniqueOrThrow({
      where: { id: settlementId },
      select: { netPayable: true },
    });
    const sum = items.reduce((acc, item) => acc + decimalToCents(item.netPayable), 0);
    const head = decimalToCents(settlement.netPayable);
    if (sum !== head) {
      throw new UnprocessableException(
        `结算单明细汇总（${centsToDecimalString(sum)} 元）与单据应付金额（${centsToDecimalString(head)} 元）不一致，请重新生成结算单`,
      );
    }
  }

  /**
   * 解析账期，并把参数错误转成 422。
   *
   * 为什么需要包一层：`resolvePeriod` 在既没给 month 也没给区间时会
   * `throw new Error(...)`。那是普通 Error，不是 HttpException，
   * 全局异常过滤器只能把它当未知错误处理成 **500**——
   * 明明是一个「请求参数没给全」的问题，却报成服务端故障，
   * 前端拿不到可操作的信息，排查时也会误以为后端崩了。
   *
   * 另外这里统一把三个可选参数都传下去，避免出现
   * 「DTO 有 month 字段、调用处忘了传」这类静默失效
   * （早期 generate 就漏传了 month，导致传 { month: '2026-01' } 直接 500）。
   */
  private resolvePeriodOrFail(input: {
    month?: string;
    periodStart?: string;
    periodEnd?: string;
  }): { start: Date; end: Date; label: string } {
    try {
      return resolvePeriod({
        month: input.month,
        periodStart: input.periodStart ? new Date(input.periodStart) : undefined,
        periodEnd: input.periodEnd ? new Date(input.periodEnd) : undefined,
      });
    } catch (error) {
      throw new UnprocessableException(
        error instanceof Error ? error.message : '账期参数不正确',
        { month: input.month, periodStart: input.periodStart, periodEnd: input.periodEnd },
      );
    }
  }

  private async notifyPayment(creatorId: string, settlementCode: string): Promise<void> {    const creator = await this.prisma.creator.findUnique({
      where: { id: creatorId },
      select: { name: true, ownerId: true },
    });
    if (!creator?.ownerId) return;
    await this.prisma.notification
      .create({
        data: {
          userId: creator.ownerId,
          type: 'SETTLEMENT_DUE',
          title: `结算单 ${settlementCode} 已打款`,
          content: `达人「${creator.name}」的结算单已完成打款，请跟进达人确认收款。`,
          link: `/settlements`,
          dedupeKey: `paid:${settlementCode}`,
        },
      })
      // 同一单据重复打款不应报错（幂等键冲突即可忽略）
      .catch(() => undefined);
  }

  private toListItem(row: {
    id: string;
    code: string;
    creatorId: string;
    periodStart: Date;
    periodEnd: Date;
    status: SettlementStatus;
    currency: string;
    grossAmount: Prisma.Decimal;
    platformFee: Prisma.Decimal;
    agencyShare: Prisma.Decimal;
    talentGross: Prisma.Decimal;
    taxWithheld: Prisma.Decimal;
    netPayable: Prisma.Decimal;
    adjustmentAmount: Prisma.Decimal;
    dueDate: Date | null;
    approvedAt: Date | null;
    paidAt: Date | null;
    createdAt: Date;
    creator: { id: string; name: string; code: string };
    _count: { items: number };
  }): SettlementListItem {
    return {
      id: row.id,
      code: row.code,
      creatorId: row.creatorId,
      creatorName: row.creator.name,
      periodStart: row.periodStart.toISOString().slice(0, 10),
      periodEnd: row.periodEnd.toISOString().slice(0, 10),
      status: row.status,
      statusLabel: SETTLEMENT_STATUS_LABELS[row.status],
      currency: row.currency,
      grossAmount: row.grossAmount.toFixed(2),
      platformFee: row.platformFee.toFixed(2),
      agencyShare: row.agencyShare.toFixed(2),
      talentGross: row.talentGross.toFixed(2),
      taxWithheld: row.taxWithheld.toFixed(2),
      netPayable: row.netPayable.toFixed(2),
      adjustmentAmount: row.adjustmentAmount.toFixed(2),
      dueDate: row.dueDate?.toISOString().slice(0, 10) ?? null,
      approvedAt: row.approvedAt?.toISOString() ?? null,
      paidAt: row.paidAt?.toISOString() ?? null,
      itemCount: row._count.items,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

/** 解析合同里的阶梯配置 JSON，容错处理历史脏数据 */
function parseTieredShares(value: Prisma.JsonValue | null): SettlementRule['tieredShares'] {
  if (!value || !Array.isArray(value)) return null;
  const rules = value
    .map((raw) => {
      if (!raw || typeof raw !== 'object') return null;
      const item = raw as Record<string, unknown>;
      const from = Number(item.from);
      const to = item.to === null || item.to === undefined ? null : Number(item.to);
      const talentShareBp = Number(item.talentShareBp);
      if (!Number.isFinite(from) || !Number.isFinite(talentShareBp)) return null;
      return { from, to, talentShareBp };
    })
    .filter((item): item is { from: number; to: number | null; talentShareBp: number } => item !== null);
  return rules.length > 0 ? rules : null;
}

/** CSV 单元格转义：含逗号/引号/换行的值必须加引号 */
function csvCell(value: string): string {
  const text = String(value ?? '');
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}
