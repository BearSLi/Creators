import {
  assertBpRange,
  applyBp,
  centsToYuan,
  findTieredShareBp,
  TieredShareRule,
} from '../../common/utils/money';

/**
 * 结算计算引擎（纯函数，无 IO）。
 *
 * 单独抽出来的理由：这是全系统唯一直接产生「应付金额」的地方，
 * 必须能被单元测试穷举覆盖，且任何路径都不允许出现浮点误差与口径歧义。
 * 所有金额以「分」计算，最后一步才转元；所有比率以基点(bp)整数表示。
 *
 * 分成口径（公司内部标准，与达人签约条款一致）：
 *   gross                     内容/项目产生的总流水
 *   platformFee = gross × platformFeeBp        （平台抽成，向下取整）
 *   net         = gross - platformFee          （可分配净额）
 *   talentGross = net × talentShareBp          （达人分成，向上取整，宁多不少）
 *   agencyShare = net - talentGross            （公司所得 = 净额 - 达人分成，兜住全部尾差）
 *   taxWithheld = talentGross × taxWithholdBp  （代扣个税，四舍五入）
 *   netPayable  = talentGross - taxWithheld    （实际打给达人的金额）
 *
 * 关键设计：agencyShare 用「净额减去达人分成」反推而不是独立相乘，
 * 这样 gross = platformFee + talentGross + agencyShare 恒等成立（分文不差），
 * 财务对账时不会出现「三笔加起来和总流水差一分」的经典问题。
 * 尾差按「公司让利」原则留给达人，这在合作方对账时是信任基础。
 *
 * 阶梯分成：合同可配置 [{from,to,talentShareBp}]，命中区间时覆盖合同的 talentShareBp。
 * 保底与分成（HYBRID）：gross 低于保底时按保底结算，差额计入 trace 便于解释。
 */

export interface SettlementRule {
  /** 结算模式 */
  settlementMode: 'REVENUE_SHARE' | 'FIXED_FEE' | 'HYBRID' | 'CPA';
  /** 保底/一口价（分） */
  fixedFeeCents: number;
  platformFeeBp: number;
  agencyShareBp: number;
  talentShareBp: number;
  taxWithholdBp: number;
  /** 阶梯分成规则，命中后覆盖 talentShareBp */
  tieredShares?: TieredShareRule[] | null;
  /** CPA 单价（分/次转化） */
  cpaUnitPriceCents?: number;
}

export interface SettlementInput {
  rule: SettlementRule;
  /** 该笔分成的总流水（分） */
  grossCents: number;
  /** CPA 模式下的转化数 */
  conversions?: number;
  /** 该笔来源描述，写入明细 */
  description: string;
}

export interface SettlementBreakdown {
  grossCents: number;
  platformFeeCents: number;
  agencyShareCents: number;
  talentGrossCents: number;
  taxWithheldCents: number;
  netPayableCents: number;
  /** 实际生效的比率（阶梯可能覆盖），写入明细与计算链路留痕 */
  effective: {
    platformFeeBp: number;
    agencyShareBp: number;
    talentShareBp: number;
    taxWithholdBp: number;
  };
  /** 计算过程说明，写入 settlement.calculationTrace，任何一笔都可复算 */
  trace: string[];
  /** 异常提示（不阻断出账，但需人工确认） */
  warnings: string[];
}

/** 校验合同分润规则是否自洽，出错直接拒绝出账而不是算出一个错数 */
export function validateRule(rule: SettlementRule): void {
  assertBpRange(rule.platformFeeBp, 'platformFeeBp');
  assertBpRange(rule.agencyShareBp, 'agencyShareBp');
  assertBpRange(rule.talentShareBp, 'talentShareBp');
  assertBpRange(rule.taxWithholdBp, 'taxWithholdBp');

  if (rule.platformFeeBp > 10_000) {
    throw new Error('平台抽成比例不得超过 100%');
  }
  // 公司与达人分成之和不得超过净额（10000bp）
  if (rule.agencyShareBp + rule.talentShareBp > 10_000) {
    throw new Error(
      `分润规则不自洽：公司分成 ${rule.agencyShareBp / 100}% + 达人分成 ${rule.talentShareBp / 100}% 超过 100%`,
    );
  }
  if (rule.tieredShares?.length) {
    for (const tier of rule.tieredShares) {
      assertBpRange(tier.talentShareBp, 'tieredShares.talentShareBp');
      if (tier.to !== null && tier.to <= tier.from) {
        throw new Error(`阶梯区间非法：[${tier.from}, ${tier.to})，上界必须大于下界`);
      }
    }
  }
  if (rule.settlementMode === 'CPA' && (rule.cpaUnitPriceCents ?? 0) <= 0) {
    throw new Error('CPA 模式必须配置大于 0 的单价');
  }
}

