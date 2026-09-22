import { api, buildParams } from './client';
import type {
  AssignCreatorRequest,
  BatchImportRequest,
  BatchImportResult,
  CreateCreatorRequest,
  CreatorDetail,
  CreatorListQuery,
  CreatorListItem,
  DeleteResponse,
  EvaluateCreatorRequest,
  Paginated,
  UpdateCreatorRequest,
  UpdateCreatorStatusRequest,
} from './types';

/** 达人主数据接口。列表查询参数由 buildParams 统一清洗，页面只传业务字段。 */

export function listCreators(query: CreatorListQuery): Promise<Paginated<CreatorListItem>> {
  return api.get<Paginated<CreatorListItem>>('/creators', buildParams(query));
}

export function getCreator(id: string): Promise<CreatorDetail> {
  return api.get<CreatorDetail>(`/creators/${id}`);
}

export function createCreator(body: CreateCreatorRequest): Promise<CreatorDetail> {
  return api.post<CreatorDetail>('/creators', body);
}

/** 注意：更新不允许改 status，状态流转必须走 updateCreatorStatus 以留下审计原因 */
export function updateCreator(id: string, body: UpdateCreatorRequest): Promise<CreatorDetail> {
  return api.patch<CreatorDetail>(`/creators/${id}`, body);
}

export function updateCreatorStatus(
  id: string,
  body: UpdateCreatorStatusRequest,
): Promise<CreatorDetail> {
  return api.patch<CreatorDetail>(`/creators/${id}/status`, body);
}

export function evaluateCreator(
  id: string,
  body: EvaluateCreatorRequest,
): Promise<CreatorDetail> {
  return api.post<CreatorDetail>(`/creators/${id}/evaluate`, body);
}

export function assignCreator(id: string, body: AssignCreatorRequest): Promise<CreatorDetail> {
  return api.post<CreatorDetail>(`/creators/${id}/assign`, body);
}

export function deleteCreator(id: string): Promise<DeleteResponse> {
  return api.delete<DeleteResponse>(`/creators/${id}`);
}

export function batchImportCreators(body: BatchImportRequest): Promise<BatchImportResult> {
  return api.post<BatchImportResult>('/creators/batch-import', body);
}
