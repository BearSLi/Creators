import { Injectable, Logger } from '@nestjs/common';
import { Contract, ContractStatus, Prisma } from '@prisma/client';
import {
  BusinessException,
  ResourceNotFoundException,
  StateConflictException,
  UnprocessableException,
} from '../../common/exceptions/business.exception';
import { centsToDecimalString, decimalToCents } from '../../common/utils/money';
import { buildPaginated, PaginatedResult, resolveOrderBy } from '../../common/utils/pagination';
import { assertOwnership, buildScopeFilter } from '../../common/utils/scope';
import { extractCount } from '../../common/utils/group-count';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import { CodeGeneratorService, CODE_PREFIX } from '../common/code-generator.service';
import { calculateSettlement, resolvePeriod, SettlementRule } from '../settlements/settlement.calculator';
import {
  ApproveContractDto,
  CreateContractDto,
  QueryContractDto,
  TerminateContractDto,
  UpdateContractDto,
} from './dto/contract.dto';

/** 合同状态机：DRAFT → PENDING_REVIEW → ACTIVE → EXPIRED/TERMINATED */
export const CONTRACT_TRANSITIONS: Record<ContractStatus, ContractStatus[]> = {
  DRAFT: ['PENDING_REVIEW', 'TERMINATED'],
  PENDING_REVIEW: ['ACTIVE', 'DRAFT', 'TERMINATED'],
  ACTIVE: ['EXPIRED', 'TERMINATED'],
  EXPIRED: ['ACTIVE', 'TERMINATED'],
  TERMINATED: [],
};

export const CONTRACT_STATUS_LABELS: Record<ContractStatus, string> = {
  DRAFT: '草稿',
  PENDING_REVIEW: '待审核',
  ACTIVE: '生效中',
  EXPIRED: '已到期',
  TERMINATED: '已终止',
};

export const SETTLEMENT_MODE_LABELS: Record<string, string> = {
  REVENUE_SHARE: '流水分成',
  FIXED_FEE: '一口价',
  HYBRID: '保底+分成',
  CPA: '按效果付费',
};

@Injectable()
export class ContractService {
  private readonly logger = new Logger(ContractService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly codeGenerator: CodeGeneratorService,
  ) {}

