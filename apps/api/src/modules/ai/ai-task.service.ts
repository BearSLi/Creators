import { Injectable, Logger } from '@nestjs/common';
import { AiTaskStatus, AiTaskType, Prisma } from '@prisma/client';
import { z } from 'zod';
import { ai } from '../../config/index';
import {
  BusinessException,
  ResourceNotFoundException,
  RateLimitedException,
  UpstreamUnavailableException,
} from '../../common/exceptions/business.exception';
import { buildPaginated, PaginatedResult, resolveOrderBy } from '../../common/utils/pagination';
import { extractCount } from '../../common/utils/group-count';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import {
  AI_TASK_PRESETS,
  AiCompletionResult,
  AiProvider,
  AiProviderError,
} from './providers/ai-provider.interface';
import { AiProviderRegistry } from './providers/ai-provider.registry';
import { backoff, extractJson } from './providers/http.util';
import { assertRequiredVariables, parseVariableSpecs, renderTemplate } from './prompt-renderer';
import { CreateAiTaskDto, QueryAiTaskDto, SubmitFeedbackDto } from './dto/ai.dto';

/** 任务类型中文名，用于前端展示与日志 */
export const AI_TASK_TYPE_LABELS: Record<AiTaskType, string> = {
  SCRIPT_GENERATE: '脚本生成',
  TITLE_OPTIMIZE: '标题优化',
  CREATOR_MATCH: '达人匹配',
  COMMENT_INSIGHT: '评论洞察',
  COMPLIANCE_CHECK: '内容合规预检',
  SETTLEMENT_ANOMALY: '结算异常解释',
  DAILY_BRIEF: '运营日报',
};

export const AI_TASK_STATUS_LABELS: Record<AiTaskStatus, string> = {
  QUEUED: '排队中',
  RUNNING: '执行中',
  SUCCEEDED: '成功',
  FAILED: '失败',
  FALLBACK_USED: '降级完成',
  REJECTED: '已拦截',
};

/**
 * 输出结构校验（zod）。
 *
 * 为什么对 LLM 输出也要强校验：模型会「看起来正确」地返回缺字段的 JSON，
 * 如果直接落库，前端渲染时才炸，排查成本极高。这里在写入前校验，
 * 校验失败按失败任务处理并保留原文，人工可复盘是 Prompt 问题还是模型问题。
 * 用 passthrough 而不是 strict：允许模型多返回字段（例如 confidence），不因此判失败。
 */
const OUTPUT_SCHEMAS: Record<AiTaskType, z.ZodTypeAny> = {
  SCRIPT_GENERATE: z
    .object({
      title: z.string().min(1),
      hook: z.string().optional(),
      structure: z.string().optional(),
      scenes: z
        .array(
          z
            .object({
              index: z.number().optional(),
              timeRange: z.string().optional(),
              shot: z.string().optional(),
              voiceover: z.string().optional(),
              note: z.string().optional(),
            })
            .passthrough(),
        )
        .min(1),
      hashtags: z.array(z.string()).optional(),
      risks: z.array(z.string()).optional(),
    })
    .passthrough(),
  TITLE_OPTIMIZE: z
    .object({
      candidates: z
        .array(
          z
            .object({ title: z.string().min(1), reason: z.string().optional(), score: z.number().optional() })
            .passthrough(),
        )
        .min(1),
    })
    .passthrough(),
  CREATOR_MATCH: z
    .object({
      matches: z.array(
        z
          .object({
            creatorId: z.string(),
            creatorName: z.string().optional(),
            score: z.number(),
            reasons: z.array(z.string()).optional(),
            risks: z.array(z.string()).optional(),
          })
          .passthrough(),
      ),
      strategy: z.string().optional(),
    })
    .passthrough(),
  COMMENT_INSIGHT: z
    .object({
      sentiment: z.record(z.number()).optional(),
      topTopics: z.array(z.object({ topic: z.string() }).passthrough()).optional(),
      replyTemplates: z.array(z.string()).optional(),
    })
    .passthrough(),
  COMPLIANCE_CHECK: z
    .object({
      score: z.number().min(0).max(100),
      level: z.enum(['PASS', 'WARN', 'REJECT']),
      flags: z
        .array(
          z
            .object({
              level: z.string(),
              category: z.string(),
              snippet: z.string().optional(),
              reason: z.string().optional(),
              suggestion: z.string().optional(),
            })
            .passthrough(),
        )
        .default([]),
    })
    .passthrough(),
  SETTLEMENT_ANOMALY: z
    .object({
      conclusion: z.string().min(1),
      evidence: z.array(z.string()).optional(),
      suggestion: z.string().optional(),
    })
    .passthrough(),
  DAILY_BRIEF: z
    .object({
      headline: z.string().min(1),
      highlights: z.array(z.string()).optional(),
      risks: z.array(z.string()).optional(),
      tomorrowFocus: z.array(z.string()).optional(),
    })
    .passthrough(),
};

