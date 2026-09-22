import { describe, expect, it } from 'vitest';
import {
  calculateSettlement,
  resolvePeriod,
  SettlementRule,
  sumBreakdowns,
  validateRule,
} from './settlement.calculator';
import { applyBp, centsToYuan, decimalToCents, findTieredShareBp, yuanToCents } from '../../common/utils/money';

/**
 * 结算引擎单元测试。
 *
 * 这是全项目最重要的测试文件：结算引擎直接决定「打给达人多少钱」，
 * 一旦算错，损害的是真金白银与合作方信任。因此覆盖策略是：
 *   1) 典型场景（流水分成 / 一口价 / 保底 / CPA）;
 *   2) 边界（零流水、极小金额的舍入、分成 0%/100%、税率 0%）;
 *   3) 不变量（金额守恒、应付非负）——用属性式断言穷举多组参数;
 *   4) 非法配置必须拒绝（分成之和超 100%、阶梯区间倒置、负数流水）。
 */

/** 测试用基础规则：平台 10% → 公司 30% / 达人 70% → 代扣 6% */
const baseRule: SettlementRule = {
  settlementMode: 'REVENUE_SHARE',
  fixedFeeCents: 0,
  platformFeeBp: 1000,
  agencyShareBp: 3000,
  talentShareBp: 7000,
  taxWithholdBp: 600,
};

describe('金额工具 (money.ts)', () => {
  it('元与分互转不丢精度', () => {
    expect(yuanToCents(0.1)).toBe(10);
    expect(yuanToCents('123.45')).toBe(12_345);
    expect(yuanToCents(99.995)).toBe(10_000); // 四舍五入到分
    expect(centsToYuan(12_345)).toBe(123.45);
    expect(centsToYuan(1)).toBe(0.01);
  });

  it('处理 Prisma Decimal 风格的字符串与对象', () => {
    expect(decimalToCents('100.00')).toBe(10_000);
    expect(decimalToCents(50.5)).toBe(5050);
    expect(decimalToCents(null)).toBe(0);
    expect(decimalToCents({ toString: () => '77.77' })).toBe(7777);
  });

  it('按基点计算：向下/向上/就近舍入行为明确', () => {
    // 333 分的 10% = 33.3，不同舍入方向结果不同——这正是必须显式指定方向的原因
    expect(applyBp(333, 1000, 'down')).toBe(33);
    expect(applyBp(333, 1000, 'up')).toBe(34);
    expect(applyBp(333, 1000, 'nearest')).toBe(33);
    expect(applyBp(335, 1000, 'nearest')).toBe(34);
  });

  it('阶梯分成命中左闭右开区间', () => {
    const tiers = [
      { from: 0, to: 100_000, talentShareBp: 6000 },
      { from: 100_000, to: null, talentShareBp: 7500 },
    ];
    expect(findTieredShareBp(0, tiers)).toBe(6000);
    expect(findTieredShareBp(99_999, tiers)).toBe(6000);
    expect(findTieredShareBp(100_000, tiers)).toBe(7500); // 边界归入下一档
    expect(findTieredShareBp(999_999_999, tiers)).toBe(7500);
    expect(findTieredShareBp(1000, null)).toBeNull();
  });
});

describe('规则校验 (validateRule)', () => {
  it('接受合法规则', () => {
    expect(() => validateRule(baseRule)).not.toThrow();
  });

  it('拒绝公司与达人分成之和超过 100%', () => {
    expect(() =>
      validateRule({ ...baseRule, agencyShareBp: 4000, talentShareBp: 7000 }),
    ).toThrowError(/不自洽/);
  });

  it('拒绝越界基点', () => {
    expect(() => validateRule({ ...baseRule, platformFeeBp: 10_001 })).toThrowError(/基点/);
    expect(() => validateRule({ ...baseRule, taxWithholdBp: -1 })).toThrowError(/基点/);
  });

  it('拒绝阶梯区间上界小于下界', () => {
    expect(() =>
      validateRule({
        ...baseRule,
        tieredShares: [{ from: 100_000, to: 50_000, talentShareBp: 8000 }],
      }),
    ).toThrowError(/阶梯区间非法/);
  });

  it('CPA 模式必须有正单价', () => {
    expect(() =>
      validateRule({ ...baseRule, settlementMode: 'CPA', cpaUnitPriceCents: 0 }),
    ).toThrowError(/单价/);
  });
});

