import { ApiError } from '@/api/client';
import { humanizeValidationMessage } from '@/utils/validationMessages';

/**
 * 把后端返回的**字段级校验错误**合并进表单的错误状态，让输入框真的标红。
 *
 * ## 解决什么问题
 *
 * 后端校验失败时返回 `code: 'VALIDATION_FAILED'`，全局 `MutationCache.onError`
 * 会弹出一句「提交的内容未通过校验，请检查标红字段后重试」。
 * 但前端此前**从不消费**错误里的字段信息，于是：
 *
 *   1. 提示让用户去看红字段，界面上一个红字段都没有 —— 提示在骗人；
 *   2. 用户唯一能做的就是把表单每个字段乱改一遍再试。
 *
 * 这是 B 端表单里最伤人的一类体验问题：报错不可自助排查。
 *
 * ## 为什么可以按字段名直接合并
 *
 * 后端 `fieldErrors` 的键就是 **DTO 属性名**，而本项目各表单 `errors` 状态的键名
 * 本来就与 DTO 保持一致（例如 ContractFormPage 的 `creatorId` / `settlementMode` /
 * `fixedFee`）。所以不需要任何映射表，直接合并即可 —— 前提是后端给的是结构化字段名，
 * 而不是「settlementMode must be a UUID」这种需要正则去捞的英文句子。
 *
 * ## 返回值语义
 *
 * 返回被标记的字段名数组；空数组表示这条错误里没有可映射的字段
 * （例如「多传了未声明字段」这类与具体输入框无关的错误）——
 * 调用方据此决定是否再补一条通用提示。
 */
export function applyServerFieldErrors(
  error: unknown,
  setErrors: (updater: (previous: Record<string, string>) => Record<string, string>) => void,
): string[] {
  if (!(error instanceof ApiError)) return [];

  const entries = Object.entries(error.fieldErrors);
  if (entries.length === 0) return [];

  setErrors((previous) => {
    const next = { ...previous };
    for (const [field, messages] of entries) {
      // 同一字段可能有多条消息，全部拼上；只显示第一条会让用户改完又报下一个。
      // 走展示层翻译：错误就近显示在中文标签旁，露出英文句式会很突兀。
      next[field] = messages.map(humanizeValidationMessage).join('；');
    }
    return next;
  });

  return entries.map(([field]) => field);
}

/**
 * 表单提交失败时的统一处理：先尝试把错误落到具体字段上，落不下去再提示。
 *
 * 之所以要「落不下去再提示」而不是两个都做：如果字段已经标红并给出了就近原因，
 * 再弹一条同样的 toast 属于重复噪声。
 */
export function handleFormSubmitError(
  error: unknown,
  setErrors: (updater: (previous: Record<string, string>) => Record<string, string>) => void,
  toast: { error: (message: string) => void },
  resolveMessage: (error: unknown) => string,
): void {
  const marked = applyServerFieldErrors(error, setErrors);
  if (marked.length === 0) {
    toast.error(resolveMessage(error));
  }
  // 返回 marked 便于测试与调用方判断，这里不需要返回值，仅执行副作用
}