/**
 * 计算单笔结算金额。
 * 不接受负数流水；负数（退款/扣款）必须走调整项 adjustment，保证链路可解释。
 */
export function calculateSettlement(input: SettlementInput): SettlementBreakdown {
  const { rule } = input;
  validateRule(rule);

  const trace: string[] = [];
  const warnings: string[] = [];

  if (input.grossCents < 0) {
    throw new Error('流水金额不能为负数，扣减请使用结算单调整项（adjustment）');
  }

  // ---- 1. 确定本笔的应结流水 ----
  let grossCents = input.grossCents;
  let fixedFeeApplied = false;
  const mode = rule.settlementMode;

  if (mode === 'FIXED_FEE') {
    grossCents = rule.fixedFeeCents;
    trace.push(`一口价模式：按合同约定金额 ${centsToYuan(grossCents)} 元结算，不参考实际流水`);
  } else if (mode === 'CPA') {
    const conversions = input.conversions ?? 0;
    grossCents = conversions * (rule.cpaUnitPriceCents ?? 0);
    trace.push(
      `CPA 模式：转化 ${conversions} 次 × 单价 ${centsToYuan(rule.cpaUnitPriceCents ?? 0)} 元 = ${centsToYuan(grossCents)} 元`,
    );
    if (conversions === 0) warnings.push('CPA 模式转化数为 0，本次结算金额为 0，请确认数据是否已同步');
  } else if (mode === 'HYBRID' && grossCents < rule.fixedFeeCents) {
    // 保底补差：gross 不足保底时补到保底，差额单独说明
    const supplement = rule.fixedFeeCents - grossCents;
    trace.push(
      `保底+分成模式：实际流水 ${centsToYuan(grossCents)} 元低于保底 ${centsToYuan(rule.fixedFeeCents)} 元，补足差额 ${centsToYuan(supplement)} 元`,
    );
    grossCents = rule.fixedFeeCents;
    fixedFeeApplied = true;
  }

  // ---- 2. 解析生效比率（阶梯可覆盖达人分成） ----
  //
  // 注意顺序：先判定阶梯命中，再判定是否需要封顶，**最后才写 trace**。
  // 早期实现是先 push「调整为 80%」的 trace，再做封顶把比例压回 70%，
  // 结果 calculationTrace 里会留下「达人分成由 70% 调整为 80%」，
  // 而实际用的是 70% —— 这份 trace 是给财务与达人复算用的，
  // 记录一个未曾生效的比例比不记录更糟（是误导，不是缺信息）。
  let talentShareBp = rule.talentShareBp;
  const tieredBp = findTieredShareBp(grossCents, rule.tieredShares);
  const tierMatched = tieredBp !== null && tieredBp !== talentShareBp && mode !== 'FIXED_FEE';
  const requestedBp = tierMatched ? (tieredBp as number) : talentShareBp;

  // 阶梯可能使「公司+达人」超过净额，此时按净额封顶，避免算出负数分成
  const cappedBp = rule.agencyShareBp + requestedBp > 10_000
    ? 10_000 - rule.agencyShareBp
    : requestedBp;
  const wasCapped = cappedBp !== requestedBp;

  if (tierMatched) {
    trace.push(
      wasCapped
        ? `命中阶梯分成：流水 ${centsToYuan(grossCents)} 元落在配置区间，达人分成档位为 ${requestedBp / 100}%；但公司分成 ${rule.agencyShareBp / 100}% 与其之和超过 100%，已按净额封顶为 ${cappedBp / 100}%`
        : `命中阶梯分成：流水 ${centsToYuan(grossCents)} 元落在配置区间，达人分成由 ${rule.talentShareBp / 100}% 调整为 ${cappedBp / 100}%`,
    );
  }
  if (wasCapped) {
    warnings.push(
      `阶梯分成与公司分成之和超过 100%（${(rule.agencyShareBp + requestedBp) / 100}%），已按净额封顶为 ${cappedBp / 100}%，请复核合同条款`,
    );
  }
  talentShareBp = cappedBp;

  // ---- 3. 逐级计算 ----
  // 一口价模式下不扣平台费（品牌直接付费给公司，平台不参与分成）
  const platformFeeCents =
    mode === 'FIXED_FEE' ? 0 : applyBp(grossCents, rule.platformFeeBp, 'down');
  const netCents = grossCents - platformFeeCents;
  const talentGrossCents = applyBp(netCents, talentShareBp, 'up');
  const agencyShareCents = netCents - talentGrossCents;
  const taxWithheldCents = applyBp(talentGrossCents, rule.taxWithholdBp, 'nearest');
  const netPayableCents = talentGrossCents - taxWithheldCents;

  trace.push(
    `总流水 ${centsToYuan(grossCents)} 元 → 平台抽成 ${rule.platformFeeBp / 100}%（${centsToYuan(platformFeeCents)} 元）→ 可分配净额 ${centsToYuan(netCents)} 元`,
  );
  trace.push(
    `达人分成 ${talentShareBp / 100}% = ${centsToYuan(talentGrossCents)} 元；公司分成 ${(10_000 - talentShareBp) / 100}%（含尾差归集）= ${centsToYuan(agencyShareCents)} 元`,
  );
  trace.push(
    `代扣税 ${rule.taxWithholdBp / 100}% = ${centsToYuan(taxWithheldCents)} 元 → 应打款 ${centsToYuan(netPayableCents)} 元`,
  );

  // ---- 4. 自洽性断言：任何一笔都必须守恒，否则是代码缺陷而非业务问题 ----
  const reconstructed = platformFeeCents + agencyShareCents + talentGrossCents;
  if (reconstructed !== grossCents) {
    throw new Error(
      `结算金额不守恒：平台费 ${platformFeeCents} + 公司 ${agencyShareCents} + 达人 ${talentGrossCents} ≠ 流水 ${grossCents}`,
    );
  }
  if (netPayableCents < 0) {
    throw new Error('计算得出的应打款金额为负数，请检查税率与分成配置');
  }
  if (mode === 'HYBRID' && fixedFeeApplied) {
    trace.push('注意：本次结算使用了保底补差，保底部分不参与阶梯分成计算');
  }
  if (netPayableCents === 0 && grossCents > 0) {
    warnings.push('应打款金额为 0 但存在流水，通常是代扣税率为 100% 或分成为 0，请复核合同');
  }

  return {
    grossCents,
    platformFeeCents,
    agencyShareCents,
    talentGrossCents,
    taxWithheldCents,
    netPayableCents,
    effective: {
      platformFeeBp: rule.platformFeeBp,
      agencyShareBp: 10_000 - talentShareBp,
      talentShareBp,
      taxWithholdBp: rule.taxWithholdBp,
    },
    trace,
    warnings,
  };
}