describe('流水分成模式', () => {
  it('精确计算四级分成并保证金额守恒', () => {
    // 10000 元流水
    const result = calculateSettlement({ rule: baseRule, grossCents: 1_000_000, description: 't' });

    expect(result.grossCents).toBe(1_000_000);
    expect(result.platformFeeCents).toBe(100_000); // 10%
    expect(result.talentGrossCents).toBe(630_000); // (1000000-100000)*70%
    expect(result.agencyShareCents).toBe(270_000); // 净额 - 达人分成
    expect(result.taxWithheldCents).toBe(37_800); // 630000*6%
    expect(result.netPayableCents).toBe(592_200);

    // 不变量：平台费 + 公司 + 达人 = 总流水（分文不差）
    expect(
      result.platformFeeCents + result.agencyShareCents + result.talentGrossCents,
    ).toBe(result.grossCents);
    // 不变量：达人分成 - 代扣税 = 应打款
    expect(result.talentGrossCents - result.taxWithheldCents).toBe(result.netPayableCents);
  });

  it('尾差归集给公司，达人分成向上取整（宁多不少）', () => {
    // 333 分流水：平台费 33（下）/ 净额 300 / 达人 210 / 公司 90
    const result = calculateSettlement({ rule: baseRule, grossCents: 333, description: 't' });
    expect(result.platformFeeCents).toBe(33);
    expect(result.talentGrossCents).toBe(210);
    expect(result.agencyShareCents).toBe(90);
    expect(
      result.platformFeeCents + result.agencyShareCents + result.talentGrossCents,
    ).toBe(333);
  });

  it('零流水不产生任何应付金额', () => {
    const result = calculateSettlement({ rule: baseRule, grossCents: 0, description: 't' });
    expect(result.netPayableCents).toBe(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('税率为 0 时应付等于达人分成', () => {
    const result = calculateSettlement({
      rule: { ...baseRule, taxWithholdBp: 0 },
      grossCents: 1_000_000,
      description: 't',
    });
    expect(result.taxWithheldCents).toBe(0);
    expect(result.netPayableCents).toBe(result.talentGrossCents);
  });

  it('平台费 0 且达人 100% 时，公司不拿钱', () => {
    const result = calculateSettlement({
      rule: { ...baseRule, platformFeeBp: 0, agencyShareBp: 0, talentShareBp: 10_000, taxWithholdBp: 0 },
      grossCents: 12_345,
      description: 't',
    });
    expect(result.platformFeeCents).toBe(0);
    expect(result.agencyShareCents).toBe(0);
    expect(result.netPayableCents).toBe(12_345);
  });

  it('达人分成为 0 时提示人工确认', () => {
    const result = calculateSettlement({
      rule: { ...baseRule, agencyShareBp: 10_000, talentShareBp: 0 },
      grossCents: 1_000_000,
      description: 't',
    });
    expect(result.netPayableCents).toBe(0);
    expect(result.warnings.join()).toMatch(/应打款金额为 0/);
  });

  it('拒绝负数流水（扣减必须走调整项）', () => {
    expect(() =>
      calculateSettlement({ rule: baseRule, grossCents: -1, description: 't' }),
    ).toThrowError(/不能为负数/);
  });
});

describe('阶梯分成', () => {
  const tieredRule: SettlementRule = {
    ...baseRule,
    tieredShares: [
      { from: 0, to: 500_000, talentShareBp: 7000 },
      { from: 500_000, to: null, talentShareBp: 8000 },
    ],
  };

  it('未达阈值使用合同基础比例', () => {
    const result = calculateSettlement({ rule: tieredRule, grossCents: 400_000, description: 't' });
    expect(result.effective.talentShareBp).toBe(7000);
    expect(result.trace.join()).toMatch(/命中阶梯|总流水/);
  });

  it('达到阈值后提高达人分成（公司分成 15%，给阶梯留出空间）', () => {
    // 注意：这里必须把公司分成调到 15%。
    // 原测试沿用 baseRule 的 agencyShareBp: 3000，与第二档 8000 相加为 110% > 100%，
    // 会被封顶压回 70% —— 那是「封顶逻辑」的用例，不是「阶梯生效」的用例。
    // 一个测试同时期望两件互相冲突的事，是我最初写错的地方。
    const result = calculateSettlement({
      rule: { ...tieredRule, agencyShareBp: 1500 },
      grossCents: 1_000_000,
      description: 't',
    });
    expect(result.effective.talentShareBp).toBe(8000);
    expect(result.trace.join()).toMatch(/命中阶梯分成/);
    // 公司分成率随之为 20%
    expect(result.effective.agencyShareBp).toBe(2000);
    expect(result.trace.join()).toMatch(/公司分成/);
  });

  it('阶梯与公司分成之和超 100% 时封顶并告警', () => {
    const result = calculateSettlement({
      rule: { ...baseRule, agencyShareBp: 3000, tieredShares: [{ from: 0, to: null, talentShareBp: 9000 }] },
      grossCents: 1_000_000,
      description: 't',
    });
    expect(result.effective.talentShareBp).toBe(7000); // 被压回 10000-3000
    expect(result.warnings.join()).toMatch(/超过 100%/);
  });

  it('被封顶时 trace 必须记录「实际生效」的比例，不能记录未生效的档位', () => {
    // 这一条锁定的是一个真实缺陷：早期实现先写「达人分成由 70% 调整为 90%」的 trace，
    // 再把比例封顶压回 70%，导致 calculationTrace 里留下一个从未生效的比例。
    // 这份 trace 是财务与达人复算的依据，记录假信息比不记录更糟。
    const result = calculateSettlement({
      rule: { ...baseRule, agencyShareBp: 3000, tieredShares: [{ from: 0, to: null, talentShareBp: 9000 }] },
      grossCents: 1_000_000,
      description: 't',
    });

    const traceText = result.trace.join('\n');
    // 必须明确说明档位是 90%、但因超 100% 被封顶为 70%
    expect(traceText).toMatch(/档位为 90%/);
    expect(traceText).toMatch(/封顶为 70%/);
    // 不允许出现「调整为 90%」这种「已生效」的措辞
    expect(traceText).not.toMatch(/调整为 90%/);
    expect(result.effective.talentShareBp).toBe(7000);
  });
});

describe('一口价模式', () => {
  const fixedRule: SettlementRule = {
    ...baseRule,
    settlementMode: 'FIXED_FEE',
    fixedFeeCents: 1_800_000, // 18000 元
    platformFeeBp: 1000, // 一口价不扣平台费，即便合同填了也忽略
  };

  it('按合同金额结算且不扣平台费', () => {
    const result = calculateSettlement({ rule: fixedRule, grossCents: 0, description: 't' });
    expect(result.grossCents).toBe(1_800_000);
    expect(result.platformFeeCents).toBe(0);
    expect(result.talentGrossCents).toBe(1_260_000); // 18000*70%
    expect(result.agencyShareCents).toBe(540_000);
    expect(result.trace.join()).toMatch(/一口价模式/);
  });

  it('忽略阶梯规则（一口价不参与阶梯）', () => {
    const result = calculateSettlement({
      rule: { ...fixedRule, tieredShares: [{ from: 0, to: null, talentShareBp: 9000 }] },
      grossCents: 0,
      description: 't',
    });
    expect(result.effective.talentShareBp).toBe(7000);
  });
});

describe('保底 + 分成模式', () => {
  const hybridRule: SettlementRule = {
    ...baseRule,
    settlementMode: 'HYBRID',
    fixedFeeCents: 500_000, // 保底 5000 元
  };

  it('流水低于保底时补足到保底并说明差额', () => {
    const result = calculateSettlement({ rule: hybridRule, grossCents: 200_000, description: 't' });
    expect(result.grossCents).toBe(500_000);
    expect(result.trace.join()).toMatch(/补足差额/);
    expect(result.trace.join()).toMatch(/保底补差/);
  });

  it('流水高于保底时按实际流水计算', () => {
    const result = calculateSettlement({ rule: hybridRule, grossCents: 900_000, description: 't' });
    expect(result.grossCents).toBe(900_000);
    expect(result.trace.join()).not.toMatch(/补足差额/);
  });

  it('流水恰好等于保底时不触发补差', () => {
    const result = calculateSettlement({ rule: hybridRule, grossCents: 500_000, description: 't' });
    expect(result.grossCents).toBe(500_000);
    expect(result.trace.join()).not.toMatch(/补足差额/);
  });
});

describe('CPA 模式', () => {
  const cpaRule: SettlementRule = {
    ...baseRule,
    settlementMode: 'CPA',
    cpaUnitPriceCents: 250, // 2.5 元/次
  };

  it('按转化数 × 单价计算流水', () => {
    const result = calculateSettlement({ rule: cpaRule, grossCents: 0, conversions: 400, description: 't' });
    expect(result.grossCents).toBe(100_000); // 400 * 250
    expect(result.trace.join()).toMatch(/CPA 模式/);
  });

  it('转化数为 0 时给出告警', () => {
    const result = calculateSettlement({ rule: cpaRule, grossCents: 0, conversions: 0, description: 't' });
    expect(result.grossCents).toBe(0);
    expect(result.warnings.join()).toMatch(/转化数为 0/);
  });
});

describe('金额守恒不变量（多参数穷举）', () => {
  it('任意合法规则与流水下，平台费+公司+达人恒等于流水，且应付非负', () => {
    const grossSamples = [0, 1, 7, 333, 12_345, 99_999, 1_000_000, 123_456_789];
    const shareSamples = [0, 1000, 3000, 5000, 7000, 9999, 10_000];
    const taxSamples = [0, 600, 2000, 4500];
    let checked = 0;

    for (const gross of grossSamples) {
      for (const talentShareBp of shareSamples) {
        // 公司分成取「剩下的部分」，保证规则本身自洽（这正是业务上的常见配法）
        for (const agencyShareBp of [0, Math.max(0, 10_000 - talentShareBp)]) {
          for (const taxWithholdBp of taxSamples) {
            const rule: SettlementRule = {
              settlementMode: 'REVENUE_SHARE',
              fixedFeeCents: 0,
              platformFeeBp: 1000,
              agencyShareBp,
              talentShareBp,
              taxWithholdBp,
            };
            const result = calculateSettlement({ rule, grossCents: gross, description: 'fuzz' });
            expect(
              result.platformFeeCents + result.agencyShareCents + result.talentGrossCents,
              `gross=${gross} talentBp=${talentShareBp} agencyBp=${agencyShareBp}`,
            ).toBe(result.grossCents);
            expect(result.netPayableCents).toBeGreaterThanOrEqual(0);
            expect(result.agencyShareCents).toBeGreaterThanOrEqual(0);
            expect(result.talentGrossCents).toBeGreaterThanOrEqual(0);
            checked += 1;
          }
        }
      }
    }
    // 确保穷举确实跑了足够多的组合，避免「循环写错导致空跑」的假绿
    expect(checked).toBeGreaterThan(300);
  });
});

describe('汇总 (sumBreakdowns)', () => {
  it('多笔明细逐项累加', () => {
    const a = calculateSettlement({ rule: baseRule, grossCents: 1_000_000, description: 'a' });
    const b = calculateSettlement({ rule: baseRule, grossCents: 500_000, description: 'b' });
    const total = sumBreakdowns([a, b]);

    expect(total.grossCents).toBe(1_500_000);
    expect(total.netPayableCents).toBe(a.netPayableCents + b.netPayableCents);
    expect(
      total.platformFeeCents + total.agencyShareCents + total.talentGrossCents,
    ).toBe(total.grossCents);
  });

  it('空数组返回全零', () => {
    expect(sumBreakdowns([])).toEqual({
      grossCents: 0,
      platformFeeCents: 0,
      agencyShareCents: 0,
      talentGrossCents: 0,
      taxWithheldCents: 0,
      netPayableCents: 0,
    });
  });
});

describe('账期解析 (resolvePeriod)', () => {
  it('按自然月解析出月初与月末（UTC）', () => {
    const period = resolvePeriod({ month: '2026-02' });
    expect(period.start.toISOString()).toBe('2026-02-01T00:00:00.000Z');
    expect(period.end.toISOString()).toBe('2026-02-28T23:59:59.999Z'); // 2026 非闰年
    expect(period.label).toBe('2026-02');
  });

  it('闰年 2 月为 29 天', () => {
    const period = resolvePeriod({ month: '2028-02' });
    expect(period.end.toISOString().slice(0, 10)).toBe('2028-02-29');
  });

  it('12 月账期正确跨年', () => {
    const period = resolvePeriod({ month: '2026-12' });
    expect(period.end.toISOString().slice(0, 10)).toBe('2026-12-31');
  });

  it('支持自定义区间', () => {
    const period = resolvePeriod({
      periodStart: new Date('2026-01-05T00:00:00Z'),
      periodEnd: new Date('2026-01-20T00:00:00Z'),
    });
    expect(period.label).toBe('2026-01-05 ~ 2026-01-20');
  });

  it('拒绝非法月份与倒置区间', () => {
    expect(() => resolvePeriod({ month: '2026-13' })).toThrowError(/月份非法/);
    expect(() => resolvePeriod({ month: 'abc' })).toThrowError(/month/);
    expect(() =>
      resolvePeriod({
        periodStart: new Date('2026-02-01T00:00:00Z'),
        periodEnd: new Date('2026-01-01T00:00:00Z'),
      }),
    ).toThrowError(/不能早于/);
  });
});
