import type { AiTaskType } from '@prisma/client';

/**
 * AI Provider 抽象层。
 *
 * 业务代码只依赖 AiProvider 接口，不依赖任何厂商 SDK。收益：
 *   1) 换模型/换厂商不改业务模块（本项目已内置 openai / anthropic / gemini / deepseek / mock）；
 *   2) 单测与 CI 用 mock provider，无需真实 API Key、不花钱、结果确定；
 *   3) 降级链路（主模型失败切备用模型）在编排层统一实现，而不是散落在各业务里。
 *
 * 不使用厂商 SDK 而直接用 fetch 的原因：内部工具不值得为每个厂商引入一个重依赖，
 * 且各家 SDK 的升级策略不同，直接用 HTTP 更稳定可控，也更容易统一实现超时与重试。
 */

export interface AiCompletionRequest {
  model: string;
  /** 系统提示词：角色设定与硬性约束 */
  system: string;
  /** 用户提示词：本次任务的具体输入 */
  user: string;
  temperature: number;
  maxTokens: number;
  /** 要求返回 JSON 时置 true，部分厂商支持原生 JSON mode */
  jsonMode?: boolean;
  /** 结构化输出时给出字段说明，用于注入到 prompt 中约束格式 */
  expectedFields?: string[];
  /** 超时毫秒；由编排层统一传入，provider 不得自行决定 */
  timeoutMs: number;
}

export interface AiCompletionResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  /** 毫秒 */
  latencyMs: number;
  /** 厂商返回的结束原因，如 stop / length（length 说明被截断，需要提示用户） */
  finishReason?: string;
  /** 原始响应，落库用于排查（已剔除敏感字段） */
  raw?: unknown;
}

export interface AiProvider {
  readonly name: string;
  /** 该 provider 是否具备可用凭证；返回 false 时编排层直接走降级 */
  isConfigured(): boolean;
  complete(request: AiCompletionRequest): Promise<AiCompletionResult>;
}

export type AiProviderName = 'openai' | 'anthropic' | 'gemini' | 'deepseek' | 'mock';

export type AiErrorCode =
  | 'NOT_CONFIGURED'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'AUTH_FAILED'
  | 'BAD_REQUEST'
  | 'UPSTREAM_ERROR'
  | 'EMPTY_RESPONSE'
  | 'INVALID_OUTPUT';

export class AiProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly code: AiErrorCode,
    /** 是否值得重试：超时与限流可重试，鉴权失败重试无意义 */
    readonly retryable: boolean,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

/** 温度建议值：创意类任务高、结构化提取类低。集中管理便于统一调优 */
export const TEMPERATURE_PRESETS = {
  CREATIVE: 0.8,
  BALANCED: 0.5,
  DETERMINISTIC: 0.1,
} as const;

/** 各任务类型的默认参数，避免每个调用点各自拍脑袋定参数 */
export interface AiTaskPreset {
  temperature: number;
  maxTokens: number;
  expectsJson: boolean;
  /** 输出字段说明，会拼进 prompt 约束模型输出结构，也用于本地校验 */
  expectedFields: string[];
}

/**
 * 各任务类型的默认参数，避免每个调用点各自拍脑袋定参数。
 *
 * maxTokens 的取值要留意 **推理模型（reasoning model）**：
 * 像 deepseek-v4-pro 这类模型会把一部分 token 花在内部推理上，
 * 留给最终答案的额度被大幅挤占。实测 SCRIPT_GENERATE 在 2600 时
 * 会以 finish_reason=length 截断，产出半个 JSON → zod 校验失败 → 任务 FAILED。
 * 因此这里给脚本生成留了更宽的额度；同时编排层还会在检测到截断时
 * 自动翻倍重试一次（见 AiTaskService.execute 的 truncated 处理），
 * 两条保险一起用，避免"改了个模型就突然不可用"。
 */
export const AI_TASK_PRESETS: Record<AiTaskType, AiTaskPreset> = {
  SCRIPT_GENERATE: {
    temperature: TEMPERATURE_PRESETS.CREATIVE,
    maxTokens: 6000,
    expectsJson: true,
    expectedFields: ['title', 'hook', 'scenes', 'hashtags', 'risks'],
  },
  TITLE_OPTIMIZE: {
    temperature: TEMPERATURE_PRESETS.CREATIVE,
    maxTokens: 900,
    expectsJson: true,
    expectedFields: ['candidates'],
  },
  CREATOR_MATCH: {
    temperature: TEMPERATURE_PRESETS.BALANCED,
    maxTokens: 1800,
    expectsJson: true,
    expectedFields: ['matches', 'strategy'],
  },
  COMMENT_INSIGHT: {
    temperature: TEMPERATURE_PRESETS.BALANCED,
    maxTokens: 1600,
    expectsJson: true,
    expectedFields: ['sentiment', 'topTopics', 'replyTemplates'],
  },
  COMPLIANCE_CHECK: {
    temperature: TEMPERATURE_PRESETS.DETERMINISTIC,
    maxTokens: 1600,
    expectsJson: true,
    expectedFields: ['score', 'level', 'flags'],
  },
  SETTLEMENT_ANOMALY: {
    temperature: TEMPERATURE_PRESETS.DETERMINISTIC,
    maxTokens: 1600,
    expectsJson: true,
    expectedFields: ['conclusion', 'evidence', 'suggestion'],
  },
  DAILY_BRIEF: {
    temperature: TEMPERATURE_PRESETS.BALANCED,
    maxTokens: 1400,
    expectsJson: true,
    expectedFields: ['headline', 'highlights', 'risks', 'tomorrowFocus'],
  },
};
