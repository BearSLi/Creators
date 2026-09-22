import { AiCompletionRequest, AiCompletionResult } from './ai-provider.interface';

/**
 * 带超时与取消的 fetch 封装。
 *
 * 为什么必须显式超时：LLM 接口偶发挂起（既不返回也不断开），
 * 没有超时会让 Node 的 socket 长期占用，最终把连接池和事件循环拖住。
 * 用 AbortController 而不是 Promise.race：race 只是「不再等待」，
 * 底层请求仍然存活并占用连接；abort 才是真正释放。
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs: number },
): Promise<Response> {
  const { timeoutMs, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...rest, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 判断是否是超时导致的 abort（用于决定错误码是否为 TIMEOUT、可否重试） */
export function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || /aborted|timeout/i.test(error.message))
  );
}

/**
 * 指数退避。
 * 加随机抖动的目的：多个并发任务同时失败时，若退避时间完全相同会「撞车」重试，
 * 对被限流的第三方接口造成二次冲击。
 */
export async function backoff(attempt: number, baseMs = 400, maxMs = 4000): Promise<void> {
  const delay = Math.min(baseMs * 2 ** attempt, maxMs);
  const jitter = Math.floor(Math.random() * (delay * 0.3));
  await new Promise((resolve) => setTimeout(resolve, delay + jitter));
}

/** 从文本中稳健地抽出 JSON：模型常会包裹 ```json 代码块或前后加解释文字 */
export function extractJson(text: string): unknown {
  if (!text) return null;
  const trimmed = text.trim();

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    // 回退：截取第一个 { 到最后一个 }（或 [ ... ]），容忍模型输出的前后废话
    const firstBrace = candidate.search(/[[{]/);
    const lastBrace = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** 统一构造请求头，避免各 provider 重复代码 */
export function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'Content-Type': 'application/json', ...extra };
}

/** 供 provider 实现共享的请求体类型（OpenAI 兼容协议） */
export interface OpenAiChatRequest {
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  temperature: number;
  max_tokens: number;
  response_format?: { type: 'json_object' };
}

export interface OpenAiChatResponse {
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  error?: { message?: string; type?: string; code?: string };
}

/** 供测试注入的 provider 构造参数 */
export interface ProviderConfig {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
}

export function buildOpenAiBody(
  request: AiCompletionRequest,
): OpenAiChatRequest {
  const body: OpenAiChatRequest = {
    model: request.model,
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: request.user },
    ],
    temperature: request.temperature,
    max_tokens: request.maxTokens,
  };
  if (request.jsonMode) {
    body.response_format = { type: 'json_object' };
  }
  return body;
}

export type { AiCompletionRequest, AiCompletionResult };
