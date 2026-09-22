import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AiTaskType, Prisma } from '@prisma/client';
import {
  BusinessException,
  DuplicateOperationException,
  ResourceNotFoundException,
} from '../../common/exceptions/business.exception';
import { buildPaginated, PaginatedResult } from '../../common/utils/pagination';
import { env } from '../../config';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import { CreatePromptTemplateDto, QueryPromptTemplateDto, UpdatePromptTemplateDto } from './dto/ai.dto';
import { templateKeyOf } from './ai-task.service';

/**
 * Prompt 模板服务。
 *
 * 为什么把 Prompt 放进数据库而不是硬编码在代码里：
 *   Prompt 是运营资产，迭代频率远高于代码。放库里可以做三件事：
 *     1) 版本化：每次修改留档，效果变差可一键回滚（version 单调递增）；
 *     2) 灰度：rolloutPercent 控制灰度比例，先小流量验证再全量；
 *     3) 无发布迭代：运营自己改 Prompt，不用等研发排期上线。
 *
 * 初始化策略：首次启动时若库里没有模板，自动写入内置默认模板（幂等，已存在则不动）。
 * 这样新环境开箱即用，且不会覆盖运营已经调优过的模板。
 */
@Injectable()
export class PromptTemplateService implements OnModuleInit {
  private readonly logger = new Logger(PromptTemplateService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.seedDefaultTemplates();
    } catch (error) {
      // 模板初始化失败不应阻止服务启动（可能只是数据库还没迁移完）
      this.logger.error(
        'Prompt 模板初始化失败，AI 功能可能不可用',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  async list(query: QueryPromptTemplateDto): Promise<PaginatedResult<PromptTemplateView>> {
    const where: Prisma.PromptTemplateWhereInput = {
      key: query.key,
      isActive: query.isActive,
      OR: query.keyword
        ? [
            { name: { contains: query.keyword, mode: 'insensitive' } },
            { key: { contains: query.keyword, mode: 'insensitive' } },
          ]
        : undefined,
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.promptTemplate.findMany({
        where,
        // 同一 key 的多个版本按版本倒序，前端分组展示
        orderBy: [{ key: 'asc' }, { version: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.promptTemplate.count({ where }),
    ]);

    return buildPaginated(rows.map(toView), total, query.page, query.pageSize);
  }

  async findOne(id: string): Promise<PromptTemplateView> {
    const template = await this.prisma.promptTemplate.findUnique({ where: { id } });
    if (!template) throw new ResourceNotFoundException('Prompt 模板');
    return toView(template);
  }

  /**
   * 新建模板版本。
   * 若同名 key 已存在，则 version 自动 +1（而不是报冲突）——
   * 版本化是默认行为，避免运营为了改一句话还要先手动改版本号或删旧版本。
   */
  async create(user: AuthUser, dto: CreatePromptTemplateDto): Promise<PromptTemplateView> {
    const latest = await this.prisma.promptTemplate.findFirst({
      where: { key: dto.key },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const version = dto.version ?? (latest ? latest.version + 1 : 1);

    const duplicated = await this.prisma.promptTemplate.findUnique({
      where: { key_version: { key: dto.key, version } },
      select: { id: true },
    });
    if (duplicated) {
      throw new DuplicateOperationException(`模板 ${dto.key} 的 v${version} 版本已存在`);
    }

    const created = await this.prisma.promptTemplate.create({
      data: {
        key: dto.key,
        version,
        name: dto.name,
        description: dto.description ?? null,
        systemPrompt: dto.systemPrompt,
        userPromptTemplate: dto.userPromptTemplate,
        // 先序列化再写库：PromptVariableDto[] 是「有具体形状的类实例」，
        // 而 Prisma 的 InputJsonValue 要求对象带 string 索引签名，两者不兼容。
        // 通过 JSON 往返转成纯对象，是最直观且不丢类型的做法。
        variables: toJsonValue(dto.variables ?? []),
        outputSchema: dto.outputSchema === undefined ? undefined : toJsonValue(dto.outputSchema),
        model: dto.model,
        temperature: dto.temperature?.toFixed(2) ?? '0.70',
        maxTokens: dto.maxTokens ?? 2048,
        isActive: dto.isActive ?? true,
        rolloutPercent: dto.rolloutPercent ?? 100,
        createdById: user.id,
      },
    });
    this.logger.log(`新建 Prompt 模板 key=${dto.key} v${version} by=${user.email}`);
    return toView(created);
  }

  /**
   * 更新模板。
   * 关键约束：**已产生过任务执行的模板不允许就地修改**，必须新建版本。
   * 否则历史任务记录的 templateId 仍指向同一行，会导致「同一模板 id 对应两套 Prompt」，
   * 事后复盘时无法确定当时到底用了什么 Prompt。
   */
  async update(user: AuthUser, id: string, dto: UpdatePromptTemplateDto): Promise<PromptTemplateView> {
    const existing = await this.prisma.promptTemplate.findUnique({ where: { id } });
    if (!existing) throw new ResourceNotFoundException('Prompt 模板');

    const usedCount = await this.prisma.aiTask.count({ where: { templateId: id } });
    const changesContent =
      dto.systemPrompt !== undefined || dto.userPromptTemplate !== undefined;
    if (usedCount > 0 && changesContent) {
      throw new BusinessException(
        'PROMPT_IMMUTABLE',
        `该模板已被 ${usedCount} 次 AI 任务使用，为保证历史可追溯不可就地修改 Prompt 内容。请新建版本（version 会自动 +1）`,
        409,
        { usedCount, suggestion: 'POST /api/ai/prompts 新建版本' },
      );
    }

    const updated = await this.prisma.promptTemplate.update({
      where: { id },
      data: {
        name: dto.name,
        description: dto.description,
        systemPrompt: dto.systemPrompt,
        userPromptTemplate: dto.userPromptTemplate,
        variables: dto.variables === undefined ? undefined : toJsonValue(dto.variables),
        outputSchema: dto.outputSchema === undefined ? undefined : toJsonValue(dto.outputSchema),
        model: dto.model,
        temperature: dto.temperature?.toFixed(2),
        maxTokens: dto.maxTokens,
        isActive: dto.isActive,
        rolloutPercent: dto.rolloutPercent,
      },
    });
    this.logger.log(`更新 Prompt 模板 key=${updated.key} v${updated.version} by=${user.email}`);
    return toView(updated);
  }

  /** 启用/停用。停用是「下线」而不是「删除」，保留历史引用 */
  async toggle(user: AuthUser, id: string, isActive: boolean): Promise<PromptTemplateView> {
    const existing = await this.prisma.promptTemplate.findUnique({ where: { id } });
    if (!existing) throw new ResourceNotFoundException('Prompt 模板');
    if (!isActive) {
      const activeCount = await this.prisma.promptTemplate.count({
        where: { key: existing.key, isActive: true },
      });
      if (activeCount <= 1) {
        throw new BusinessException(
          'PROMPT_LAST_ACTIVE',
          `「${existing.key}」只剩这一个启用版本，停用后该任务类型将无模板可用`,
          409,
        );
      }
    }
    const updated = await this.prisma.promptTemplate.update({
      where: { id },
      data: { isActive },
    });
    this.logger.log(
      `Prompt 模板 ${isActive ? '启用' : '停用'} key=${existing.key} v${existing.version} by=${user.email}`,
    );
    return toView(updated);
  }

  /** 幂等写入内置默认模板：仅当该 key 不存在任何版本时才写 */
  async seedDefaultTemplates(): Promise<{ created: number }> {
    let created = 0;
    for (const [taskType, seed] of Object.entries(DEFAULT_TEMPLATES) as Array<
      [AiTaskType, DefaultTemplateSeed]
    >) {
      const key = templateKeyOf(taskType);
      const exists = await this.prisma.promptTemplate.findFirst({
        where: { key },
        select: { id: true },
      });
      if (exists) continue;
      await this.prisma.promptTemplate.create({
        data: {
          key,
          version: 1,
          name: seed.name,
          description: seed.description,
          systemPrompt: seed.systemPrompt,
          userPromptTemplate: seed.userPromptTemplate,
          variables: toJsonValue(seed.variables),
          // 模型名取当前环境配置，而不是写死某个厂商的型号。
          //
          // 这里曾经硬编码 'gpt-4o-mini'，后果是：把 AI_PROVIDER 换成 deepseek 后，
          // 数据库里的模板仍带着 gpt-4o-mini，请求被上游以 BAD_REQUEST 拒绝，
          // 而 AI_DEFAULT_MODEL 只在「找不到模板」时才兜底，所以改它完全无效——
          // 表现为「provider 明明切了，模型还是旧的」，排查时极易误判成配置没生效。
          model: env.AI_DEFAULT_MODEL,
          temperature: seed.temperature.toFixed(2),
          maxTokens: seed.maxTokens,
          isActive: true,
          rolloutPercent: 100,
        },
      });
      created += 1;
    }
    if (created > 0) this.logger.log(`已初始化 ${created} 个内置 Prompt 模板`);
    return { created };
  }
}

export interface PromptTemplateView {
  id: string;
  key: string;
  version: number;
  name: string;
  description: string | null;
  systemPrompt: string;
  userPromptTemplate: string;
  variables: unknown;
  outputSchema: unknown;
  model: string;
  temperature: number;
  maxTokens: number;
  isActive: boolean;
  rolloutPercent: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * 把任意可序列化值转成 Prisma 的 JSON 字段类型。
 *
 * 为什么需要它：Java/TS 的「类实例」在类型层面不具备 string 索引签名，
 * 直接 `as Prisma.InputJsonValue` 会被 TS 判定为不充分重叠（TS2352）而报错。
 * 走一次 JSON 序列化既能拿到纯对象，又能在运行时剔除 undefined / 函数等非法值
 * （Prisma 对 JSON 字段里的 undefined 会直接抛错）。
 */
function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function toView(row: {
  id: string;
  key: string;
  version: number;
  name: string;
  description: string | null;
  systemPrompt: string;
  userPromptTemplate: string;
  variables: Prisma.JsonValue;
  outputSchema: Prisma.JsonValue | null;
  model: string;
  temperature: Prisma.Decimal;
  maxTokens: number;
  isActive: boolean;
  rolloutPercent: number;
  createdAt: Date;
  updatedAt: Date;
}): PromptTemplateView {
  return {
    id: row.id,
    key: row.key,
    version: row.version,
    name: row.name,
    description: row.description,
    systemPrompt: row.systemPrompt,
    userPromptTemplate: row.userPromptTemplate,
    variables: row.variables,
    outputSchema: row.outputSchema,
    model: row.model,
    temperature: Number(row.temperature),
    maxTokens: row.maxTokens,
    isActive: row.isActive,
    rolloutPercent: row.rolloutPercent,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface DefaultTemplateSeed {
  name: string;
  description: string;
  systemPrompt: string;
  userPromptTemplate: string;
  variables: Array<{ name: string; required: boolean; description: string; maxLength?: number }>;
  temperature: number;
  maxTokens: number;
}

/**
 * 内置默认模板。
 * 编写规范（项目 AI 规范的一部分，见 docs/ai-guidelines.md）：
 *   1) 角色设定 + 硬性约束 + 输出格式三件套齐全；
 *   2) 明确禁止事项（如绝对化用语、编造数据），降低合规风险；
 *   3) 要求「不确定就说不确定」，而不是编造——这是内部工具最重要的质量约束；
 *   4) 输出统一 JSON，字段名与后端 zod schema 严格一致。
 */
export const DEFAULT_TEMPLATES: Record<AiTaskType, DefaultTemplateSeed> = {
  SCRIPT_GENERATE: {
    name: '短视频脚本生成',
    description: '根据内容 brief 生成可直接拍摄的分镜脚本，输出含钩子、分镜时间轴、话题标签与风险提示',
    systemPrompt: [
      '你是聚猩智媒的资深短视频编导，服务过大量剧情类与达人带货类内容，熟悉抖音、小红书、视频号的完播率规律。',
      '硬性要求：',
      '1) 开场 3 秒必须给出强钩子，禁止无效铺垫；',
      '2) 分镜需标注时间区间、景别/运镜、口播文案与拍摄提示；',
      '3) 禁止使用「最」「第一」「绝对」「国家级」等广告法违禁的绝对化用语；',
      '4) 不得编造产品功效、数据或资质；信息不足时在 risks 中说明需要补充什么；',
      '5) 只输出 JSON，不要输出任何解释性文字或 Markdown 代码块标记。',
    ].join('\n'),
    userPromptTemplate: [
      '请为以下需求生成短视频脚本。',
      '内容简述：{{brief}}',
      '内容垂类：{{vertical}}',
      '目标平台：{{platform}}',
      '目标时长（秒）：{{duration}}',
      '语气风格：{{tone}}',
      '{{creatorProfile}}',
      '',
      '输出 JSON，字段要求：',
      '{',
      '  "title": "视频标题",',
      '  "hook": "开场钩子的设计说明",',
      '  "structure": "整体结构概览",',
      '  "scenes": [{"index": 1, "timeRange": "0-3s", "shot": "景别与运镜", "voiceover": "口播/字幕文案", "note": "拍摄提示"}],',
      '  "hashtags": ["#话题"],',
      '  "risks": ["需要主创注意的合规或执行风险"]',
      '}',
    ].join('\n'),
    variables: [
      { name: 'brief', required: true, description: '内容需求简述', maxLength: 1500 },
      { name: 'vertical', required: false, description: '内容垂类', maxLength: 32 },
      { name: 'platform', required: false, description: '目标平台', maxLength: 32 },
      { name: 'duration', required: false, description: '目标时长秒数', maxLength: 8 },
      { name: 'tone', required: false, description: '语气风格', maxLength: 64 },
      { name: 'creatorProfile', required: false, description: '达人画像与历史表现补充', maxLength: 1500 },
    ],
    temperature: 0.8,
    maxTokens: 2600,
  },

  TITLE_OPTIMIZE: {
    name: '标题与封面文案优化',
    description: '基于原始标题生成多个候选标题并给出理由与预期得分',
    systemPrompt: [
      '你是短视频标题优化专家，深刻理解点击率与完播率的关系。',
      '要求：',
      '1) 生成 3-5 个候选标题，覆盖不同策略（悬念、数字、反差、利益点、人群定向）；',
      '2) 每个标题不超过 30 字，不使用绝对化用语与夸张承诺；',
      '3) 为每个候选给出简短理由与 0-100 的预期得分，并只输出 JSON。',
    ].join('\n'),
    userPromptTemplate: [
      '原始标题：{{originalTitle}}',
      '内容简述：{{brief}}',
      '目标平台：{{platform}}',
      '',
      '输出 JSON：{"candidates":[{"title":"...","reason":"...","score":88}],"keywordSuggestions":["..."]}',
    ].join('\n'),
    variables: [
      { name: 'originalTitle', required: true, description: '原标题', maxLength: 200 },
      { name: 'brief', required: false, description: '内容简述', maxLength: 1000 },
      { name: 'platform', required: false, description: '目标平台', maxLength: 32 },
    ],
    temperature: 0.8,
    maxTokens: 900,
  },

  CREATOR_MATCH: {
    name: '达人与品牌需求匹配',
    description: '从候选达人池中筛选最匹配品牌需求的达人，给出匹配理由与风险提示',
    systemPrompt: [
      '你是达人商务匹配专家，负责为品牌需求挑选最合适的合作达人。',
      '判断维度：垂类契合度、粉丝画像重合度、互动质量、历史商业内容表现、报价合理性、档期。',
      '要求：',
      '1) 只从提供的候选达人中挑选，不得虚构达人；',
      '2) 每位达人给出 0-100 匹配分、匹配理由与潜在风险；',
      '3) 若候选池整体匹配度低，必须在 strategy 中直说，不要强行推荐；',
      '4) 只输出 JSON。',
    ].join('\n'),
    userPromptTemplate: [
      '品牌需求：{{requirement}}',
      '预算区间：{{budget}}',
      '目标平台：{{platform}}',
      '目标人群：{{audience}}',
      '',
      '候选达人列表（JSON）：',
      '{{candidates}}',
      '',
      '输出 JSON：{"matches":[{"creatorId":"...","creatorName":"...","score":90,"reasons":["..."],"risks":["..."]}],"strategy":"整体投放建议"}',
    ].join('\n'),
    variables: [
      { name: 'requirement', required: true, description: '品牌需求描述', maxLength: 2000 },
      { name: 'candidates', required: true, description: '候选达人 JSON 列表', maxLength: 12000 },
      { name: 'budget', required: false, description: '预算区间', maxLength: 64 },
      { name: 'platform', required: false, description: '目标平台', maxLength: 32 },
      { name: 'audience', required: false, description: '目标人群', maxLength: 200 },
    ],
    temperature: 0.5,
    maxTokens: 1800,
  },

  COMMENT_INSIGHT: {
    name: '评论区洞察',
    description: '分析评论情感分布、核心话题与可直接使用的话术模板',
    systemPrompt: [
      '你是社群与评论区运营分析师。',
      '要求：统计情感分布（百分比之和为 100）、归纳高频话题（含出现次数与运营建议）、产出可直接复制回复的话术模板。',
      '不得编造数据，只基于给定评论内容。只输出 JSON。',
    ].join('\n'),
    userPromptTemplate: [
      '内容标题：{{title}}',
      '平台：{{platform}}',
      '评论内容：',
      '{{comments}}',
      '',
      '输出 JSON：{"sentiment":{"positive":60,"neutral":30,"negative":10},"topTopics":[{"topic":"...","count":10,"suggestion":"..."}],"replyTemplates":["..."]}',
    ].join('\n'),
    variables: [
      { name: 'comments', required: true, description: '评论原文（每行一条）', maxLength: 12000 },
      { name: 'title', required: false, description: '内容标题', maxLength: 200 },
      { name: 'platform', required: false, description: '平台', maxLength: 32 },
    ],
    temperature: 0.5,
    maxTokens: 1600,
  },

  COMPLIANCE_CHECK: {
    name: '内容合规预检',
    description: '发布前扫描脚本/文案，识别广告法与平台规则风险，给出修改建议',
    systemPrompt: [
      '你是内容合规审核专家，熟悉《广告法》《互联网广告管理办法》与主流平台内容规范。',
      '重点关注：绝对化用语、虚假或无法举证的承诺、医疗与金融等高危行业的资质要求、未成年人保护、导流与站外交易风险、素材版权。',
      '要求：',
      '1) 给出 0-100 合规分与总评级别（PASS 可直接发布 / WARN 需修改 / REJECT 不可发布）；',
      '2) 每条风险必须给出原文片段、依据原因与具体改写建议；',
      '3) 只做风险提示，不代替法务出具正式意见，需在 summary 中说明这一点；',
      '4) 只输出 JSON。',
    ].join('\n'),
    userPromptTemplate: [
      '内容类型：{{contentType}}',
      '目标平台：{{platform}}',
      '待审内容：',
      '{{content}}',
      '',
      '输出 JSON：{"score":75,"level":"WARN","flags":[{"level":"WARN","category":"绝对化用语","snippet":"原文片段","reason":"违规原因","suggestion":"修改建议"}],"summary":"总体结论"}',
    ].join('\n'),
    variables: [
      { name: 'content', required: true, description: '待审内容原文', maxLength: 12000 },
      { name: 'contentType', required: false, description: '内容类型', maxLength: 32 },
      { name: 'platform', required: false, description: '目标平台', maxLength: 32 },
    ],
    temperature: 0.1,
    maxTokens: 1600,
  },

  SETTLEMENT_ANOMALY: {
    name: '结算异常解释',
    description: '用业务语言解释结算金额波动原因，供运营向达人沟通时使用',
    systemPrompt: [
      '你是结算分析师，负责用运营和达人都能听懂的语言解释金额变化。',
      '要求：',
      '1) 结论先行，直接回答「为什么金额变了」；',
      '2) 只用提供的数据作为证据，逐条列出，不得推测未提供的信息；',
      '3) 如果数据显示计算可能有误（明细与总额不符、比率异常），必须明确指出并建议人工复核；',
      '4) 给出可直接发给达人的沟通建议；',
      '5) 只输出 JSON。',
    ].join('\n'),
    userPromptTemplate: [
      '达人：{{creatorName}}',
      '账期：{{period}}',
      '结算汇总（JSON）：',
      '{{settlementSummary}}',
      '',
      '明细（JSON）：',
      '{{settlementItems}}',
      '',
      '对比账期汇总（JSON，可为空）：',
      '{{previousSummary}}',
      '',
      '疑问：{{question}}',
      '',
      '输出 JSON：{"conclusion":"...","evidence":["..."],"suggestion":"...","needManualReview":false}',
    ].join('\n'),
    variables: [
      { name: 'settlementSummary', required: true, description: '本期结算汇总 JSON', maxLength: 6000 },
      { name: 'settlementItems', required: false, description: '结算明细 JSON', maxLength: 12000 },
      { name: 'creatorName', required: false, description: '达人名称', maxLength: 64 },
      { name: 'period', required: false, description: '账期', maxLength: 32 },
      { name: 'previousSummary', required: false, description: '上期汇总 JSON', maxLength: 4000 },
      { name: 'question', required: false, description: '具体疑问', maxLength: 500 },
    ],
    temperature: 0.1,
    maxTokens: 1600,
  },

  DAILY_BRIEF: {
    name: '运营日报摘要',
    description: '把当日业务数据概括成人可读的日报，突出异常与次日重点',
    systemPrompt: [
      '你是运营负责人，为团队写每日简报。',
      '要求：',
      '1) headline 一句话概括今日整体情况；',
      '2) highlights 只写有信息量的进展（带具体数字），不写套话；',
      '3) risks 指出需要立刻关注的问题（合同到期、结算异常、内容驳回等）；',
      '4) tomorrowFocus 给出 3 条以内可执行的次日重点；',
      '5) 不得编造数据，只使用提供的数据；只输出 JSON。',
    ].join('\n'),
    userPromptTemplate: [
      '统计日期：{{date}}',
      '业务数据（JSON）：',
      '{{metrics}}',
      '',
      '输出 JSON：{"headline":"...","highlights":["..."],"risks":["..."],"tomorrowFocus":["..."]}',
    ].join('\n'),
    variables: [
      { name: 'metrics', required: true, description: '当日业务数据 JSON', maxLength: 8000 },
      { name: 'date', required: false, description: '统计日期', maxLength: 32 },
    ],
    temperature: 0.5,
    maxTokens: 1400,
  },
};
