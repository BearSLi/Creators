import { ArgumentMetadata, Injectable, ValidationPipe, ValidationPipeOptions } from '@nestjs/common';

/**
 * 在全局校验前把「空字符串」规范化为 undefined 的 ValidationPipe。
 *
 * ## 为什么需要它
 *
 * class-validator 的 `@IsOptional()` **只在值为 `null` / `undefined` 时跳过校验**，
 * 空字符串会被照常校验。而 HTML 表单提交「用户没填的选填项」时给的就是 `""`：
 *
 * ```
 * POST /api/projects  { "name": "3 月短剧投放", "brandId": "", "budget": "", "startDate": "" }
 * → ❌ brandId must be a UUID
 *    ❌ 预算格式不正确，需为最多两位小数的金额字符串
 *    ❌ startDate 需为 ISO 8601 日期字符串
 * ```
 *
 * 用户只填了「项目名称」，却收到一串与名称无关的报错；前端只能笼统提示
 * 「请检查标红字段后重试」，用户根本无从下手。这在 B 端表单里是系统性问题——
 * 本项目 8 个模块的 DTO 都有可选字段（UUID 外键、日期、金额、枚举），
 * 逐个给字段加 `@Transform` 既啰嗦又必然漏掉新增字段。
 *
 * ## 语义选择
 *
 * 「字段为空」在表单语境下就应当等价于「不提供该字段」。因此这里把
 * `""` 与纯空白串（`"   "`，用户误敲空格）都转为 `undefined`，
 * 让 `@IsOptional()` 正常跳过，Prisma 也就能收到 `undefined` 从而忽略该条件。
 *
 * 注意**只处理字符串**：`false`、`0`、`[]` 都不受影响，否则会把
 * 「布尔字段设为 false」「数值字段设为 0」误判为未填写。
 *
 * ## 为什么不影响数组
 *
 * 数组里的空字符串元素也会被清理（例如 `["a", "", "b"]` → `["a", "b"]`），
 * 这样多选筛选里混入空值不会导致 `@IsEnum(..., { each: true })` 报错。
 * 若清理后数组为空，则整体转为 `undefined`（避免「筛空数组」把结果清空）。
 */
@Injectable()
export class EmptyStringToUndefinedPipe extends ValidationPipe {
  constructor(options: ValidationPipeOptions) {
    super(options);
  }

  override async transform(value: unknown, metadata: ArgumentMetadata): Promise<unknown> {
    return super.transform(this.stripEmptyStrings(value), metadata);
  }

  /** 递归清理空字符串；只处理 string 与数组/对象容器，其他类型原样返回 */
  private stripEmptyStrings(value: unknown, depth = 0): unknown {
    // 深度保护：DTO 嵌套有限，防止异常数据结构导致栈溢出
    if (depth > 8) return value;

    if (typeof value === 'string') {
      return value.trim() === '' ? undefined : value;
    }

    if (Array.isArray(value)) {
      const cleaned = value
        .map((item) => this.stripEmptyStrings(item, depth + 1))
        .filter((item) => item !== undefined);
      // 清空后的数组没有筛选意义，转为 undefined 以免被当成「筛空集」
      return cleaned.length > 0 ? cleaned : undefined;
    }

    if (value && typeof value === 'object') {
      // 只处理普通对象：跳过 Date / Buffer 等内置类型，避免破坏其行为
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return value;

      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        const cleaned = this.stripEmptyStrings(item, depth + 1);
        if (cleaned !== undefined) output[key] = cleaned;
      }
      return output;
    }

    return value;
  }
}
