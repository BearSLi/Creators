import type { ValidationError } from '@nestjs/common';

/**
 * 把 class-validator 的 `ValidationError[]` 摊平成「可直接用于表单标红」的结构。
 *
 * ## 为什么需要它（真实故障复盘）
 *
 * 后端校验失败时原本只返回一个扁平的 `message: string[]`：
 *
 * ```json
 * {
 *   "code": "VALIDATION_FAILED",
 *   "message": "status must be one of the following values: …；projectId must be a UUID",
 *   "details": ["status must be one of the following values: …", "projectId must be a UUID"]
 * }
 * ```
 *
 * 字段名只以**自然语言**的形式混在句子里，调用方想标红某个输入框就得去解析英文句子——
 * 既不可靠（自定义 message 里根本没有字段名，如「预算格式不正确」），也不该由前端承担。
 *
 * 而前端的实际行为是：全局 `MutationCache.onError` 弹出
 * 「提交的内容未通过校验，请检查标红字段后重试」，**却从不消费 details**。
 * 结果用户看到「请检查标红字段」，界面上一个红字段都没有——
 * 这句提示在骗人，而且让一个原本 5 秒能解决的问题变成无法自助排查的故障。
 *
 * 所以在错误响应里**追加**一个结构化的 `fieldErrors`（与既有 `details` 并存，
 * 不破坏任何现有调用方）：
 *
 * ```json
 * {
 *   "code": "VALIDATION_FAILED",
 *   "details": ["status must be one of …", "projectId must be a UUID"],
 *   "fieldErrors": {
 *     "status": ["status must be one of the following values: …"],
 *     "projectId": ["projectId must be a UUID"]
 *   }
 * }
 * ```
 *
 * 键名就是 **DTO 属性名**，因此前端可以把 DTO 字段名直接当作表单字段名使用
 * （本项目各表单的 `errors` 状态键名本来就与 DTO 一致）。
 */

export interface FlattenedValidationErrors {
  /** 扁平消息数组，保持与既有 `details` 完全一致（向后兼容） */
  messages: string[];
  /** 字段名 → 该字段的错误消息，供前端表单标红 */
  fieldErrors: Record<string, string[]>;
}

/**
 * 递归摊平校验错误。
 *
 * 嵌套 DTO（如 `accounts: PlatformAccountDto[]`）的路径用点号拼接，数组带下标，
 * 例如 `accounts.0.platform`。之所以带下标而不是把整个数组归到一个键：
 * 表单里每一行都能定位（CreatorFormPage 的平台账号就是动态行）。
 *
 * 同时保留 `messages`：即使某个消息解析不出字段名，用户至少能看到原因原文，
 * 不会再出现「提示去看红字段、但没有任何红字段」的情况。
 */
export function flattenValidationErrors(
  errors: readonly ValidationError[],
  parentPath = '',
): FlattenedValidationErrors {
  const messages: string[] = [];
  const fieldErrors: Record<string, string[]> = {};

  const visit = (error: ValidationError, path: string): void => {
    const fieldPath = path ? `${path}.${error.property}` : error.property;

    // `whitelist + forbidNonWhitelisted` 产生的错误挂在目标对象自身（property 为 name/undefined），
    // 其 constraints 里是 “property xxx should not exist”。这类错误没有可标红的字段，
    // 只进 messages 让人能看到「多传了哪个字段」，不写进 fieldErrors 以免污染表单。
    const constraintMessages = error.constraints ? Object.values(error.constraints) : [];
    for (const message of constraintMessages) {
      messages.push(message);
      // 只有当这条消息确实来自该字段自身的校验器时才归到该字段
      const isUndeclaredField = /should not exist/i.test(message);
      if (!isUndeclaredField) {
        const bucket = fieldErrors[fieldPath] ?? [];
        bucket.push(message);
        fieldErrors[fieldPath] = bucket;
      }
    }

    for (const child of error.children ?? []) {
      // 子 DTO 若是数组，property 会是下标字符串；嵌套层级 >6 说明结构异常，停止递归
      if (path.split('.').length > 6) continue;
      visit(child, fieldPath);
    }
  };

  for (const error of errors) visit(error, parentPath);

  return { messages, fieldErrors };
}
