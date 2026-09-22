import { api, buildParams } from './client';
import type {
  ApproveContractRequest,
  ContractDetail,
  ContractListQuery,
  ContractListItem,
  CreateContractRequest,
  Paginated,
  SettlementPreview,
  TerminateContractRequest,
  UpdateContractRequest,
} from './types';

/**
 * 合同接口。
 *
 * 提醒：合同上的四个比率都是基点整数（1000 = 10%），金额是字符串元。
 * 审批/终止后后端会写审计日志，前端只负责提示"已写入审计日志"。
 */

export function listContracts(query: ContractListQuery): Promise<Paginated<ContractListItem>> {
  return api.get<Paginated<ContractListItem>>('/contracts', buildParams(query));
}

export function getContract(id: string): Promise<ContractDetail> {
  return api.get<ContractDetail>(`/contracts/${id}`);
}

export function createContract(body: CreateContractRequest): Promise<ContractDetail> {
  return api.post<ContractDetail>('/contracts', body);
}

export function updateContract(id: string, body: UpdateContractRequest): Promise<ContractDetail> {
  return api.patch<ContractDetail>(`/contracts/${id}`, body);
}

/** 提交审核：状态由后端状态机校验，前端不判断能否提交 */
export function submitContract(id: string): Promise<ContractDetail> {
  return api.post<ContractDetail>(`/contracts/${id}/submit`);
}

export function approveContract(
  id: string,
  body: ApproveContractRequest,
): Promise<ContractDetail> {
  return api.post<ContractDetail>(`/contracts/${id}/approve`, body);
}

export function terminateContract(
  id: string,
  body: TerminateContractRequest,
): Promise<ContractDetail> {
  return api.post<ContractDetail>(`/contracts/${id}/terminate`, body);
}

/** 结算试算：按账期预览这条合同会产生多少分润，用于签前核对分润规则 */
export function previewContractSettlement(
  id: string,
  params: { periodStart: string; periodEnd: string },
): Promise<SettlementPreview> {
  return api.get<SettlementPreview>(`/contracts/${id}/settlement-preview`, buildParams(params));
}
