import { Injectable, Logger } from '@nestjs/common';
import { ai } from '../../../config/index';
import { AiProvider, AiProviderName } from './ai-provider.interface';
import { AnthropicProvider } from './anthropic.provider';
import { GeminiProvider } from './gemini.provider';
import { MockAiProvider } from './mock.provider';
import { OpenAiCompatibleProvider } from './openai.provider';

/**
 * Provider 注册表。
 *
 * 职责：按名字返回可用的 Provider 实例，并在配置缺失时把请求导向 mock，
 * 而不是让整个 AI 功能直接不可用——内部工具的定位是「辅助决策」，
 * 在 Key 未配置时给运营一个明确的 mock 输出（并标注 mock=true），
 * 比弹一个 500 更有价值（新人上手、演示、离线开发都需要）。
 */
@Injectable()
export class AiProviderRegistry {
  private readonly logger = new Logger(AiProviderRegistry.name);
  private readonly providers = new Map<AiProviderName, AiProvider>();

  constructor() {
    this.register('mock', new MockAiProvider());
    this.register(
      'openai',
      new OpenAiCompatibleProvider('openai', {
        apiKey: ai.apiKeys.openai,
        baseUrl: ai.openaiBaseUrl || 'https://api.openai.com/v1',
        timeoutMs: ai.timeoutMs,
      }),
    );
    this.register(
      'deepseek',
      new OpenAiCompatibleProvider('deepseek', {
        apiKey: ai.apiKeys.deepseek,
        baseUrl: 'https://api.deepseek.com/v1',
        timeoutMs: ai.timeoutMs,
      }),
    );
    this.register(
      'anthropic',
      new AnthropicProvider({
        apiKey: ai.apiKeys.anthropic,
        baseUrl: 'https://api.anthropic.com/v1',
        timeoutMs: ai.timeoutMs,
      }),
    );
    this.register(
      'gemini',
      new GeminiProvider({
        apiKey: ai.apiKeys.gemini,
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        timeoutMs: ai.timeoutMs,
      }),
    );
  }

  private register(name: AiProviderName, provider: AiProvider): void {
    this.providers.set(name, provider);
  }

  /** 取指定 Provider；未注册时回退 mock，保证调用方永远拿到可用实例 */
  get(name: AiProviderName): AiProvider {
    const provider = this.providers.get(name);
    if (provider) return provider;
    this.logger.warn(`未注册的 AI Provider「${name}」，已回退到 mock`);
    return this.providers.get('mock')!;
  }

  /**
   * 解析实际可用的主 Provider。
   * 规则：配置了真实 Provider 但缺少 Key 时降级为 mock，并记录一次告警
   * （告警而非抛错：Key 忘记配置属于环境问题，不应阻断整个系统可用性）。
   */
  resolvePrimary(): { provider: AiProvider; degraded: boolean; reason?: string } {
    const configured = ai.provider;
    const primary = this.get(configured);
    if (primary.isConfigured()) {
      return { provider: primary, degraded: false };
    }
    const reason = `${configured} 未配置 API Key，已降级为 mock provider（输出会标注 mock=true）`;
    this.logger.warn(reason);
    return { provider: this.get('mock'), degraded: true, reason };
  }

  /** 解析降级 Provider（主 Provider 调用失败时使用） */
  resolveFallback(): AiProvider {
    const fallback = this.get(ai.fallbackProvider);
    return fallback.isConfigured() ? fallback : this.get('mock');
  }

  /** 列出各 Provider 的可用状态，供系统配置页展示 */
  describeAvailability(): Array<{ name: AiProviderName; configured: boolean }> {
    return [...this.providers.entries()].map(([name, provider]) => ({
      name,
      configured: provider.isConfigured(),
    }));
  }
}
