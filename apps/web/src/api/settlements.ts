import { api, buildParams } from './client';
import type {
  AdjustSettlementRequest,
  DisputeSettlementRequest,
  GenerateSettlementRequest,
  GenerateSettlementResult,
  Paginated,
  PaySettlementRequest,
  SettlementDetail,
  SettlementExportQuery,
  SettlementListItem,
  SettlementListQuery,
} from './types';

/**
 * 结算接口。
 *
 * 资金相关，两条铁律：
 *   1) 所有金额字段都是字符串元，前端只展示与校验，绝不本地做加减后回写；
 *   2) 生成/审批/打款都是不可逆动作，调用方必须做按钮 disabled + loading，
 *      生成接口还要带幂等语义（后端按账期去重，前端靠禁用与确认弹窗防连点）。
 */

export function listSettlements(
  query: SettlementListQuery,
): Promise<Paginated<SettlementListItem>> {
  return api.get<Paginated<SettlementListItem>>('/settlements', buildParams(query));
}

export function getSettlement(id: string): Promise<SettlementDetail> {
  return api.get<SettlementDetail>(`/settlements/${id}`);
}

export function generateSettlements(
  body: GenerateSettlementRequest,
): Promise<GenerateSettlementResult> {
  return api.post<GenerateSettlementResult>('/settlements/generate', body);
}

export function adjustSettlement(
  id: string,
  body: AdjustSettlementRequest,
): Promise<SettlementDetail> {
  return api.post<SettlementDetail>(`/settlements/${id}/adjust`, body);
}

export function approveSettlement(id: string): Promise<SettlementDetail> {
  return api.post<SettlementDetail>(`/settlements/${id}/approve`);
}

export function paySettlement(id: string, body: PaySettlementRequest = {}): Promise<SettlementDetail> {
  return api.post<SettlementDetail>(`/settlements/${id}/pay`, body);
}

export function disputeSettlement(
  id: string,
  body: DisputeSettlementRequest,
): Promise<SettlementDetail> {
  return api.post<SettlementDetail>(`/settlements/${id}/dispute`, body);
}

/**
 * 导出 CSV 文件流。
 * 该接口返回的是原始文件流而非 JSON 信封，所以走 getBlob 绕过解包逻辑。
 */
export function exportSettlements(query: SettlementExportQuery) {
  return api.getBlob('/settlements/export', buildParams(query));
}
