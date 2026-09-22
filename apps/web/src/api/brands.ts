import { api, buildParams } from './client';
import type { BrandListItem, BrandListQuery, Paginated, UpsertBrandRequest } from './types';

/** 品牌（客户方）接口。付款账期 paymentTermDays 直接决定结算单的 dueDate。 */

export function listBrands(query: BrandListQuery = {}): Promise<Paginated<BrandListItem>> {
  // 走 buildParams：level/keyword 为空时不能把空串发给后端（会触发枚举校验失败）
  return api.get<Paginated<BrandListItem>>('/brands', buildParams(query));
}

export function createBrand(body: UpsertBrandRequest): Promise<BrandListItem> {
  return api.post<BrandListItem>('/brands', body);
}

export function updateBrand(id: string, body: Partial<UpsertBrandRequest>): Promise<BrandListItem> {
  return api.patch<BrandListItem>(`/brands/${id}`, body);
}

export function deleteBrand(id: string): Promise<{ id: string; deleted: true }> {
  return api.delete<{ id: string; deleted: true }>(`/brands/${id}`);
}
