/**
 * 金额与比率的精确计算工具。
 *
 * 背景：达人结算涉及「平台抽成 → 机构分成 → 达人分成 → 代扣税」多级链路，
 * 每级都有四舍五入。若用浮点数，几万条明细累计后会出现元级误差，
 * 财务对账时无法解释。因此：
 *   1) 全程用「分」为单位的整数（bigint 语义）与基点(bp)整数运算；
 *   2) 每个环节显式指定舍入方向，且舍入方向可解释（见 roundHalfUp 注释）；
 *   3) 结算单保存计算链路快照，任何一笔都能复算复现。
 */

/** 元 → 分（四舍五入到分） */
export function yuanToCents(yuan: number | string): number {
  const value = typeof yuan === 'string' ? Number.parseFloat(yuan) : yuan;
  if (!Number.isFinite(value)) throw new Error(`非法金额：${yuan}`);
  return Math.round(value * 100);
}

/** 分 → 元（保留 2 位小数的数字） */
export function centsToYuan(cents: number): number {
  return roundTo2(cents / 100);
}

/** 保留 2 位小数，避免 0.1+0.2 类浮点噪声 */
export function roundTo2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * 按基点比例计算金额（分）。
 *
 * 舍入策略：对「平台费/机构分成」向下取整，对「达人所得」向上取整。
 * 原因：多级链路中若全部四舍五入，尾差可能让达人少拿几分钱——
 * 这在合作方对账时是信任问题。宁可公司少收一分，也不让达人少拿。
 */
export function applyBp(
  amountCents: number,
  bp: number,
  direction: 'down' | 'up' | 'nearest' = 'nearest',
): number {
  if (!Number.isFinite(amountCents) || !Number.isFinite(bp)) {
    throw new Error(`非法参数：amountCents=${amountCents} bp=${bp}`);
  }
  const raw = (amountCents * bp) / 10_000;
  switch (direction) {
    case 'down':
      return Math.floor(raw);
    case 'up':
      return Math.ceil(raw);
    default:
      return Math.round(raw);
  }
}

/** 校验基点区间是否合法（0-10000，且总量守恒） */
export function assertBpRange(bp: number, name: string): void {
  if (!Number.isInteger(bp) || bp < 0 || bp > 10_000) {
    throw new Error(`${name} 必须是 0-10000 的整数基点，当前为 ${bp}`);
  }
}

/**
 * 阶梯分成查找：命中区间返回对应达人分成率，未命中返回 null。
 * 区间语义为左闭右开 [from, to)，to 为 null 表示无上限。
 */
export interface TieredShareRule {
  from: number;
  to: number | null;
  talentShareBp: number;
}

export function findTieredShareBp(
  amountCents: number,
  tiers: readonly TieredShareRule[] | null | undefined,
): number | null {
  if (!tiers || tiers.length === 0) return null;
  for (const tier of tiers) {
    const upperOk = tier.to === null || amountCents < tier.to;
    if (amountCents >= tier.from && upperOk) return tier.talentShareBp;
  }
  return null;
}

/** 解析 Prisma Decimal / string / number 为分，统一入口 */
export function decimalToCents(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Math.round(value * 100);
  if (typeof value === 'string') return yuanToCents(value);
  // Prisma.Decimal 实现了 toString
  if (typeof (value as { toString?: () => string }).toString === 'function') {
    return yuanToCents((value as { toString: () => string }).toString());
  }
  throw new Error(`无法转换为金额：${String(value)}`);
}

/** 分 → 元字符串（用于写回 Decimal 字段，保持 2 位小数） */
export function centsToDecimalString(cents: number): string {
  return (cents / 100).toFixed(2);
}
