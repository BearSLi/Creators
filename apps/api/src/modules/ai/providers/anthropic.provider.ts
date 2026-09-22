import {
  AiCompletionRequest,
  AiCompletionResult,
  AiProvider,
  AiProviderError,
} from './ai-provider.interface';
import { fetchWithTimeout, isAbortError, jsonHeaders } from './http.util';
import { translateHttpError } from './openai.provider';

/**
 * Anthropic Messages API Provider。
 *
 * 与 OpenAI 协议的差异需要显式处理（这也是不能简单共用兼容层的原因）：
 *   1) system 是顶层字段，不放在 messages 里；
 *   2) max_tokens 必填；
 *   3) 无 response_format，JSON 输出只能靠 prompt 约束 + 本地解析兜底；
 *   4) 鉴权头是 x-api-key，且需要 anthropic-version。
 */
export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';

  constructor(
    private readonly config: { apiKey: string; baseUrl: string; timeoutMs: number },
  ) {}

  isConfigured(): boolean {
    return Boolean(this.config.apiKey);
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    if (!this.isConfigured()) {
      throw new AiProviderError(this.name, 'anthropic 未配置 API Key', 'NOT_CONFIGURED', false);
    }

    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetchWithTimeout(`${this.config.baseUrl.replace(/\/$/, '')}/messages`, {
        method: 'POST',
        headers: jsonHeaders({
          'x-api-key': this.config.apiKey,
          'anthropic-version': '2023-06-01',
        }),
        body: JSON.stringify({
          model: request.model,
          system: request.system,
          max_tokens: request.maxTokens,
          temperature: request.temperature,
          messages: [{ role: 'user', content: request.user }],
        }),
        timeoutMs: request.timeoutMs || this.config.timeoutMs,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new AiProviderError('anthropic', 'Anthropic 请求超时', 'TIMEOUT', true);
      }
      throw new AiProviderError('anthropic', 'Anthropic 连接失败', 'UPSTREAM_ERROR', true);
    }

    const payload = (await response.json().catch(() => null)) as AnthropicResponse | null;
    if (!response.ok) {
      throw translateHttpError('anthropic', response.status, payload?.error?.message);
    }

    const text = (payload?.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n')
      .trim();
    if (!text) {
      throw new AiProviderError('anthropic', 'Anthropic 返回空内容', 'EMPTY_RESPONSE', true);
    }

    return {
      text,
      promptTokens: payload?.usage?.input_tokens ?? 0,
      completionTokens: payload?.usage?.output_tokens ?? 0,
      latencyMs: Date.now() - startedAt,
      finishReason: payload?.stop_reason ?? undefined,
      raw: { provider: 'anthropic', model: request.model },
    };
  }
}

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}
