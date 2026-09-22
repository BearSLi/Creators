/**
 * Prisma groupBy / aggregate 结果的安全读取工具。
 *
 * 为什么需要它：
 *   Prisma 在 `by` 为**动态字段数组**时无法完全推断 `groupBy` 的返回类型，
 *   `_count` 的静态类型会退化为 `true | { id?: number; ... _all?: number } | undefined`。
 *   于是 `row._count` 既可能是 boolean，也可能是对象，直接参与算术运算会产生
 *   一连串 TS18048（possibly undefined）与 TS2362/TS2363（算术类型不合法）。
 *
 *   临时用 `as any` 掩盖不是好办法——它会连带丢掉其他字段的类型。
 *   这里把「从各种可能的形状里取出一个确定的数字」收敛到一个函数里，
 *   调用点保持类型安全，且运行时行为明确（取不到就是 0）。
 *
 * 同时它也让代码读起来更清楚：`extractCount(row)` 比
 * `row._count ?? 0` 更能表达「这里要的是分组计数」。
 */

/** 从 groupBy/aggregate 结果中取出分组计数（`_count: { _all: true }` 的产物） */
export function extractCount(row: unknown): number {
  if (!row || typeof row !== 'object') return 0;
  const count = (row as { _count?: unknown })._count;

  // 形态一：_count 直接是数字（某些 Prisma 版本在 by 为字面量时会收窄成 number）
  if (typeof count === 'number') return count;

  // 形态二：_count 是聚合对象，优先取 _all
  if (count && typeof count === 'object') {
    const all = (count as { _all?: unknown })._all;
    if (typeof all === 'number') return all;

    // 未显式请求 _all 时，退化为「把各字段计数求和」没有意义（会重复计数），
    // 因此只取第一个数字字段作为兜底，并在字段名为 _all 缺失时返回 0。
    const numeric = Object.values(count as Record<string, unknown>).find(
      (value) => typeof value === 'number',
    );
    return typeof numeric === 'number' ? numeric : 0;
  }

  // 形态三：_count 为 true / undefined（类型退化导致），无法得知真实计数
  return 0;
}

/**
 * 从 groupBy 的聚合结果中安全取出 `_sum` 字段值。
 * 用于规避 `row._sum` 可能为 undefined 的类型告警，同时保持调用点整洁。
 */
export function extractSum<T extends Record<string, unknown>>(
  row: unknown,
  field: keyof T & string,
): number | null {
  if (!row || typeof row !== 'object') return null;
  const sum = (row as { _sum?: unknown })._sum;
  if (!sum || typeof sum !== 'object') return null;
  const value = (sum as Record<string, unknown>)[field];
  return typeof value === 'number' ? value : null;
}
