import { api, buildParams } from './client';
import type { TagItem } from './types';

/** 标签维护：列表按 category 过滤，创建/编辑/删除后由调用方失效对应 query。 */

export function listTags(category?: string): Promise<TagItem[]> {
  return api.get<TagItem[]>('/tags', buildParams({ category }));
}

export function createTag(body: {
  name: string;
  category: string;
  color?: string;
}): Promise<TagItem> {
  return api.post<TagItem>('/tags', body);
}

export function updateTag(
  id: string,
  body: { name?: string; category?: string; color?: string },
): Promise<TagItem> {
  return api.patch<TagItem>(`/tags/${id}`, body);
}

export function deleteTag(id: string): Promise<{ id: string; deleted: true }> {
  return api.delete<{ id: string; deleted: true }>(`/tags/${id}`);
}