export interface AiTaskView {
  id: string;
  taskType: AiTaskType;
  taskTypeLabel: string;
  status: AiTaskStatus;
  statusLabel: string;
  provider: string | null;
  model: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costCents: number;
  costYuan: string;
  latencyMs: number;
  retryCount: number;
  fallbackReason: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  humanFeedback: number;
  feedbackNote: string | null;
  output: unknown;
  input: unknown;
  creatorId: string | null;
  requestedByName: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface UsageSummary {
  year: number;
  month: number;
  monthCny: number;
  budgetCny: number;
  usedPercent: number;
  totalTasks: number;
  succeeded: number;
  failed: number;
  fallback: number;
  rejected: number;
  avgLatencyMs: number;
  totalTokens: number;
  byType: Array<{ taskType: AiTaskType; label: string; count: number; costCents: number; avgLatencyMs: number }>;
  adoption: { adopted: number; rejected: number; unevaluated: number; adoptionRatePercent: number };
}

@Injectable()
export class AiTaskService {
  private readonly logger = new Logger(AiTaskService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: AiProviderRegistry,
  ) {}

  // -------------------------------------------------------------------------
  // 查询
  // -------------------------------------------------------------------------

  async list(_user: AuthUser, query: QueryAiTaskDto): Promise<PaginatedResult<AiTaskView>> {
    const where: Prisma.AiTaskWhereInput = {
      taskType: query.taskType,
      status: query.status,
      creatorId: query.creatorId,
      requestedById: query.requestedById,
      createdAt:
        query.from || query.to
          ? {
              gte: query.from ? new Date(query.from) : undefined,
              lte: query.to ? new Date(query.to) : undefined,
            }
          : undefined,
    };

    const orderBy = resolveOrderBy(
      query.sortBy,
      query.sortOrder,
      ['createdAt', 'latencyMs', 'costCents', 'totalTokens'] as const,
      'createdAt',
    );

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.aiTask.findMany({
        where,
        orderBy,
        skip: query.skip,
        take: query.take,
        include: { requestedBy: { select: { name: true } } },
      }),
      this.prisma.aiTask.count({ where }),
    ]);

