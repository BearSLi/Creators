import { api, buildParams } from './client';
import type { DashboardOverview, DashboardQuery } from './types';

/** 经营看板：单接口聚合 KPI 与图表数据，避免首屏十几个请求打爆后端。 */
export function getDashboardOverview(query: DashboardQuery = {}): Promise<DashboardOverview> {
  return api.get<DashboardOverview>('/dashboard/overview', buildParams(query));
}
