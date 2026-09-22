import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * 把查询参数归一化为数组。
 *
 * 为什么需要它：HTTP 查询串里没有「数组」这个概念。前端既可能发
 *   ?status=CONTACTING          （单个值）
 * 也可能发
 *   ?status=CONTACTING&status=SIGNED （重复键）
 * 。而 class-transformer **不会**自动把单个值包装成数组，于是 DTO 上声明的
 * `status?: CreatorStatus[]` 实际会拿到字符串，一路传到 Prisma 的 `in` 就报
 *   Argument `in`: Invalid value provided. Expected CreatorStatus[], provided String.
 * 表现为「筛选某个状态就报参数错误」——而且只在传单个值时出现，很容易漏测。
 *
 * 三个细节：
 *   1) `undefined` / `null` / 空字符串保持 undefined，不能变成 `[undefined]`，
 *      否则 Prisma 会把「不筛选」变成「筛空数组」；
 *   2) 已经是数组时原样返回（重复键的情形由 Express 解析为数组）；
 *   3) 保持启用 implicit conversion：`@Type(() => Number)` 之类的转换仍按字段声明执行。
 */
export const ToArray = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) => {
    if (value === undefined || value === null || value === '') return undefined;
    if (Array.isArray(value)) return value;
    return [value];
  });

/** 允许排序的字段白名单由各 Service 传入，避免把任意字段名拼进 ORDER BY（SQL 注入面） */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page 必须为整数' })
  @Min(1, { message: 'page 最小为 1' })
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'pageSize 必须为整数' })
  @Min(1)
  @Max(MAX_PAGE_SIZE, { message: `pageSize 最大为 ${MAX_PAGE_SIZE}` })
  pageSize: number = DEFAULT_PAGE_SIZE;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  sortBy?: string;

  @IsOptional()
  @IsIn(['asc', 'desc'], { message: 'sortOrder 只能是 asc 或 desc' })
  sortOrder: 'asc' | 'desc' = 'desc';

  /** 计算 Prisma 的 skip，独立成方法便于单测 */
  get skip(): number {
    return (this.page - 1) * this.pageSize;
  }

  get take(): number {
    return this.pageSize;
  }
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasNext: boolean;
}

/** 统一分页响应结构，前端表格组件直接消费 */
export function buildPaginated<T>(
  items: T[],
  total: number,
  page: number,
  pageSize: number,
): PaginatedResult<T> {
  const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 0;
  return {
    items,
    total,
    page,
    pageSize,
    totalPages,
    hasNext: page < totalPages,
  };
}

/**
 * 排序参数解析。只有在白名单内的字段才允许排序，其余回落到默认字段。
 * 这是防 SQL 注入的关键一环：Prisma 的 orderBy 虽参数化，但字段名无法参数化。
 */
export function resolveOrderBy<TField extends string>(
  sortBy: string | undefined,
  sortOrder: 'asc' | 'desc',
  allowed: readonly TField[],
  fallback: TField,
): Record<string, 'asc' | 'desc'> {
  const field = sortBy && allowed.includes(sortBy as TField) ? (sortBy as TField) : fallback;
  return { [field]: sortOrder };
}
