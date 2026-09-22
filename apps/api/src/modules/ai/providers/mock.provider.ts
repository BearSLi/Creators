import { Logger } from '@nestjs/common';
import type { AiCompletionRequest, AiCompletionResult, AiProvider } from './ai-provider.interface';

/**
 * Mock Provider：本地开发、CI、演示环境的默认实现。
 *
 * 设计要点：输出不是随便乱造，而是**按任务类型返回结构合法的确定性结果**。
 * 这样才能真正用于：
 *   - 前端联调（脚本时间轴、合规 flags 等结构必须能渲染）；
 *   - 集成测试（断言输出结构，而不依赖外部模型的不确定性）；
 *   - 客户演示（无网/无 Key 也能完整体验 AI 工作台）。
 * 确定性：同一输入必然得到同一输出（用输入哈希做种子），便于回归对比。
 */
export class MockAiProvider implements AiProvider {
  readonly name = 'mock';
  private readonly logger = new Logger(MockAiProvider.name);

  isConfigured(): boolean {
    return true;
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    const startedAt = Date.now();
    const seed = hashString(`${request.system}|${request.user}`);
    const taskType = detectTaskType(request);

    // 模拟真实网络延迟（30-120ms），让前端 loading 态、超时逻辑能被真实验证
    await new Promise((resolve) => setTimeout(resolve, 30 + (seed % 90)));

    const text = buildMockText(taskType, request, seed);
    const promptTokens = estimateTokens(request.system) + estimateTokens(request.user);
    const completionTokens = estimateTokens(text);

    this.logger.debug(`Mock 生成完成 taskType=${taskType} tokens=${promptTokens}+${completionTokens}`);

    return {
      text,
      promptTokens,
      completionTokens,
      latencyMs: Date.now() - startedAt,
      finishReason: 'stop',
      raw: { provider: 'mock', taskType, seed },
    };
  }
}

/** 从 prompt 里猜任务类型：模板渲染时会把任务类型写进 system，便于 mock 分辨 */
function detectTaskType(request: AiCompletionRequest): string {
  const haystack = `${request.system} ${request.user}`;
  const markers: Array<[string, string]> = [
    ['SCRIPT_GENERATE', '脚本'],
    ['TITLE_OPTIMIZE', '标题'],
    ['CREATOR_MATCH', '匹配'],
    ['COMMENT_INSIGHT', '评论'],
    ['COMPLIANCE_CHECK', '合规'],
    ['SETTLEMENT_ANOMALY', '结算'],
    ['DAILY_BRIEF', '日报'],
  ];
  for (const [type, marker] of markers) {
    if (haystack.includes(marker)) return type;
  }
  return 'GENERIC';
}

