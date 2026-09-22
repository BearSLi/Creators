import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/**
 * 环境变量统一入口。
 *
 * 设计要点：
 * 1) 进程启动时一次性校验，缺失/非法直接 crash（fail fast），
 *    而不是等到运行中某个请求才抛错——生产环境排队上线时这类错误代价极高。
 * 2) Prisma CLI 默认只读 apps/api/.env，而项目使用仓库根目录 .env，
 *    这里显式加载根目录与本地目录（存在的才加载），保证 `prisma` 与运行时行为一致。
 * 3) 对外只暴露经过类型转换的强类型对象，禁止业务代码直接读 process.env。
 */

const candidateEnvFiles = [
  resolve(process.cwd(), '.env'),
  resolve(process.cwd(), '../../.env'),
  resolve(__dirname, '../../.env'),
  resolve(__dirname, '../../../../.env'),
];
const loadedEnvFiles: string[] = [];
for (const file of candidateEnvFiles) {
  const result = loadDotenv({ path: file });
  if (!result.error) loadedEnvFiles.push(file);
}

/** 把 "true"/"1"/"yes" 这类字符串安全转成布尔 */
const booleanish = (defaultValue: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .default(defaultValue)
    .transform((value) => {
      if (typeof value === 'boolean') return value;
      return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
    });

const intFromString = (defaultValue: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z
    .union([z.number(), z.string()])
    .default(defaultValue)
    .transform((value) => (typeof value === 'number' ? value : Number.parseInt(value, 10)))
    .pipe(z.number().int().min(min).max(max));

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: intFromString(3100, 1, 65535),
    WEB_ORIGIN: z.string().default('http://localhost:5173'),
    PUBLIC_BASE_URL: z.string().default('http://localhost:3100'),

    DATABASE_URL: z
      .string()
      .min(1, 'DATABASE_URL 必填，示例：postgresql://user:pass@localhost:5432/creatorops')
      .refine((v) => v.startsWith('postgres'), 'DATABASE_URL 必须是 PostgreSQL 连接串'),
    DATABASE_POOL_SIZE: intFromString(10, 1, 200),

    REDIS_URL: z.string().default('redis://localhost:6379/0'),

    JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET 至少 16 位'),
    JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET 至少 16 位'),
    JWT_ACCESS_TTL: z.string().default('2h'),
    JWT_REFRESH_TTL: z.string().default('14d'),
    BCRYPT_ROUNDS: intFromString(12, 4, 15),

    THROTTLE_TTL_SECONDS: intFromString(60, 1, 3600),
    THROTTLE_LIMIT: intFromString(120, 1, 100_000),
    LOGIN_THROTTLE_LIMIT: intFromString(10, 1, 1000),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    LOG_PRETTY: booleanish(false),
    AUDIT_LOG_RETENTION_DAYS: intFromString(365, 30, 3650),

    AI_PROVIDER: z
      .enum(['openai', 'anthropic', 'gemini', 'deepseek', 'mock'])
      .default('mock'),
    AI_FALLBACK_PROVIDER: z
      .enum(['openai', 'anthropic', 'gemini', 'deepseek', 'mock'])
      .default('mock'),
    AI_DEFAULT_MODEL: z.string().default('gpt-4o-mini'),
    AI_REQUEST_TIMEOUT_MS: intFromString(45_000, 1000, 300_000),
    AI_MAX_RETRIES: intFromString(2, 0, 5),
    AI_MAX_TOKENS_PER_CALL: intFromString(4096, 256, 32_000),
    AI_MONTHLY_BUDGET_CNY: z
      .union([z.number(), z.string()])
      .default(2000)
      .transform((v) => (typeof v === 'number' ? v : Number.parseFloat(v))),
    AI_COST_PER_1K_INPUT_TOKENS: z
      .union([z.number(), z.string()])
      .default(0.0015)
      .transform((v) => (typeof v === 'number' ? v : Number.parseFloat(v))),
    AI_COST_PER_1K_OUTPUT_TOKENS: z
      .union([z.number(), z.string()])
      .default(0.006)
      .transform((v) => (typeof v === 'number' ? v : Number.parseFloat(v))),

    OPENAI_API_KEY: z.string().optional().default(''),
    OPENAI_BASE_URL: z.string().optional().default(''),
    ANTHROPIC_API_KEY: z.string().optional().default(''),
    GEMINI_API_KEY: z.string().optional().default(''),
    DEEPSEEK_API_KEY: z.string().optional().default(''),

    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    STORAGE_LOCAL_DIR: z.string().default('./storage'),
    S3_ENDPOINT: z.string().optional().default(''),
    S3_REGION: z.string().optional().default('ap-east-1'),
    S3_BUCKET: z.string().optional().default('creatorops'),
    S3_ACCESS_KEY_ID: z.string().optional().default(''),
    S3_SECRET_ACCESS_KEY: z.string().optional().default(''),

    COLLECTOR_MODE: z.enum(['mock', 'live']).default('mock'),
    DOUYIN_APP_ID: z.string().optional().default(''),
    DOUYIN_APP_SECRET: z.string().optional().default(''),
    XIAOHONGSHU_APP_ID: z.string().optional().default(''),
    XIAOHONGSHU_APP_SECRET: z.string().optional().default(''),
    BILIBILI_APP_ID: z.string().optional().default(''),
    BILIBILI_APP_SECRET: z.string().optional().default(''),
    TIKTOK_CLIENT_KEY: z.string().optional().default(''),
    TIKTOK_CLIENT_SECRET: z.string().optional().default(''),
    YOUTUBE_API_KEY: z.string().optional().default(''),

    SETTLEMENT_DEFAULT_PLATFORM_FEE_PERCENT: z
      .union([z.number(), z.string()])
      .default(10)
      .transform((v) => (typeof v === 'number' ? v : Number.parseFloat(v))),
    SETTLEMENT_AUTO_GENERATE_DAY: intFromString(3, 1, 28),
    SETTLEMENT_PAYMENT_TERM_DAYS: intFromString(30, 1, 365),

    ALERT_WEBHOOK_URL: z.string().optional().default(''),
    ALERT_ON_AI_BUDGET_EXCEEDED: booleanish(true),
  })
  .superRefine((value, ctx) => {
    // 生产环境禁止使用示例密钥，避免「改了环境变量忘了改密钥」上线。
    if (value.NODE_ENV === 'production') {
      const weakSecrets = [value.JWT_ACCESS_SECRET, value.JWT_REFRESH_SECRET];
      for (const [index, secret] of weakSecrets.entries()) {
        if (/change-me|dev-only|please-override/i.test(secret) || secret.length < 32) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index === 0 ? 'JWT_ACCESS_SECRET' : 'JWT_REFRESH_SECRET'],
            message: '生产环境必须使用至少 32 位的随机密钥（openssl rand -base64 48）',
          });
        }
      }
      if (value.JWT_ACCESS_SECRET === value.JWT_REFRESH_SECRET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['JWT_REFRESH_SECRET'],
          message: 'access / refresh 密钥必须不同，防止互相伪造',
        });
      }
    }
    // 选了真实厂商却没给 key，往往到第一次调用才发现，这里提前拦截。
    const providerRequiresKey: Record<string, string> = {
      openai: value.OPENAI_API_KEY,
      anthropic: value.ANTHROPIC_API_KEY,
      gemini: value.GEMINI_API_KEY,
      deepseek: value.DEEPSEEK_API_KEY,
    };
    if (value.AI_PROVIDER !== 'mock' && !providerRequiresKey[value.AI_PROVIDER]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AI_PROVIDER'],
        message: `AI_PROVIDER=${value.AI_PROVIDER} 但未配置对应 API Key，请补充或改用 mock`,
      });
    }
  });

export type AppEnv = z.infer<typeof envSchema>;

let cached: AppEnv | null = null;

/** 校验并返回环境变量；重复调用返回同一对象 */
export function loadEnv(): AppEnv {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `环境变量校验失败，服务拒绝启动：\n${details}\n\n` +
        `已加载的 env 文件：${loadedEnvFiles.length ? loadedEnvFiles.join(', ') : '无'}\n` +
        '请参考仓库根目录 .env.example 补全配置。',
    );
  }
  cached = parsed.data;
  return cached;
}

/** 测试用：重置缓存，便于切换环境变量后重新校验 */
export function resetEnvCache(): void {
  cached = null;
}

export const loadedEnvFilePaths = loadedEnvFiles;
