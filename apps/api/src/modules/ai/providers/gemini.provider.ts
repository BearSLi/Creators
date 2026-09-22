import {
  AiCompletionRequest,
  AiCompletionResult,
  AiProvider,
  AiProviderError,
} from './ai-provider.interface';
import { fetchWithTimeout, isAbortError, jsonHeaders } from './http.util';
import { translateHttpError } from './openai.provider';

/**
 * Google Gemini (generateContent) Provider。
 *
 * 差异点：
 *   1) 鉴权走 query 参数 key；
 *   2) system 用 systemInstruction；
 *   3) 生成参数在 generationConfig 下，且原生支持 responseMimeType=application/json；
 *   4) 内容路径带模型名，且需要把 candidates[].content.parts[].text 拼起来。
 */
export class GeminiProvider implements AiProvider {
  readonly name = 'gemini';

  constructor(private readonly config: { apiKey: string; baseUrl: string; timeoutMs: number }) {}

  isConfigured(): boolean {
    return Boolean(this.config.apiKey);
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    if (!this.isConfigured()) {
      throw new AiProviderError('gemini', 'gemini 未配置 API Key', 'NOT_CONFIGURED', false);
    }

    const baseUrl = this.config.baseUrl.replace(/\/$/, '');
    const url = `${baseUrl}/models/${encodeURIComponent(request.model)}:generateContent?key=${encodeURIComponent(this.config.apiKey)}`;
    const startedAt = Date.now();

    let response: Response;
    try {
      response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: request.system }] },
          contents: [{ role: 'user', parts: [{ text: request.user }] }],
          generationConfig: {
            temperature: request.temperature,
            maxOutputTokens: request.maxTokens,
            ...(request.jsonMode ? { responseMimeType: 'application/json' } : {}),
          },
        }),
        timeoutMs: request.timeoutMs || this.config.timeoutMs,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new AiProviderError('gemini', 'Gemini 请求超时', 'TIMEOUT', true);
      }
      throw new AiProviderError('gemini', 'Gemini 连接失败', 'UPSTREAM_ERROR', true);
    }

    const payload = (await response.json().catch(() => null)) as GeminiResponse | null;
    if (!response.ok) {
      throw translateHttpError('gemini', response.status, payload?.error?.message);
    }

    const candidate = payload?.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('\n')
      .trim();
    if (!text) {
      // 被安全策略拦截时 candidate 为空，需要单独给出可读原因
      const blocked = payload?.promptFeedback?.blockReason;
      throw new AiProviderError(
        'gemini',
        blocked ? `Gemini 安全策略拦截了本次请求（${blocked}）` : 'Gemini 返回空内容',
        'EMPTY_RESPONSE',
        false,
      );
    }

    return {
      text,
      promptTokens: payload?.usageMetadata?.promptTokenCount ?? 0,
      completionTokens: payload?.usageMetadata?.candidatesTokenCount ?? 0,
      latencyMs: Date.now() - startedAt,
      finishReason: candidate?.finishReason ?? undefined,
      raw: { provider: 'gemini', model: request.model },
    };
  }
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string };
}
