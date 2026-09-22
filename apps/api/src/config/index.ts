import { loadEnv } from './env';

/**
 * 环境变量在进程启动时即完成校验（fail fast）。
 * 任何 import 到本模块的代码都可以安全假设配置合法。
 */
export const env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const isDevelopment = env.NODE_ENV === 'development';

/** 当前使用的 AI Provider（真实厂商 or mock 降级实现） */
export const ai = {
  provider: env.AI_PROVIDER,
  fallbackProvider: env.AI_FALLBACK_PROVIDER,
  defaultModel: env.AI_DEFAULT_MODEL,
  timeoutMs: env.AI_REQUEST_TIMEOUT_MS,
  maxRetries: env.AI_MAX_RETRIES,
  maxTokensPerCall: env.AI_MAX_TOKENS_PER_CALL,
  monthlyBudgetCny: env.AI_MONTHLY_BUDGET_CNY,
  costPer1kInputTokens: env.AI_COST_PER_1K_INPUT_TOKENS,
  costPer1kOutputTokens: env.AI_COST_PER_1K_OUTPUT_TOKENS,
  apiKeys: {
    openai: env.OPENAI_API_KEY,
    anthropic: env.ANTHROPIC_API_KEY,
    gemini: env.GEMINI_API_KEY,
    deepseek: env.DEEPSEEK_API_KEY,
  },
  openaiBaseUrl: env.OPENAI_BASE_URL,
} as const;
