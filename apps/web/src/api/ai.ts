import { api, buildParams } from './client';
import type {
  AiPromptTemplate,
  AiTaskFeedbackRequest,
  AiTaskListItem,
  AiTaskListQuery,
  AiUsage,
  CreateAiTaskRequest,
  Paginated,
  UpsertAiPromptRequest,
} from './types';

/**
 * AI 接口。
 *
 * 成本与幂等是这里的重点：
 *   - 每次调用都会计入 token 成本，所以调用方必须带 idempotencyKey（前端用 crypto.randomUUID()），
 *     网络抖动重试或用户连点都不会重复计费；
 *   - usage 用于在界面上展示当月预算消耗，让使用者对"这条脚本花了多少钱"有感知。
 */

export function listAiTasks(query: AiTaskListQuery = {}): Promise<Paginated<AiTaskListItem>> {
  return api.get<Paginated<AiTaskListItem>>('/ai/tasks', buildParams(query));
}

export function getAiTask(id: string): Promise<AiTaskListItem> {
  return api.get<AiTaskListItem>(`/ai/tasks/${id}`);
}

export function createAiTask(body: CreateAiTaskRequest): Promise<AiTaskListItem> {
  return api.post<AiTaskListItem>('/ai/tasks', body);
}

export function submitAiFeedback(
  id: string,
  body: AiTaskFeedbackRequest,
): Promise<AiTaskListItem> {
  // 采纳/拒绝反馈会进入模型效果评估，同样需要写审计
  return api.post<AiTaskListItem>(`/ai/tasks/${id}/feedback`, body);
}

export function listAiPrompts(): Promise<AiPromptTemplate[]> {
  return api.get<AiPromptTemplate[]>('/ai/prompts');
}

export function createAiPrompt(body: UpsertAiPromptRequest): Promise<AiPromptTemplate> {
  return api.post<AiPromptTemplate>('/ai/prompts', body);
}

export function updateAiPrompt(
  id: string,
  body: Partial<UpsertAiPromptRequest>,
): Promise<AiPromptTemplate> {
  return api.patch<AiPromptTemplate>(`/ai/prompts/${id}`, body);
}

export function getAiUsage(params: { year?: number; month?: number } = {}): Promise<AiUsage> {
  return api.get<AiUsage>('/ai/usage', buildParams(params));
}
