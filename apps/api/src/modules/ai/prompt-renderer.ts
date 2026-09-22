import { BusinessException } from '../../common/exceptions/business.exception';

/**
 * Prompt 模板渲染器（纯函数，可单测）。
 *
 * 选择自己实现而不是引入 handlebars/mustache 的原因：
 *   1) 需求只有「占位符替换 + 长度约束」，引入模板引擎会让 Prompt 内容能被注入逻辑，
 *      而 Prompt 属于运营可编辑内容，存在被写入恶意模板表达式执行的风险面；
 *   2) 内部工具的 Prompt 由运营维护，语法越简单越不容易写错。
 *
 * 安全约定：
 *   - **不做任何表达式求值**，未知变量保持原样（便于发现模板写错，而不是静默变空）；
 *   - 单变量长度上限可控，防止把整张表塞进 Prompt 造成 token 爆炸与成本失控；
 *   - 缺失必填变量直接报错，且错误信息列出缺哪些变量，便于运营自助修复模板。
 */

export interface PromptVariableSpec {
  name: string;
  required?: boolean;
  description?: string;
  maxLength?: number;
}

export interface RenderResult {
  text: string;
  /** 实际使用的变量（脱敏后），落库用于复现问题 */
  usedVariables: Record<string, string>;
  /** 被截断的变量，提示运营输入过长 */
  truncated: string[];
  /** 模板中存在但调用方未提供的占位符 */
  missing: string[];
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/** 渲染模板。调用方保证 variables 已通过业务校验 */
export function renderTemplate(
  template: string,
  variables: Record<string, unknown>,
  specs: PromptVariableSpec[] = [],
): RenderResult {
  const specMap = new Map(specs.map((spec) => [spec.name, spec]));
  const used: Record<string, string> = {};
  const truncated: string[] = [];
  const missing: string[] = [];

  // 先用一次扫描找出模板里声明的全部占位符，才能准确报出「缺失变量」
  const declared = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) {
    declared.add(match[1]);
  }

  const text = template.replace(PLACEHOLDER, (_full, rawName: string) => {
    const name = rawName.trim();
    const rawValue = readPath(variables, name);

    if (rawValue === undefined || rawValue === null || rawValue === '') {
      const spec = specMap.get(name);
      if (spec?.required !== false) missing.push(name);
      // 保持原样输出：让问题在产出里可见，而不是静默变成空字符串
      return `{{${name}}}`;
    }

    let value = stringify(rawValue);
    const maxLength = specMap.get(name)?.maxLength;
    if (maxLength && value.length > maxLength) {
      value = `${value.slice(0, maxLength)}…（已截断，原文 ${value.length} 字）`;
      truncated.push(name);
    }
    used[name] = value.length > 500 ? `${value.slice(0, 500)}…` : value;
    return value;
  });

  return { text, usedVariables: used, truncated, missing: [...new Set(missing)] };
}

/** 校验必填变量，缺失则抛错并列出变量名 */
export function assertRequiredVariables(
  specs: PromptVariableSpec[],
  variables: Record<string, unknown>,
): void {
  const missing = specs
    .filter((spec) => spec.required !== false)
    .filter((spec) => {
      const value = variables[spec.name];
      return value === undefined || value === null || value === '';
    })
    .map((spec) => spec.name);

  if (missing.length > 0) {
    throw new BusinessException(
      'PROMPT_VARIABLES_MISSING',
      `Prompt 模板缺少必填变量：${missing.join('、')}`,
      400,
      { missing },
    );
  }
}

/**
 * 解析模板变量声明（存库时是 JSON，可能是脏数据）。
 * 容错：非数组返回空；单项缺 name 丢弃；maxLength 限制在 1-20000 之间，
 * 防止有人把 maxLength 写成 0 导致所有内容被清空。
 */
export function parseVariableSpecs(value: unknown): PromptVariableSpec[] {
  if (!Array.isArray(value)) return [];
  const specs: PromptVariableSpec[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!name) continue;
    const maxLength =
      typeof item.maxLength === 'number' && Number.isFinite(item.maxLength)
        ? Math.min(Math.max(Math.trunc(item.maxLength), 1), 20_000)
        : undefined;
    specs.push({
      name,
      required: item.required !== false,
      description: typeof item.description === 'string' ? item.description : undefined,
      maxLength,
    });
  }
  return specs;
}

/** 支持 a.b 形式的路径读取，便于传嵌套对象而不用先拍平成字符串 */
function readPath(source: Record<string, unknown>, path: string): unknown {
  if (path in source) return source[path];
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, source);
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
