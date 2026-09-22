import { api, buildParams } from './client';
import type {
  ContentDetail,
  ContentListQuery,
  ContentListItem,
  CreateContentRequest,
  Paginated,
  PublishContentRequest,
  ReviewContentRequest,
  UpdateContentRequest,
} from './types';

/**
 * 内容接口。
 *
 * 互动数据（播放/点赞/评论/转发）都是字符串，因为大 V 单条视频播放量可能超过
 * JS 安全整数范围，后端统一按字符串下发，前端只格式化不参与运算。
 */

export function listContents(query: ContentListQuery): Promise<Paginated<ContentListItem>> {
  return api.get<Paginated<ContentListItem>>('/contents', buildParams(query));
}

export function getContent(id: string): Promise<ContentDetail> {
  return api.get<ContentDetail>(`/contents/${id}`);
}

export function createContent(body: CreateContentRequest): Promise<ContentDetail> {
  return api.post<ContentDetail>('/contents', body);
}

export function updateContent(id: string, body: UpdateContentRequest): Promise<ContentDetail> {
  return api.patch<ContentDetail>(`/contents/${id}`, body);
}

export function submitContentReview(id: string): Promise<ContentDetail> {
  return api.post<ContentDetail>(`/contents/${id}/submit-review`);
}

export function reviewContent(id: string, body: ReviewContentRequest): Promise<ContentDetail> {
  return api.post<ContentDetail>(`/contents/${id}/review`, body);
}

export function publishContent(id: string, body: PublishContentRequest = {}): Promise<ContentDetail> {
  return api.post<ContentDetail>(`/contents/${id}/publish`, body);
}

/** 手动触发数据采集：后端可能限流，失败时按 RATE_LIMITED 文案提示 */
export function syncContentMetrics(id: string): Promise<ContentDetail> {
  return api.post<ContentDetail>(`/contents/${id}/sync-metrics`);
}