  async list(user: AuthUser, query: QueryContractDto): Promise<PaginatedResult<ContractListItem>> {
    const where: Prisma.ContractWhereInput = {
      deletedAt: null,
      creator: buildScopeFilter(user) as Prisma.CreatorWhereInput,
      status: query.status?.length ? { in: query.status } : undefined,
      creatorId: query.creatorId,
      brandId: query.brandId,
      OR: query.keyword
        ? [
            { code: { contains: query.keyword, mode: 'insensitive' } },
            { title: { contains: query.keyword, mode: 'insensitive' } },
            { creator: { name: { contains: query.keyword, mode: 'insensitive' } } },
          ]
        : undefined,
    };

    const orderBy = resolveOrderBy(
      query.sortBy,
      query.sortOrder,
      ['createdAt', 'effectiveFrom', 'effectiveTo', 'fixedFee'] as const,
      'createdAt',
    );

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.contract.findMany({
        where,
        orderBy,
        skip: query.skip,
        take: query.take,
        include: {
          creator: { select: { id: true, name: true, code: true, status: true } },
          brand: { select: { id: true, name: true } },
          _count: { select: { projects: true } },
        },
      }),
      this.prisma.contract.count({ where }),
    ]);

    return buildPaginated(
      rows.map((row) => this.toListItem(row, row._count.projects)),
      total,
      query.page,
      query.pageSize,
    );
  }

  async findOne(user: AuthUser, id: string) {
    const contract = await this.prisma.contract.findFirst({
      where: { id, deletedAt: null },
      include: {
        creator: { select: { id: true, name: true, code: true, status: true, tier: true } },
        brand: { select: { id: true, name: true, level: true } },
        projects: {
          where: { deletedAt: null },
          select: { id: true, code: true, name: true, status: true, dueDate: true },
          take: 50,
        },
        reviewedBy: { select: { id: true, name: true } },
      },
    });
    if (!contract) throw new ResourceNotFoundException('合同');
    await this.assertCreatorInScope(user, contract.creatorId, '合同');

    // 待结算预估：让商务在签约时就能看到「这份合同大概要付多少」
    const settlements = await this.prisma.settlement.aggregate({
      where: { creatorId: contract.creatorId, deletedAt: null, status: { notIn: ['VOID'] } },
      _sum: { netPayable: true, grossAmount: true },
      _count: { _all: true },
    });

    return {
      ...this.toListItem(contract, contract.projects.length),
      creator: contract.creator,
      brand: contract.brand,
      tieredShares: contract.tieredShares,
      deliverableSpec: contract.deliverableSpec,
      breachClause: contract.breachClause,
      exclusivityScope: contract.exclusivityScope,
      attachmentUrls: contract.attachmentUrls,
      reviewNote: contract.reviewNote,
      reviewedBy: contract.reviewedBy,
      reviewedAt: contract.reviewedAt?.toISOString() ?? null,
      cpaUnitPrice: contract.cpaUnitPrice.toFixed(2),
      projects: contract.projects.map((project) => ({
        id: project.id,
        code: project.code,
        name: project.name,
        status: project.status,
        dueDate: project.dueDate?.toISOString().slice(0, 10) ?? null,
      })),
      settlementSummary: {
        count: extractCount(settlements),
        grossAmount: (settlements._sum?.grossAmount ?? new Prisma.Decimal(0)).toFixed(2),
        netPayable: (settlements._sum?.netPayable ?? new Prisma.Decimal(0)).toFixed(2),
      },
      statusMachine: {
        allowedNext: (CONTRACT_TRANSITIONS[contract.status] ?? []).map((status) => ({
          value: status,
          label: CONTRACT_STATUS_LABELS[status],
        })),
      },
      /** 分润规则换算预览，前端表单与详情页直接展示百分比 */
      sharePreview: {
        platformFeePercent: contract.platformFeeBp / 100,
        agencySharePercent: contract.agencyShareBp / 100,
        talentSharePercent: contract.talentShareBp / 100,
        taxWithholdPercent: contract.taxWithholdBp / 100,
      },
    };
  }

  async create(user: AuthUser, dto: CreateContractDto) {
    const creator = await this.prisma.creator.findFirst({
      where: { id: dto.creatorId, deletedAt: null },
      select: { id: true, name: true, status: true },
    });
    if (!creator) throw new ResourceNotFoundException('达人');

    const effectiveFrom = new Date(dto.effectiveFrom);
    const effectiveTo = new Date(dto.effectiveTo);
    this.assertPeriodValid(effectiveFrom, effectiveTo);
    this.assertShareRule(dto);

    const created = await this.prisma.withTransaction(async (tx) => {
      const code = await this.codeGenerator.next(CODE_PREFIX.CONTRACT, tx);
      return tx.contract.create({
        data: {
          code,
          title: dto.title,
          creatorId: dto.creatorId,
          brandId: dto.brandId ?? null,
          status: 'DRAFT',
          settlementMode: dto.settlementMode,
          currency: dto.currency ?? 'CNY',
          fixedFee: dto.fixedFee ?? '0',
          platformFeeBp: dto.platformFeeBp,
          agencyShareBp: dto.agencyShareBp,
          talentShareBp: dto.talentShareBp,
          taxWithholdBp: dto.taxWithholdBp,
          cpaUnitPrice: dto.cpaUnitPrice ?? '0',
          tieredShares: (dto.tieredShares ?? undefined) as Prisma.InputJsonValue | undefined,
          effectiveFrom,
          effectiveTo,
          exclusivity: dto.exclusivity ?? false,
          exclusivityScope: dto.exclusivityScope ?? null,
          deliverableSpec: (dto.deliverableSpec ?? undefined) as Prisma.InputJsonValue | undefined,
          breachClause: dto.breachClause ?? null,
          attachmentUrls: dto.attachmentUrls ?? [],
          createdById: user.id,
        },
        select: { id: true },
      });
    });

    this.logger.log(`新建合同 id=${created.id} 达人=${creator.name} by=${user.email}`);
    return this.findOne(user, created.id);
  }

  async update(user: AuthUser, id: string, dto: UpdateContractDto) {
    const contract = await this.prisma.contract.findFirst({ where: { id, deletedAt: null } });
    if (!contract) throw new ResourceNotFoundException('合同');
    // 生效中的合同不能改分润条款：改了会让历史结算口径与合同对不上
    if (contract.status === 'ACTIVE' && this.touchesMoney(dto)) {
      throw new StateConflictException(
        '生效中的合同不允许修改金额与分润条款。如需变更请先终止本合同并签署新合同，以保留历史结算依据',
      );
    }
    if (contract.status === 'PENDING_REVIEW' && this.touchesMoney(dto)) {
      throw new StateConflictException('待审核的合同已锁定金额条款，请先撤回为草稿再修改');
    }

    const effectiveFrom = dto.effectiveFrom ? new Date(dto.effectiveFrom) : contract.effectiveFrom;
    const effectiveTo = dto.effectiveTo ? new Date(dto.effectiveTo) : contract.effectiveTo;
    this.assertPeriodValid(effectiveFrom, effectiveTo);
    if (
      dto.platformFeeBp !== undefined ||
      dto.agencyShareBp !== undefined ||
      dto.talentShareBp !== undefined ||
      dto.taxWithholdBp !== undefined
    ) {
      this.assertShareRule({
        platformFeeBp: dto.platformFeeBp ?? contract.platformFeeBp,
        agencyShareBp: dto.agencyShareBp ?? contract.agencyShareBp,
        talentShareBp: dto.talentShareBp ?? contract.talentShareBp,
        taxWithholdBp: dto.taxWithholdBp ?? contract.taxWithholdBp,
      });
    }

    await this.prisma.contract.update({
      where: { id },
      data: {
        title: dto.title,
        brandId: dto.brandId,
        settlementMode: dto.settlementMode,
        currency: dto.currency,
        fixedFee: dto.fixedFee,
        platformFeeBp: dto.platformFeeBp,
        agencyShareBp: dto.agencyShareBp,
        talentShareBp: dto.talentShareBp,
        taxWithholdBp: dto.taxWithholdBp,
        cpaUnitPrice: dto.cpaUnitPrice,
        tieredShares: (dto.tieredShares ?? undefined) as Prisma.InputJsonValue | undefined,
        effectiveFrom: dto.effectiveFrom ? effectiveFrom : undefined,
        effectiveTo: dto.effectiveTo ? effectiveTo : undefined,
        exclusivity: dto.exclusivity,
        exclusivityScope: dto.exclusivityScope,
        deliverableSpec: (dto.deliverableSpec ?? undefined) as Prisma.InputJsonValue | undefined,
        breachClause: dto.breachClause,
        attachmentUrls: dto.attachmentUrls,
      },
    });
    return this.findOne(user, id);
  }

  /** 提交审核：校验条款完整性与合同区间冲突 */
  async submit(user: AuthUser, id: string) {
    const contract = await this.getOrThrow(id);
    this.assertTransition(contract.status, 'PENDING_REVIEW');
    await this.assertNoOverlap(contract.creatorId, contract.effectiveFrom, contract.effectiveTo, contract.id);

    await this.prisma.contract.update({
      where: { id },
      data: {
        status: 'PENDING_REVIEW',
        reviewNote: null,
        reviewedById: null,
        reviewedAt: null,
      },
    });
    return this.findOne(user, id);
  }

  /**
   * 审批。
   * 通过时：
   *   1) 再次校验区间冲突（提交后可能有人插入了新合同）；
   *   2) 将达人状态推进到 SIGNED（若还在线索/建联阶段）——避免业务上「有合同但达人未签约」的矛盾态；
   *   3) 独家条款与其他生效合同的独家范围冲突检查。
   */
  async approve(user: AuthUser, id: string, dto: ApproveContractDto) {
    const contract = await this.getOrThrow(id);
    this.assertTransition(contract.status, dto.approved ? 'ACTIVE' : 'DRAFT');

    if (!dto.approved) {
      await this.prisma.contract.update({
        where: { id },
        data: {
          status: 'DRAFT',
          reviewNote: dto.note ?? '审核驳回',
          reviewedById: user.id,
          reviewedAt: new Date(),
        },
      });
      return this.findOne(user, id);
    }

    // 审批人不能是自己拟的合同（双人复核）
    if (contract.createdById && contract.createdById === user.id) {
      const otherApprovers = await this.prisma.user.count({
        where: {
          id: { not: user.id },
          status: 'ACTIVE',
          role: { in: ['SUPER_ADMIN', 'FINANCE'] },
        },
      });
      if (otherApprovers > 0) {
        throw new BusinessException(
          'APPROVAL_SEGREGATION',
          '合同拟定人不能审批自己拟定的合同，请由其他负责人审核（双人复核）',
          403,
        );
      }
    }

    await this.assertNoOverlap(contract.creatorId, contract.effectiveFrom, contract.effectiveTo, contract.id);
    if (contract.exclusivity) {
      await this.assertExclusivityCompatible(contract);
    }

    await this.prisma.withTransaction(async (tx) => {
      await tx.contract.update({
        where: { id },
        data: {
          status: 'ACTIVE',
          signedAt: contract.signedAt ?? new Date(),
          reviewNote: dto.note ?? '审核通过',
          reviewedById: user.id,
          reviewedAt: new Date(),
        },
      });

      const creator = await tx.creator.findUniqueOrThrow({
        where: { id: contract.creatorId },
        select: { status: true, signedAt: true },
      });
      // 达人还处在签约前阶段时自动推进为已签约，保证状态与合同事实一致
      if (['LEAD', 'CONTACTING', 'EVALUATING'].includes(creator.status)) {
        await tx.creator.update({
          where: { id: contract.creatorId },
          data: { status: 'SIGNED', signedAt: creator.signedAt ?? new Date() },
        });
        this.logger.log(`合同生效带动达人状态推进：creator=${contract.creatorId} → SIGNED`);
      }
    });

    return this.findOne(user, id);
  }

  async terminate(user: AuthUser, id: string, dto: TerminateContractDto) {
    const contract = await this.getOrThrow(id);
    this.assertTransition(contract.status, 'TERMINATED');

    // 有未结清的结算单时不允许直接终止，否则财务链路断裂
    const unsettled = await this.prisma.settlement.count({
      where: {
        creatorId: contract.creatorId,
        deletedAt: null,
        status: { in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'DISPUTED'] },
      },
    });
    if (unsettled > 0 && !dto.force) {
      throw new StateConflictException(
        `该达人存在 ${unsettled} 张未结清结算单，终止合同前请先完成结算或勾选「强制终止」`,
        { unsettledCount: unsettled, allowForce: true },
      );
    }

    await this.prisma.contract.update({
      where: { id },
      data: {
        status: 'TERMINATED',
        reviewNote: `${contract.reviewNote ?? ''}\n[终止] ${new Date().toISOString().slice(0, 10)} ${dto.reason}（操作人：${user.name}）`,
      },
    });
    this.logger.warn(`合同终止 code=${contract.code} 原因=${dto.reason} by=${user.email}`);
    return this.findOne(user, id);
  }

  /**
   * 结算预估。
   * 让商务在签约前/结算前就能回答「这个月大概要付达人多少钱」——
   * 这是运营侧最高频的问题，直接用与正式结算完全相同的计算引擎，
   * 保证预估与最终出账口径一致（不会出现预估 1 万、实际 1.2 万的信任崩塌）。
   */
  async previewSettlement(
    user: AuthUser,
    id: string,
    period: { month?: string; periodStart?: string; periodEnd?: string },
  ) {
    const contract = await this.getOrThrow(id);
    // 预估接口会返回预估金额，属于敏感信息，必须做数据范围校验：
    // 商务只能预估自己负责的达人合同，否则等于绕过了列表页的范围过滤。
    await this.assertCreatorInScope(user, contract.creatorId, '合同');
    const range = resolvePeriod({
      month: period.month,
      periodStart: period.periodStart ? new Date(period.periodStart) : undefined,
      periodEnd: period.periodEnd ? new Date(period.periodEnd) : undefined,
    });

    const rule: SettlementRule = {
      settlementMode: contract.settlementMode,
      fixedFeeCents: decimalToCents(contract.fixedFee),
      platformFeeBp: contract.platformFeeBp,
      agencyShareBp: contract.agencyShareBp,
      talentShareBp: contract.talentShareBp,
      taxWithholdBp: contract.taxWithholdBp,
      tieredShares: contract.tieredShares as SettlementRule['tieredShares'],
      cpaUnitPriceCents: decimalToCents(contract.cpaUnitPrice),
    };

    const contents = await this.prisma.content.findMany({
      where: {
        creatorId: contract.creatorId,
        deletedAt: null,
        publishedAt: { gte: range.start, lte: range.end },
        revenueCents: { gt: 0n },
      },
      select: { id: true, title: true, platform: true, publishedAt: true, revenueCents: true, conversions: true },
      orderBy: { publishedAt: 'asc' },
      take: 1000,
    });

    const items = contents.map((content) => {
      const breakdown = calculateSettlement({
        rule,
        grossCents: Number(content.revenueCents),
        conversions: content.conversions,
        description: content.title,
      });
      return {
        contentId: content.id,
        title: content.title,
        platform: content.platform,
        publishedAt: content.publishedAt?.toISOString() ?? null,
        grossYuan: centsToDecimalString(breakdown.grossCents),
        platformFeeYuan: centsToDecimalString(breakdown.platformFeeCents),
        agencyShareYuan: centsToDecimalString(breakdown.agencyShareCents),
        talentGrossYuan: centsToDecimalString(breakdown.talentGrossCents),
        taxYuan: centsToDecimalString(breakdown.taxWithheldCents),
        netYuan: centsToDecimalString(breakdown.netPayableCents),
        trace: breakdown.trace,
        warnings: breakdown.warnings,
      };
    });

    const totals = items.reduce(
      (acc, item) => ({
        grossYuan: acc.grossYuan + Number(item.grossYuan),
        platformFeeYuan: acc.platformFeeYuan + Number(item.platformFeeYuan),
        agencyShareYuan: acc.agencyShareYuan + Number(item.agencyShareYuan),
        talentGrossYuan: acc.talentGrossYuan + Number(item.talentGrossYuan),
        taxYuan: acc.taxYuan + Number(item.taxYuan),
        netYuan: acc.netYuan + Number(item.netYuan),
      }),
      { grossYuan: 0, platformFeeYuan: 0, agencyShareYuan: 0, talentGrossYuan: 0, taxYuan: 0, netYuan: 0 },
    );

    const fixedFeeItem =
      contract.settlementMode === 'FIXED_FEE' || contract.settlementMode === 'HYBRID'
        ? calculateSettlement({ rule, grossCents: 0, description: '合同固定/保底费用' })
        : null;

    return {
      contractCode: contract.code,
      settlementMode: contract.settlementMode,
      period: range.label,
      items,
      fixedFeeItem: fixedFeeItem
        ? {
            grossYuan: centsToDecimalString(fixedFeeItem.grossCents),
            talentGrossYuan: centsToDecimalString(fixedFeeItem.talentGrossCents),
            taxYuan: centsToDecimalString(fixedFeeItem.taxWithheldCents),
            netYuan: centsToDecimalString(fixedFeeItem.netPayableCents),
            trace: fixedFeeItem.trace,
          }
        : null,
      summary: {
        grossYuan: totals.grossYuan.toFixed(2),
        platformFeeYuan: totals.platformFeeYuan.toFixed(2),
        agencyShareYuan: totals.agencyShareYuan.toFixed(2),
        talentGrossYuan: totals.talentGrossYuan.toFixed(2),
        taxYuan: totals.taxYuan.toFixed(2),
        netYuan: totals.netYuan.toFixed(2),
        estimatedTotalNetYuan: (
          totals.netYuan + Number(fixedFeeItem ? centsToDecimalString(fixedFeeItem.netPayableCents) : 0)
        ).toFixed(2),
      },
      generatedAt: new Date().toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // 校验
  // -------------------------------------------------------------------------

  /**
   * 软删除合同。
   * 只允许删除草稿：已提交审核或生效的合同是结算依据，删除会让历史账目失去凭证。
   * 需要停止合作的场景应走 terminate（终止），保留完整链路。
   */
  async softDelete(user: AuthUser, id: string): Promise<{ id: string; deleted: true }> {
    const contract = await this.getOrThrow(id);
    if (contract.status !== 'DRAFT') {
      throw new StateConflictException(
        `只有草稿状态的合同可以删除，当前状态为「${CONTRACT_STATUS_LABELS[contract.status]}」。如需停止合作请使用「终止合同」`,
      );
    }
    const linked = await this.prisma.project.count({ where: { contractId: id, deletedAt: null } });
    if (linked > 0) {
      throw new StateConflictException(`该合同已关联 ${linked} 个项目，请先解除项目关联再删除`);
    }

    await this.prisma.contract.update({ where: { id }, data: { deletedAt: new Date() } });
    this.logger.log(`删除合同草稿 code=${contract.code} by=${user.email}`);
    return { id, deleted: true };
  }

  private async getOrThrow(id: string): Promise<Contract> {
    const contract = await this.prisma.contract.findFirst({ where: { id, deletedAt: null } });
    if (!contract) throw new ResourceNotFoundException('合同');
    return contract;
  }

  /**
   * 按**达人归属**校验数据范围。
   *
   * 为什么不是按合同创建人校验：合同的可见性应当跟随达人（商务只能看到自己负责达人的合同），
   * 而不是「谁拟的谁看」。早期实现用 createdById 做归属校验，会导致两个问题：
   *   1) 商务 A 拟的合同，交接给商务 B 后 B 看不到；
   *   2) 运营代拟的合同，所有商务都能看到。
   * 两个方向都不符合业务预期，所以统一改为经达人归属判定。
   */
  private async assertCreatorInScope(user: AuthUser, creatorId: string, resourceName: string): Promise<void> {
    const creator = await this.prisma.creator.findFirst({
      where: { id: creatorId },
      select: { ownerId: true, teamId: true },
    });
    if (!creator) throw new ResourceNotFoundException('达人');
    assertOwnership(user, creator, { resourceName });
  }

  private assertTransition(from: ContractStatus, to: ContractStatus): void {
    const allowed = CONTRACT_TRANSITIONS[from] ?? [];
    if (!allowed.includes(to)) {
      throw new StateConflictException(
        `合同不允许从「${CONTRACT_STATUS_LABELS[from]}」变更为「${CONTRACT_STATUS_LABELS[to]}」`,
        { from, to, allowedNext: allowed },
      );
    }
  }

  private assertPeriodValid(from: Date, to: Date): void {
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new UnprocessableException('合同生效期日期格式不正确');
    }
    if (to <= from) {
      throw new UnprocessableException('合同结束日期必须晚于开始日期');
    }
    if ((to.getTime() - from.getTime()) / 86_400_000 > 3650) {
      throw new UnprocessableException('合同期限不得超过 10 年，请核对日期');
    }
  }

  /** 分润规则自洽校验：公司与达人分成不得超过净额 */
  private assertShareRule(rule: {
    platformFeeBp: number;
    agencyShareBp: number;
    talentShareBp: number;
    taxWithholdBp: number;
  }): void {
    if (rule.agencyShareBp + rule.talentShareBp > 10_000) {
      throw new UnprocessableException(
        `分润比例不自洽：公司 ${rule.agencyShareBp / 100}% + 达人 ${rule.talentShareBp / 100}% 超过 100%`,
      );
    }
    if (rule.taxWithholdBp > 10_000) {
      throw new UnprocessableException('代扣税率不得超过 100%');
    }
  }

  /** 修改是否触及金额条款（生效中的合同禁止改动） */
  private touchesMoney(dto: UpdateContractDto): boolean {
    return [
      dto.fixedFee,
      dto.platformFeeBp,
      dto.agencyShareBp,
      dto.talentShareBp,
      dto.taxWithholdBp,
      dto.cpaUnitPrice,
      dto.settlementMode,
      dto.tieredShares,
    ].some((value) => value !== undefined);
  }

  /**
   * 合同区间冲突检测（同一达人）。
   *
   * 为什么必须拦住：结算引擎要求「一个账期内同一达人只有一份生效合同」，
   * 否则无法确定按哪份合同的分润规则计算。这里在签约入口就拦住，
   * 而不是等到月底出账时才失败——那时业务已经发生，补救成本极高。
   */
  private async assertNoOverlap(
    creatorId: string,
    from: Date,
    to: Date,
    excludeId?: string,
  ): Promise<void> {
    const conflicts = await this.prisma.contract.findMany({
      where: {
        creatorId,
        deletedAt: null,
        id: excludeId ? { not: excludeId } : undefined,
        status: { in: ['ACTIVE', 'PENDING_REVIEW'] },
        // 区间相交：existing.from <= to && existing.to >= from
        effectiveFrom: { lte: to },
        effectiveTo: { gte: from },
      },
      select: { code: true, effectiveFrom: true, effectiveTo: true, status: true },
    });

    if (conflicts.length > 0) {
      const detail = conflicts
        .map(
          (item) =>
            `${item.code}（${item.effectiveFrom.toISOString().slice(0, 10)} ~ ${item.effectiveTo.toISOString().slice(0, 10)}，${CONTRACT_STATUS_LABELS[item.status]}）`,
        )
        .join('、');
      throw new StateConflictException(
        `该达人在此期间已存在生效/待审核合同：${detail}。同一达人同一时间只能有一份生效合同，否则结算口径会产生歧义`,
        { conflicts },
      );
    }
  }

  /** 独家条款冲突：同类目竞品独家不得并存 */
  private async assertExclusivityCompatible(contract: Contract): Promise<void> {
    const exclusives = await this.prisma.contract.findMany({
      where: {
        creatorId: contract.creatorId,
        deletedAt: null,
        id: { not: contract.id },
        exclusivity: true,
        status: 'ACTIVE',
        effectiveFrom: { lte: contract.effectiveTo },
        effectiveTo: { gte: contract.effectiveFrom },
      },
      select: { code: true, exclusivityScope: true },
    });
    if (exclusives.length > 0) {
      throw new StateConflictException(
        `独家条款冲突：该达人在同一期间已有独家合同 ${exclusives.map((c) => `${c.code}（${c.exclusivityScope ?? '未注明范围'}）`).join('、')}`,
      );
    }
  }

  private toListItem(row: {
    id: string;
    code: string;
    title: string;
    creatorId: string;
    brandId: string | null;
    status: ContractStatus;
    settlementMode: string;
    currency: string;
    fixedFee: Prisma.Decimal;
    platformFeeBp: number;
    agencyShareBp: number;
    talentShareBp: number;
    taxWithholdBp: number;
    effectiveFrom: Date;
    effectiveTo: Date;
    signedAt: Date | null;
    exclusivity: boolean;
    createdAt: Date;
    creator: { id: string; name: string; code: string };
    brand: { id: string; name: string } | null;
    /**
     * 仅详情接口的查询会带上这些关系（列表接口不 include，避免多查一趟）。
     * 标为可选，让同一个映射函数同时服务列表与详情，
     * 也避免了「为迁就类型而额外 include」的无用查询。
     */
    projects?: unknown[];
    reviewedBy?: { id: string; name: string } | null;
  }, projectCount: number): ContractListItem {
    return {
      id: row.id,
      code: row.code,
      title: row.title,
      creatorId: row.creatorId,
      creatorName: row.creator.name,
      creatorCode: row.creator.code,
      brandId: row.brandId,
      brandName: row.brand?.name ?? null,
      status: row.status,
      statusLabel: CONTRACT_STATUS_LABELS[row.status],
      settlementMode: row.settlementMode,
      settlementModeLabel: SETTLEMENT_MODE_LABELS[row.settlementMode] ?? row.settlementMode,
      currency: row.currency,
      fixedFee: row.fixedFee.toFixed(2),
      platformFeeBp: row.platformFeeBp,
      agencyShareBp: row.agencyShareBp,
      talentShareBp: row.talentShareBp,
      taxWithholdBp: row.taxWithholdBp,
      effectiveFrom: row.effectiveFrom.toISOString().slice(0, 10),
      effectiveTo: row.effectiveTo.toISOString().slice(0, 10),
      signedAt: row.signedAt?.toISOString() ?? null,
      exclusivity: row.exclusivity,
      projectCount,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

export interface ContractListItem {
  id: string;
  code: string;
  title: string;
  creatorId: string;
  creatorName: string;
  creatorCode: string;
  brandId: string | null;
  brandName: string | null;
  status: ContractStatus;
  statusLabel: string;
  settlementMode: string;
  settlementModeLabel: string;
  currency: string;
  fixedFee: string;
  platformFeeBp: number;
  agencyShareBp: number;
  talentShareBp: number;
  taxWithholdBp: number;
  effectiveFrom: string;
  effectiveTo: string;
  signedAt: string | null;
  exclusivity: boolean;
  projectCount: number;
  createdAt: string;
}