function buildMockText(taskType: string, request: AiCompletionRequest, seed: number): string {
  const brief = extractField(request.user, 'brief') || extractField(request.user, '内容简述') || '未提供简述';
  const platform = extractField(request.user, 'platform') || 'DOUYIN';
  const duration = Number.parseInt(extractField(request.user, 'duration') || '60', 10) || 60;

  switch (taskType) {
    case 'SCRIPT_GENERATE':
      return JSON.stringify(
        {
          title: `【Mock】${brief.slice(0, 18)}｜3 秒钩子开场`,
          hook: `开场 0-3 秒用反差提问抓住注意力：「${brief.slice(0, 12)}，你真的做对了吗？」`,
          structure: '钩子(3s) → 冲突(10s) → 转折(15s) → 高潮(20s) → 引导互动(5s)',
          scenes: [
            {
              index: 1,
              timeRange: '0-3s',
              shot: '特写 + 手持推近',
              voiceover: `别再踩这个坑了，${brief.slice(0, 10)}的秘密今天全说清。`,
              note: '前 3 秒必须出现人物面部与情绪冲突，完播率关键位',
            },
            {
              index: 2,
              timeRange: '3-13s',
              shot: '中景对话 + 字幕强调',
              voiceover: '我以前也是这样，直到发现这个方法。',
              note: '建立共鸣，字幕字号加大',
            },
            {
              index: 3,
              timeRange: `13-${Math.max(duration - 5, 20)}s`,
              shot: '分屏对比演示',
              voiceover: '三步走：第一步先对齐人群，第二步换掉开场，第三步埋互动钩子。',
              note: '信息密度最高段落，每 5 秒一个画面变化',
            },
            {
              index: 4,
              timeRange: `${Math.max(duration - 5, 20)}-${duration}s`,
              shot: '正面特写收尾',
              voiceover: '你踩过哪个坑？评论区告诉我。',
              note: '引导评论，提升互动率',
            },
          ],
          hashtags: ['#内容运营', '#达人合作', `#${platform}`, '#干货分享'],
          risks: ['避免使用绝对化用语（如「最」「第一」）', '演示数据需标注为示例，避免误导'],
          estimatedDurationSec: duration,
          mock: true,
          seed,
        },
        null,
        2,
      );

    case 'TITLE_OPTIMIZE':
      return JSON.stringify(
        {
          candidates: [
            { title: `${brief.slice(0, 16)}｜90% 的人都做错了`, reason: '数字+反差，点击驱动强', score: 88 },
            { title: `做${brief.slice(0, 10)}之前，先看这 3 条`, reason: '明确利益点，适合知识类', score: 84 },
            { title: `我用 30 天验证了${brief.slice(0, 10)}`, reason: '真实经历，信任感强', score: 80 },
          ],
          keywordSuggestions: ['怎么做', '避坑', '实测', '复盘'],
          mock: true,
          seed,
        },
        null,
        2,
      );

    case 'CREATOR_MATCH':
      return JSON.stringify(
        {
          matches: [
            {
              creatorId: 'mock-creator-1',
              creatorName: '示例达人A',
              score: 92,
              reasons: ['垂类高度匹配（短剧/剧情）', '近 30 天互动率高于同层级均值', '档期可用'],
              risks: ['历史内容偏情感向，需确认品牌调性'],
            },
            {
              creatorId: 'mock-creator-2',
              creatorName: '示例达人B',
              score: 85,
              reasons: ['粉丝画像与目标人群重合度高', '报价在预算区间内'],
              risks: ['近期有竞品合作，需确认排他条款'],
            },
          ],
          strategy: '优先触达匹配度 85 分以上达人，建议先小批量试投 3 位验证转化',
          mock: true,
          seed,
        },
        null,
        2,
      );

    case 'COMPLIANCE_CHECK':
      return JSON.stringify(
        {
          score: 72,
          level: 'WARN',
          flags: [
            {
              level: 'WARN',
              category: '绝对化用语',
              snippet: extractField(request.user, 'content')?.slice(0, 20) || '示例片段',
              reason: '广告法禁止使用「最」「第一」等绝对化表述',
              suggestion: '改为「较优」「领先」等可举证的表述',
            },
            {
              level: 'INFO',
              category: '素材授权',
              snippet: '背景音乐',
              reason: '需确认 BGM 已获商用授权',
              suggestion: '使用平台商用曲库或已购授权音乐',
            },
          ],
          summary: '整体可通过，但需修改绝对化用语后再发布',
          mock: true,
          seed,
        },
        null,
        2,
      );

    case 'COMMENT_INSIGHT':
      return JSON.stringify(
        {
          sentiment: { positive: 62, neutral: 28, negative: 10 },
          topTopics: [
            { topic: '求同款链接', count: 34, suggestion: '置顶评论挂商品卡' },
            { topic: '质疑真实性', count: 12, suggestion: '补充过程素材或实测数据' },
          ],
          replyTemplates: ['感谢支持，链接放在置顶啦～', '这个问题很好，我下次专门做一期讲'],
          mock: true,
          seed,
        },
        null,
        2,
      );

    case 'SETTLEMENT_ANOMALY':
      return JSON.stringify(
        {
          conclusion: '本月应打款金额下降主要来自两条内容的平台抽成口径变化，非计算错误',
          evidence: [
            '内容 A 流水下降 32%，原因是发布集中在月末，有效计费天数减少',
            '合同平台费率为 10%，与上月一致，未发生变更',
            '代扣税率 6% 未变，达人分成比例命中第二档阶梯',
          ],
          suggestion: '建议与达人沟通：本月改为按发布日归因，下月会回归正常水平',
          mock: true,
          seed,
        },
        null,
        2,
      );

    case 'DAILY_BRIEF':
      return JSON.stringify(
        {
          headline: '今日运营概况（Mock 数据）',
          highlights: [
            '新增线索达人 6 位，其中 2 位已进入评估',
            '3 条内容通过平台审核并发布',
            '1 张结算单待审批，金额较大需财务确认',
          ],
          risks: ['2 份合同将在 15 天内到期，需提前沟通续约'],
          tomorrowFocus: ['跟进头部达人续约', '完成本月结算单审批'],
          mock: true,
          seed,
        },
        null,
        2,
      );

    default:
      return JSON.stringify(
        {
          result: `【Mock 输出】已根据输入生成示例内容（${brief.slice(0, 20)}）。当前 AI_PROVIDER=mock，配置真实厂商 Key 后可获得实际模型输出。`,
          mock: true,
          seed,
        },
        null,
        2,
      );
  }
}

/** 从「key: value」形式的 prompt 文本中提取字段，用于让 mock 输出与输入相关 */
function extractField(text: string, key: string): string | null {
  const pattern = new RegExp(`${key}\\s*[:：]\\s*(.+)`, 'i');
  const match = pattern.exec(text);
  return match?.[1]?.trim().slice(0, 200) ?? null;
}

/** 粗估 token：中文约 1 字 ≈ 1 token，英文约 4 字符 ≈ 1 token。仅用于 mock 的成本演示 */
function estimateTokens(text: string): number {
  if (!text) return 0;
  const chinese = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  const others = text.length - chinese;
  return Math.max(1, Math.ceil(chinese + others / 4));
}

/** 稳定哈希（FNV-1a），仅用于让 mock 结果可复现，不用于安全场景 */
export function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