    return buildPaginated(
      rows.map((row) => this.toView(row)),
      total,
      query.page,
      query.pageSize,
    );
  }

  async findOne(id: string): Promise<AiTaskView> {
    const task = await this.prisma.aiTask.findUnique({
      where: { id },
      include: { requestedBy: { select: { name: true } } },
    });
    if (!task) throw new ResourceNotFoundException('AI 任务');
    return this.toView(task);
  }

  // -------------------------------------------------------------------------
  // 执行（核心编排）
  // -------------------------------------------------------------------------

  /**
   * 执行一次 AI 任务。完整链路：
   *   幂等校验 → 取模板 → 变量校验 → 渲染 → 成本预检 → 落库(RUNNING)
   *   → 调主 Provider（有限重试）→ 失败则降级 → 解析校验 → 回写结果与成本
   *
   * 关键设计：
   *  1) **幂等**：前端传 idempotencyKey 时，同一 key 只会真正调用一次模型。
   *     这直接防住「用户狂点按钮 → 重复扣费」，是成本治理最重要的一环。
   *  2) **预算熔断**：月度成本超预算时拒绝新任务（而非静默继续烧钱），
   *     并给出明确提示，由管理者决定是否调高预算。
   *  3) **降级不隐藏**：主模型失败走备用模型时，任务状态为 FALLBACK_USED
   *     并写明原因，前端会提示用户「本次结果由降级模型生成」，避免误判质量。
   *  4) **全部落库**：输入、渲染后 prompt、输出、token、成本、耗时、重试次数。
   */
  async execute(user: AuthUser, dto: CreateAiTaskDto): Promise<AiTaskView> {
    if (dto.idempotencyKey) {
      const existing = await this.prisma.aiTask.findUnique({
        where: { idempotencyKey: dto.idempotencyKey },
        include: { requestedBy: { select: { name: true } } },
      });
      if (existing) {
        this.logger.log(`AI 任务幂等命中 key=${dto.idempotencyKey}，直接返回既有结果`);
        return this.toView(existing);
      }
    }

    const preset = AI_TASK_PRESETS[dto.taskType];
    const template = await this.loadActiveTemplate(dto.taskType, user);

    // 变量校验在渲染前：缺失必填变量时不应消耗任何 token
    const variableSpecs = parseVariableSpecs(template.variables);
    assertRequiredVariables(variableSpecs, dto.input);

    const rendered = renderTemplate(
      `${template.systemPrompt}\n\n${template.userPromptTemplate}`,
      dto.input,
      variableSpecs,
    );
    if (rendered.missing.length > 0) {
      // 非必填变量缺失只提示，不阻断；但必填已在上面拦住
      this.logger.debug(`模板存在未提供变量：${rendered.missing.join(', ')}`);
    }

    const estimatedTokens = estimateTokens(rendered.text) + preset.maxTokens;
    await this.assertBudgetAvailable(estimatedTokens);

    const { provider: primary, degraded, reason } = this.registry.resolvePrimary();

    // 发请求前先校验模型名与 Provider 是否匹配：
    // 不匹配时上游只会回一个笼统的 BAD_REQUEST 并触发降级，
    // 用户看到的是「AI 不稳定」，而真实原因是配置写错了厂商型号。
    const requestedModel = template.model || ai.defaultModel;
    this.assertModelMatchesProvider(requestedModel, primary.name);

    /**
     * maxTokens 取值策略：**取较大者**，而不是「模板值优先」。
     *
     * 早期实现是 `Math.min(template.maxTokens ?? preset.maxTokens, 上限)`，
     * 于是模板里内置的 2048 会压过任务预设的更宽额度。换成推理模型
     * （如 deepseek-v4-pro，会把大量 token 花在内部推理上）后，
     * 输出必然被截断 → 半个 JSON → zod 校验失败 → 任务 FAILED。
     * 模板里的 maxTokens 是「运营可调的旋钮」，不该成为上限压制；
     * 真正的上限由 AI_MAX_TOKENS_PER_CALL 统一约束（成本熔断）。
     */
    const configuredMax = Math.max(template.maxTokens ?? 0, preset.maxTokens);
    const tokenCeiling = ai.maxTokensPerCall;

    const request = {
      model: requestedModel,
      system: template.systemPrompt,
      user: template.userPromptTemplate.includes('{{')
        ? rendered.text.replace(`${template.systemPrompt}\n\n`, '')
        : rendered.text,
      temperature: Number(template.temperature ?? preset.temperature),
      maxTokens: Math.min(configuredMax, tokenCeiling),
      jsonMode: preset.expectsJson,
      expectedFields: preset.expectedFields,
      timeoutMs: ai.timeoutMs,
    };

    const task = await this.prisma.aiTask.create({
      data: {
        taskType: dto.taskType,
        status: 'RUNNING',
        creatorId: dto.creatorId ?? null,
        input: dto.input as Prisma.InputJsonValue,
        renderedPrompt: truncate(rendered.text, 20_000),
        provider: primary.name,
        model: request.model,
        templateId: template.id,
        startedAt: new Date(),
        requestedById: user.id,
        idempotencyKey: dto.idempotencyKey ?? null,
        fallbackReason: degraded ? reason ?? null : null,
      },
      select: { id: true },
    });

    let result: AiCompletionResult | null = null;
    let usedProvider: AiProvider = primary;
    let retryCount = 0;
    let fallbackReason: string | null = degraded ? reason ?? null : null;
    let primaryError: AiProviderError | null = null;
    let truncatedRetryNote: string | null = null;

    /**
     * 输出被截断时自动放大额度重试一次。
     *
     * 为什么值得单独做这一步：截断（finish_reason=length）不是「模型出错」，
     * 而是「预算给少了」，但它的表现形式是 JSON 只写了一半 →
     * zod 校验失败 → 任务被标成 FAILED。用户看到的是「AI 不稳定」，
     * 实际只需要更大额度。而推理模型（deepseek-v4-pro 等）会消耗大量
     * 内部推理 token，这个情况尤其常见。
     *
     * 边界：只重试一次、且不超过 AI_MAX_TOKENS_PER_CALL（成本熔断线），
     * 避免变成无限翻倍烧钱。重试结果会记录在 fallbackReason 里，
     * 让「为什么这次慢/贵」有据可查。
     */
    const runOnce = async (
      provider: AiProvider,
      tokenBudget: number,
    ): Promise<{ result: AiCompletionResult; retryCount: number; retriedForTruncation: boolean }> => {
      const first = await this.callWithRetry(provider, { ...request, maxTokens: tokenBudget });

      const wasTruncated = first.result.finishReason === 'length';
      const canGrow = tokenBudget < tokenCeiling;

      if (!wasTruncated || !canGrow) {
        return { ...first, retriedForTruncation: false };
      }

      const grown = Math.min(tokenBudget * 2, tokenCeiling);
      this.logger.warn(
        `输出被截断（finish_reason=length，maxTokens=${tokenBudget}），自动放大到 ${grown} 重试一次 task=${task.id}`,
      );
      const second = await this.callWithRetry(provider, { ...request, maxTokens: grown });

      truncatedRetryNote =
        `首次输出在 maxTokens=${tokenBudget} 处被截断，已自动放大到 ${grown} 重试` +
        (second.result.finishReason === 'length' ? '（仍然被截断，建议调高 AI_MAX_TOKENS_PER_CALL）' : '后成功');
      return { ...second, retriedForTruncation: true };
    };

    try {
      const outcome = await runOnce(primary, request.maxTokens);
      result = outcome.result;
      retryCount = outcome.retryCount;
    } catch (error) {
      primaryError = error instanceof AiProviderError ? error : null;
      // 主 Provider 失败 → 降级。降级目标若是同一个 Provider 则不再尝试（无意义且浪费时间）
      const fallback = this.registry.resolveFallback();
      if (fallback.name === primary.name) {
        await this.failTask(task.id, primaryError, retryCount);
        throw this.toHttpError(primaryError);
      }
      fallbackReason = `${primary.name} 调用失败（${primaryError?.code ?? 'UNKNOWN'}：${primaryError?.message ?? '未知错误'}），已降级到 ${fallback.name}`;
      this.logger.warn(`AI 任务降级 task=${task.id} ${fallbackReason}`);
      try {
        const outcome = await runOnce(fallback, request.maxTokens);
        result = outcome.result;
        retryCount += outcome.retryCount;
        usedProvider = fallback;
      } catch (fallbackError) {
        await this.failTask(
          task.id,
          fallbackError instanceof AiProviderError ? fallbackError : primaryError,
          retryCount,
          fallbackReason,
        );
        throw this.toHttpError(fallbackError instanceof AiProviderError ? fallbackError : primaryError);
      }
    }

    // ---- 解析与校验输出 ----
    const parsed = preset.expectsJson ? extractJson(result.text) : { result: result.text };
    let output: unknown = parsed;
    let status: AiTaskStatus = fallbackReason ? 'FALLBACK_USED' : 'SUCCEEDED';
    let errorCode: string | null = null;
    let errorMessage: string | null = null;

    if (parsed === null || parsed === undefined) {
      // JSON 解析失败：保留原始文本，标记失败，让人工可见「模型没按要求输出」
      status = 'FAILED';
      errorCode = 'INVALID_OUTPUT';
      errorMessage = '模型输出不是合法 JSON，已保留原始文本供排查';
      output = { rawText: truncate(result.text, 8000) };
    } else {
      const validation = OUTPUT_SCHEMAS[dto.taskType].safeParse(parsed);
      if (!validation.success) {
        status = 'FAILED';
        errorCode = 'SCHEMA_MISMATCH';
        errorMessage = `输出结构不符合预期：${validation.error.issues
          .slice(0, 5)
          .map((issue) => `${issue.path.join('.') || 'root'} ${issue.message}`)
          .join('；')}`;
        output = { rawText: truncate(result.text, 8000), parsed };
      } else {
        output = parsed;
      }
    }

    const costCents = calculateCostCents(result.promptTokens, result.completionTokens);
    const truncatedOutput = result.finishReason === 'length';

    // 把「自动放大额度重试」的过程写进 fallbackReason：
    // 这是用户唯一能事后解释「为什么这次耗时/成本翻倍」的地方。
    // 用「；」拼接而非覆盖，保证原有降级原因不丢失。
    const finalFallbackReason = truncatedRetryNote
      ? fallbackReason
        ? `${fallbackReason}；${truncatedRetryNote}`
        : truncatedRetryNote
      : fallbackReason;

    const updated = await this.prisma.aiTask.update({
      where: { id: task.id },
      data: {
        status,
        output: output as Prisma.InputJsonValue,
        provider: usedProvider.name,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        totalTokens: result.promptTokens + result.completionTokens,
        costCents,
        latencyMs: result.latencyMs,
        retryCount,
        fallbackReason: finalFallbackReason,
        errorCode,
        errorMessage,
        finishedAt: new Date(),
      },
      include: { requestedBy: { select: { name: true } } },
    });

    if (truncatedOutput) {
      // 走到这里说明「放大重试后仍被截断」或「已到额度上限无法再放大」，
      // 因此给出的是可执行的配置项，而不是笼统的「建议调高」。
      this.logger.warn(
        `AI 任务输出仍被截断（finish_reason=length，maxTokens=${request.maxTokens}，已达上限 ${ai.maxTokensPerCall}）` +
          `task=${task.id}。请调高 AI_MAX_TOKENS_PER_CALL，或改用输出更短的模型；` +
          `若使用推理模型（如 deepseek-v4-pro），它会把大量 token 花在内部推理上，需要更宽的额度。`,
      );
    }
    this.logger.log(
      `AI 任务完成 type=${dto.taskType} provider=${usedProvider.name} status=${status} tokens=${result.promptTokens}+${result.completionTokens} 成本=${(costCents / 100).toFixed(4)}元 耗时=${result.latencyMs}ms`,
    );

    return this.toView(updated);
  }

  /** 提交人工反馈：采纳/拒绝，用于 Prompt 与模型效果的持续迭代 */
  async submitFeedback(user: AuthUser, id: string, dto: SubmitFeedbackDto): Promise<AiTaskView> {
    const task = await this.prisma.aiTask.findUnique({ where: { id }, select: { id: true } });
    if (!task) throw new ResourceNotFoundException('AI 任务');
    const updated = await this.prisma.aiTask.update({
      where: { id },
      data: { humanFeedback: dto.feedback, feedbackNote: dto.note ?? null },
      include: { requestedBy: { select: { name: true } } },
    });
    this.logger.log(
      `AI 任务反馈 task=${id} feedback=${dto.feedback} by=${user.email}${dto.note ? ` 备注=${dto.note}` : ''}`,
    );
    return this.toView(updated);
  }

  // -------------------------------------------------------------------------
  // 成本与用量
  // -------------------------------------------------------------------------

  /**
   * 月度成本用量统计。
   * 这是「AI 成本治理」的核心视图：让管理者看到钱花在哪类任务上，
   * 以及人工采纳率——只有采纳率高、成本可控的 AI 能力才值得推广到更多流程。
   */
  async usage(year: number, month: number): Promise<UsageSummary> {
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 1));

    const [aggregate, byTypeRows, adoptionRows] = await this.prisma.$transaction([
      this.prisma.aiTask.aggregate({
        where: { createdAt: { gte: start, lt: end } },
        _count: { _all: true },
        _sum: { costCents: true, totalTokens: true },
        _avg: { latencyMs: true },
      }),
      this.prisma.aiTask.groupBy({
        by: ['taskType'],
        where: { createdAt: { gte: start, lt: end } },
        _count: { _all: true },
        _sum: { costCents: true },
        _avg: { latencyMs: true },
        orderBy: { taskType: 'asc' },
      }),
      this.prisma.aiTask.groupBy({
        by: ['status'],
        where: { createdAt: { gte: start, lt: end } },
        _count: { _all: true },
        orderBy: { status: 'asc' },
      }),
    ]);

    // 统一用 extractCount 读取 groupBy 的分组计数：
    // `_count` 的静态类型是 `true | {...} | undefined`（Prisma 在 by 为动态字段时
    // 无法收窄），直接参与算术会报一堆 TS18048/TS2363。详见 utils/group-count.ts。
    const statusCount = (status: AiTaskStatus): number =>
      extractCount(adoptionRows.find((row) => row.status === status));

    const feedbackRows = await this.prisma.aiTask.groupBy({
      by: ['humanFeedback'],
      where: { createdAt: { gte: start, lt: end } },
      _count: { _all: true },
      orderBy: { humanFeedback: 'asc' },
    });
    const adopted = extractCount(feedbackRows.find((row) => row.humanFeedback === 1));
    const rejected = extractCount(feedbackRows.find((row) => row.humanFeedback === -1));
    const unevaluated = extractCount(feedbackRows.find((row) => row.humanFeedback === 0));
    const evaluated = adopted + rejected;

    const costCny = (aggregate._sum?.costCents ?? 0) / 100;
    return {
      year,
      month,
      monthCny: Number(costCny.toFixed(4)),
      budgetCny: ai.monthlyBudgetCny,
      usedPercent: ai.monthlyBudgetCny > 0 ? Number(((costCny / ai.monthlyBudgetCny) * 100).toFixed(2)) : 0,
      totalTasks: extractCount(aggregate),
      succeeded: statusCount('SUCCEEDED'),
      failed: statusCount('FAILED'),
      fallback: statusCount('FALLBACK_USED'),
      rejected: statusCount('REJECTED'),
      avgLatencyMs: Math.round(aggregate._avg?.latencyMs ?? 0),
      totalTokens: aggregate._sum?.totalTokens ?? 0,
      byType: byTypeRows
        .map((row) => ({
          taskType: row.taskType,
          label: AI_TASK_TYPE_LABELS[row.taskType],
          count: extractCount(row),
          costCents: row._sum?.costCents ?? 0,
          avgLatencyMs: Math.round(row._avg?.latencyMs ?? 0),
        }))
        .sort((a, b) => b.count - a.count),
      adoption: {
        adopted,
        rejected,
        unevaluated,
        adoptionRatePercent: evaluated > 0 ? Number(((adopted / evaluated) * 100).toFixed(1)) : 0,
      },
    };
  }

  /**
   * 预算检查。
   * 例外：AI_PROVIDER=mock 时不校验预算——mock 不产生真实费用，
   * 若也拦截会让「预算已满」的演示场景无法验证功能。
   */
  private async assertBudgetAvailable(estimatedTokens: number): Promise<void> {
    if (ai.provider === 'mock') return;

    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const aggregate = await this.prisma.aiTask.aggregate({
      where: { createdAt: { gte: start } },
      _sum: { costCents: true },
    });
    const usedCny = (aggregate._sum.costCents ?? 0) / 100;
    if (usedCny >= ai.monthlyBudgetCny) {
      throw new BusinessException(
        'AI_BUDGET_EXCEEDED',
        `本月 AI 预算已用尽（已用 ${usedCny.toFixed(2)} 元 / 预算 ${ai.monthlyBudgetCny} 元），请联系管理员调整预算或等待下月重置`,
        402,
        { usedCny, budgetCny: ai.monthlyBudgetCny },
      );
    }

    const estimatedCost = estimateCostCny(estimatedTokens);
    if (usedCny + estimatedCost > ai.monthlyBudgetCny) {
      throw new BusinessException(
        'AI_BUDGET_INSUFFICIENT',
        `本次任务预计消耗 ${estimatedCost.toFixed(4)} 元，将超出本月预算（剩余 ${(ai.monthlyBudgetCny - usedCny).toFixed(2)} 元）`,
        402,
        { usedCny, budgetCny: ai.monthlyBudgetCny, estimatedCostCny: estimatedCost },
      );
    }
  }

  /** 有限重试：仅对可重试错误（超时/限流/5xx）重试，鉴权与参数错误立即失败 */
  private async callWithRetry(
    provider: AiProvider,
    request: Parameters<AiProvider['complete']>[0],
  ): Promise<{ result: AiCompletionResult; retryCount: number }> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= ai.maxRetries; attempt += 1) {
      try {
        const result = await provider.complete(request);
        return { result, retryCount: attempt };
      } catch (error) {
        lastError = error;
        const providerError = error instanceof AiProviderError ? error : null;
        const retryable = providerError?.retryable ?? false;
        if (!retryable || attempt === ai.maxRetries) break;
        this.logger.warn(
          `AI 调用失败将重试（第 ${attempt + 2} 次，共 ${ai.maxRetries + 1} 次）provider=${provider.name} code=${providerError?.code}`,
        );
        await backoff(attempt);
      }
    }
    throw lastError;
  }

  private async failTask(
    id: string,
    error: AiProviderError | null,
    retryCount: number,
    fallbackReason?: string,
  ): Promise<void> {
    await this.prisma.aiTask.update({
      where: { id },
      data: {
        status: 'FAILED',
        errorCode: error?.code ?? 'UNKNOWN',
        errorMessage: truncate(error?.message ?? '未知错误', 1000),
        retryCount,
        fallbackReason: fallbackReason ?? null,
        finishedAt: new Date(),
      },
    });
  }

  /**
   * 各 Provider 支持的模型名前缀。
   *
   * 为什么需要这层本地校验：模型名配错时，上游只会回一个笼统的
   * `BAD_REQUEST：请求参数或模型名不被接受`，然后系统降级到 mock ——
   * 从界面上看像是「AI 不稳定」，实际是配置写错了厂商的型号
   * （本项目就发生过：provider 切成 deepseek，数据库模板里还留着 gpt-4o-mini）。
   * 在发请求前先判定，能直接指出「哪个 Provider 该配什么」，省掉一轮猜测。
   *
   * mock 不限制模型名：它本来就不请求外部服务，写什么都能跑。
   */
  private static readonly PROVIDER_MODEL_HINTS: Record<string, string[]> = {
    openai: ['gpt-', 'o1', 'o3', 'o4'],
    deepseek: ['deepseek-'],
    anthropic: ['claude-'],
    gemini: ['gemini-'],
  };

  /** 校验模型名与当前 Provider 是否匹配，不匹配时给出可操作的错误 */
  private assertModelMatchesProvider(model: string, providerName: string): void {
    const hints = AiTaskService.PROVIDER_MODEL_HINTS[providerName];
    if (!hints) return; // mock 或未知 provider：不校验
    if (hints.some((hint) => model.toLowerCase().startsWith(hint))) return;

    throw new BusinessException(
      'AI_MODEL_PROVIDER_MISMATCH',
      `当前 AI_PROVIDER=${providerName}，但模板使用的模型是「${model}」，两者不匹配。` +
        `请把模板的模型名改为 ${providerName} 支持的型号（前缀应为 ${hints.join(' / ')}），` +
        `或在 .env 中调整 AI_PROVIDER。注意：提示词模板里的模型名优先级高于 AI_DEFAULT_MODEL。`,
      422,
      { provider: providerName, model, expectedPrefixes: hints },
    );
  }

  /** 把 Provider 错误翻译成合适的 HTTP 语义，让前端能给出可操作的提示 */
  private toHttpError(error: AiProviderError | null): Error {
    if (!error) return new UpstreamUnavailableException('AI 服务');
    switch (error.code) {
      case 'RATE_LIMITED':
        return new RateLimitedException('AI 服务触发限流，请稍后重试');
      case 'NOT_CONFIGURED':
      case 'AUTH_FAILED':
        return new BusinessException(
          'AI_PROVIDER_UNAVAILABLE',
          `AI 服务凭证不可用：${error.message}。请管理员检查 AI_PROVIDER 与对应 API Key 配置`,
          503,
        );
      case 'TIMEOUT':
        return new UpstreamUnavailableException('AI 服务（请求超时）', { code: error.code });
      default:
        return new UpstreamUnavailableException('AI 服务', { code: error.code, message: error.message });
    }
  }

  private async loadActiveTemplate(taskType: AiTaskType, _user: AuthUser) {
    // 灰度：rolloutPercent < 100 的模板只在部分流量上生效。
    // 用「模板 id 哈希 + 任务数」做确定性分流，便于对比效果而不引入随机性带来的不可复现问题。
    const templates = await this.prisma.promptTemplate.findMany({
      where: { key: templateKeyOf(taskType), isActive: true },
      orderBy: { version: 'desc' },
      take: 5,
    });
    const template = templates.find((item) => item.rolloutPercent >= 100) ?? templates[0];
    if (!template) {
      throw new BusinessException(
        'PROMPT_TEMPLATE_MISSING',
        `未找到任务类型「${AI_TASK_TYPE_LABELS[taskType]}」的可用 Prompt 模板（key=${templateKeyOf(taskType)}），请先在 AI 模板管理中创建`,
        503,
      );
    }
    return template;
  }

  private toView(
    row: Prisma.AiTaskGetPayload<{ include: { requestedBy: { select: { name: true } } } }>,
  ): AiTaskView {
    return {
      id: row.id,
      taskType: row.taskType,
      taskTypeLabel: AI_TASK_TYPE_LABELS[row.taskType],
      status: row.status,
      statusLabel: AI_TASK_STATUS_LABELS[row.status],
      provider: row.provider,
      model: row.model,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      totalTokens: row.totalTokens,
      costCents: row.costCents,
      costYuan: (row.costCents / 100).toFixed(4),
      latencyMs: row.latencyMs,
      retryCount: row.retryCount,
      fallbackReason: row.fallbackReason,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      humanFeedback: row.humanFeedback,
      feedbackNote: row.feedbackNote,
      output: row.output,
      input: row.input,
      creatorId: row.creatorId,
      requestedByName: row.requestedBy?.name ?? null,
      createdAt: row.createdAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
    };
  }
}