/** 汇总多笔明细 → 结算单头部金额 */
export function sumBreakdowns(items: readonly SettlementBreakdown[]): {
  grossCents: number;
  platformFeeCents: number;
  agencyShareCents: number;
  talentGrossCents: number;
  taxWithheldCents: number;
  netPayableCents: number;
} {
  return items.reduce(
    (acc, item) => ({
      grossCents: acc.grossCents + item.grossCents,
      platformFeeCents: acc.platformFeeCents + item.platformFeeCents,
      agencyShareCents: acc.agencyShareCents + item.agencyShareCents,
      talentGrossCents: acc.talentGrossCents + item.talentGrossCents,
      taxWithheldCents: acc.taxWithheldCents + item.taxWithheldCents,
      netPayableCents: acc.netPayableCents + item.netPayableCents,
    }),
    {
      grossCents: 0,
      platformFeeCents: 0,
      agencyShareCents: 0,
      talentGrossCents: 0,
      taxWithheldCents: 0,
      netPayableCents: 0,
    },
  );
}

/**
 * 账期解析：把 "2026-01" 或任意日期解析为 [月初 00:00, 月末 23:59:59.999]。
 * 账期固定按自然月，避免「跨月归属」争议——达人分成以内容发布月为准。
 */
export function resolvePeriod(input: { month?: string; periodStart?: Date; periodEnd?: Date }): {
  start: Date;
  end: Date;
  label: string;
} {
  if (input.periodStart && input.periodEnd) {
    if (input.periodEnd < input.periodStart) {
      throw new Error('账期结束时间不能早于开始时间');
    }
    return {
      start: input.periodStart,
      end: input.periodEnd,
      label: `${formatDate(input.periodStart)} ~ ${formatDate(input.periodEnd)}`,
    };
  }
  if (!input.month || !/^\d{4}-\d{2}$/.test(input.month)) {
    throw new Error('请提供 month（格式 YYYY-MM）或 periodStart/periodEnd');
  }
  const [year, month] = input.month.split('-').map((value) => Number.parseInt(value, 10));
  if (month < 1 || month > 12) throw new Error(`月份非法：${input.month}`);
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
  return { start, end, label: `${input.month}` };
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
