import {
  AiCompletionRequest,
  AiCompletionResult,
  AiProvider,
  AiProviderError,
} from './ai-provider.interface';
import {
  buildOpenAiBody,
  fetchWithTimeout,
  isAbortError,
  jsonHeaders,
  OpenAiChatResponse,
} from './http.util';

/**
 * OpenAI 兼容协议的 Provider。
 *
 * 一个类覆盖三家厂商，因为 DeepSeek、多数国内模型与 OpenAI 的 /chat/completions 完全兼容：
 *   - OpenAI：https://api.openai.com/v1
 *   - DeepSeek：https://api.deepseek.com/v1
 *   - 其他兼容网关：通过 OPENAI_BASE_URL 指向自建代理
 * 这样新增一个兼容厂商只需加配置，不用加代码。
 *
 * 错误处理策略：把 HTTP 状态码翻译成可决策的错误码 + retryable 标记，
 * 由编排层决定重试还是降级——provider 自己不做重试，避免「重试套重试」放大流量。
 */
export class OpenAiCompatibleProvider implements AiProvider {
  constructor(
    readonly name: string,
    private readonly config: { apiKey: string; baseUrl: string; timeoutMs: number },
  ) {}

  isConfigured(): boolean {
    return Boolean(this.config.apiKey);
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    if (!this.isConfigured()) {
      throw new AiProviderError(this.name, `${this.name} 未配置 API Key`, 'NOT_CONFIGURED', false);
    }

    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetchWithTimeout(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: jsonHeaders({ Authorization: `Bearer ${this.config.apiKey}` }),
        body: JSON.stringify(buildOpenAiBody(request)),
        timeoutMs: request.timeoutMs || this.config.timeoutMs,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new AiProviderError(
          this.name,
          `${this.name} 请求超时（${request.timeoutMs}ms）`,
          'TIMEOUT',
          true,
        );
      }
      throw new AiProviderError(
        this.name,
        `无法连接 ${this.name}：${error instanceof Error ? error.message : '未知网络错误'}`,
        'UPSTREAM_ERROR',
        true,
      );
    }

    const payload = (await safeJson(response)) as OpenAiChatResponse | null;

    if (!response.ok) {
      throw translateHttpError(this.name, response.status, payload?.error?.message);
    }
    if (!payload) {
      throw new AiProviderError(this.name, `${this.name} 返回了非 JSON 响应`, 'UPSTREAM_ERROR', true);
    }

    const text = payload.choices?.[0]?.message?.content ?? '';
    if (!text.trim()) {
      throw new AiProviderError(this.name, `${this.name} 返回空内容`, 'EMPTY_RESPONSE', true);
    }

    return {
      text,
      promptTokens: payload.usage?.prompt_tokens ?? 0,
      completionTokens: payload.usage?.completion_tokens ?? 0,
      latencyMs: Date.now() - startedAt,
      finishReason: payload.choices?.[0]?.finish_reason,
      raw: { provider: this.name, model: request.model },
    };
  }
}

/** 把 HTTP 状态翻译成可决策的错误 */
export function translateHttpError(
  provider: string,
  status: number,
  vendorMessage?: string,
): AiProviderError {
  const message = vendorMessage?.slice(0, 300) ?? '';
  switch (status) {
    case 401:
    case 403:
      return new AiProviderError(provider, `鉴权失败：请检查 ${provider} API Key（${message}）`, 'AUTH_FAILED', false, status);
    case 400:
    case 404:
      return new AiProviderError(provider, `请求参数或模型名不被接受：${message}`, 'BAD_REQUEST', false, status);
    case 429:
      return new AiProviderError(provider, `触发 ${provider} 限流：${message}`, 'RATE_LIMITED', true, status);
    default:
      if (status >= 500) {
        return new AiProviderError(provider, `${provider} 服务端错误（${status}）：${message}`, 'UPSTREAM_ERROR', true, status);
      }
      return new AiProviderError(provider, `${provider} 调用失败（${status}）：${message}`, 'UPSTREAM_ERROR', false, status);
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