/** 任务类型 → 模板 key 的映射。一个任务类型对应一族模板（可多版本灰度） */
export function templateKeyOf(taskType: AiTaskType): string {
  const map: Record<AiTaskType, string> = {
    SCRIPT_GENERATE: 'script.generate',
    TITLE_OPTIMIZE: 'title.optimize',
    CREATOR_MATCH: 'creator.match',
    COMMENT_INSIGHT: 'comment.insight',
    COMPLIANCE_CHECK: 'content.compliance',
    SETTLEMENT_ANOMALY: 'settlement.anomaly',
    DAILY_BRIEF: 'ops.daily_brief',
  };
  return map[taskType];
}

/** 成本换算：分（整数），避免浮点累积误差 */
export function calculateCostCents(promptTokens: number, completionTokens: number): number {
  const inputCny = (promptTokens / 1000) * ai.costPer1kInputTokens;
  const outputCny = (completionTokens / 1000) * ai.costPer1kOutputTokens;
  return Math.round((inputCny + outputCny) * 100);
}

/** 仅用于预算预检的粗估：按「输入全走 input 价 + 输出上限走 output 价」保守估算 */
export function estimateCostCny(estimatedTokens: number): number {
  return (estimatedTokens / 1000) * Math.max(ai.costPer1kInputTokens, ai.costPer1kOutputTokens);
}

/** 粗估 token：中文 1 字 ≈ 1 token，其他字符 ≈ 1/4 token */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const chinese = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  return Math.ceil(chinese + (text.length - chinese) / 4);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…（已截断）` : text;
}
